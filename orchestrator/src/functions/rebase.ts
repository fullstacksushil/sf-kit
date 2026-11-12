import { cron } from "inngest";
import { inngest } from "../inngest.ts";
import * as docker from "../docker.ts";
import {
  cloneScript, gh, ghToken, issueNumber, owner, prRefusal, promptAgent, pushScript, repo, resetOnFailure, runAgent, setupScript, statusTag,
} from "../run.ts";

// The course's morning rebase (lesson 08-06). Once a night, rebase open PRs that are behind their base, so
// conflicts are solved by morning. A script tries first, with no agent. An agent runs only on a conflict.
// Scope: PRs on agent/* branches, plus any PR labelled agent:rebase (the human route, also for daytime runs).
// A person's own branch is never force-pushed unless they ask with the label.
const MAX_PER_NIGHT = 20; // the speed control: how many PRs one sweep takes

export const rebaseSweep = inngest.createFunction(
  { id: "rebase-sweep", triggers: [cron(process.env.REBASE_CRON ?? "0 0 * * *"), { event: "factory/rebase.sweep" }], singleton: { mode: "skip" }, retries: 0 },
  async ({ step }) => {
    const behind = (await step.run("find-behind-prs", async () => {
      const prs = await gh.paginate(gh.pulls.list, { owner, repo, state: "open", per_page: 100 });
      const out: number[] = [];
      for (const pr of prs) {
        const labels = pr.labels.map((l) => l.name);
        // Skip PRs another run holds or is about to take: a force-push under a review would lose its fixes.
        if (["agent:blocked", "do-not-merge", "agent:in-progress", "agent:review"].some((l) => labels.includes(l)) || prRefusal(pr)) continue;
        if (!pr.head.ref.startsWith("agent/") && !labels.includes("agent:rebase")) continue;
        const { data } = await gh.repos.compareCommits({ owner, repo, base: pr.head.sha, head: pr.base.ref });
        if (data.ahead_by > 0) out.push(pr.number); // the base has commits the PR lacks
        if (out.length >= MAX_PER_NIGHT) break;
      }
      return out;
    })) as number[];
    // One run per PR, each on its own runner: even a script rebase needs the code.
    if (behind.length) await step.sendEvent("rebase-each", behind.map((n) => ({ name: "factory/rebase.requested", data: { prNumber: n } })));
    return { behind };
  },
);

const conflictPrompt = `
A git rebase in this repository stopped on conflicts. Finish it.

- Run git status to see the conflicted files. Resolve each one so that both sides' intent survives. Read the PR's own commits and the base branch's new commits first.
- git add the resolved files, then run: GIT_EDITOR=true git rebase --continue. Repeat until the rebase is done.
- Do not abort the rebase. Do not drop commits. Do not change anything the conflicts do not need.
- Run the project's checks when the rebase is done. If they fail because of the rebase, fix that in a new commit.
- If you cannot resolve a conflict with confidence, run git rebase --abort and write the reason to /tmp/rebase-failed.md.
`;

export const rebasePr = inngest.createFunction(
  {
    id: "rebase-pr",
    triggers: { event: "factory/rebase.requested" },
    singleton: { key: "event.data.prNumber", mode: "skip" },
    retries: 0, // a failed rebase goes to a person, see report-failure
    onFailure: resetOnFailure((d) => d.prNumber as number),
  },
  async ({ event, step, runId }) => {
    const n = issueNumber(event.data.prNumber);
    const pr = (await step.run("read-pr", async () => {
      const { data } = await gh.pulls.get({ owner, repo, pull_number: n });
      await gh.issues.removeLabel({ owner, repo, issue_number: n, name: "agent:rebase" }).catch(() => {});
      const refusal = prRefusal(data);
      if (refusal) {
        await gh.issues.createComment({ owner, repo, issue_number: n, body: `The factory does not rebase this PR: ${refusal}.${statusTag}` });
        return { refusal };
      }
      await gh.issues.addLabels({ owner, repo, issue_number: n, labels: ["agent:in-progress"] });
      return { branch: data.head.ref, base: data.base.ref, sha: data.head.sha };
    })) as { refusal?: string; branch: string; base: string; sha: string };
    if (pr.refusal) return { refused: pr.refusal };

    try {
      await step.run("prepare", () => docker.oneShot(runId, cloneScript(`git checkout -q ${pr.branch}`), ghToken()));
      // No token, and no project code: git only. "conflict" leaves the rebase in progress for the agent.
      const how = ((await step.run("try-rebase", () => docker.oneShot(runId, `
        cd repo
        test "$(git rev-parse HEAD)" = "${pr.sha}" || { echo "The PR moved since it was read."; exit 1; }
        git rev-list --count origin/${pr.base}..HEAD > /tmp/pr-commits
        git diff origin/${pr.base}...HEAD -- .github/workflows .github/actions > /tmp/pr-workflows.diff
        if git -c core.hooksPath=/dev/null rebase -q origin/${pr.base} >/dev/null 2>&1; then echo clean; else echo conflict; fi
      `))) as string).trim().split("\n").pop();

      if (how === "conflict") {
        await step.run("setup", () => docker.oneShot(runId, setupScript));
        await runAgent(step, runId, null,
          `cat > /tmp/rebase-prompt.md <<'SF_PROMPT'\n${conflictPrompt}\nSF_PROMPT\n${promptAgent("/tmp/rebase-prompt.md")}`, `rebase PR #${n}`);
      }
      // No token. The rebase is finished, the tree is clean, and the PR now sits on top of its base.
      await step.run("verify", () => docker.oneShot(runId, `
        cd repo
        [ ! -s /tmp/rebase-failed.md ] || { echo "The agent gave up: $(head -c 500 /tmp/rebase-failed.md)"; exit 1; }
        [ ! -d .git/rebase-merge ] && [ ! -d .git/rebase-apply ] || { echo "The rebase is still in progress."; exit 1; }
        test -z "$(git status --porcelain)" || { echo "The rebase left uncommitted changes."; exit 1; }
        git merge-base --is-ancestor origin/${pr.base} HEAD || { echo "HEAD is not on top of ${pr.base}."; exit 1; }
        # The PR's own commits survived. An agent that reset to the base would leave a clean, empty branch.
        [ "$(git rev-list --count origin/${pr.base}..HEAD)" -ge "$(cat /tmp/pr-commits)" ] || { echo "The rebase dropped commits of the PR."; exit 1; }
        # Conflict markers, only in lines this PR changes, so an old fixture with markers does not block every PR.
        # The PR's own Actions changes may stay. The conflict agent may not add any: a workflow runs with the repo's secrets.
        ${how === "conflict" ? `git diff origin/${pr.base} HEAD -- .github/workflows .github/actions | cmp -s - /tmp/pr-workflows.diff || { echo "The rebase changed GitHub Actions files. A person checks those."; exit 1; }` : ""}
        ${how === "conflict" ? `! git diff origin/${pr.base} HEAD | grep -E '^\\+(<<<<<<<|>>>>>>>)( |$)' >/dev/null || { echo "Conflict markers are left in the PR's changes."; exit 1; }` : ""}
      `));
      // The lease: the push lands only if nobody pushed to the PR since this run read it.
      await step.run("push", () => docker.oneShot(runId, pushScript(pr.branch, { leaseSha: pr.sha }), ghToken()));
      await step.run("report", () => gh.issues.createComment({ owner, repo, issue_number: n,
        body: `Rebased onto \`${pr.base}\`${how === "conflict" ? ", with conflicts resolved by an agent. Read the new commits" : " by script, no agent"}.${statusTag}` }));
      return { how };
    } catch (err) {
      // The lesson's human route: the PR is labelled blocked and a ticket says why. The sweep skips blocked PRs.
      await step.run("report-failure", async () => {
        await gh.issues.addLabels({ owner, repo, issue_number: n, labels: ["agent:blocked"] });
        const { data: issue } = await gh.issues.create({ owner, repo, title: `Rebase of PR #${n} needs a person`,
          body: `The nightly rebase of #${n} onto \`${pr.base}\` failed: ${(err as Error).message}\n\nRebase it by hand, or close the PR if work on \`${pr.base}\` superseded it. Then remove \`agent:blocked\` from #${n}.${statusTag}` });
        await gh.issues.createComment({ owner, repo, issue_number: n, body: `Rebase failed. See #${issue.number}.${statusTag}` });
      });
      throw err;
    } finally {
      await step.run("cleanup", async () => {
        await gh.issues.removeLabel({ owner, repo, issue_number: n, name: "agent:in-progress" }).catch(() => {});
        await docker.cleanup(runId);
      });
    }
  },
);
