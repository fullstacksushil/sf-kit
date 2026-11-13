import { NonRetriableError } from "inngest";
import { inngest, ev } from "../inngest.ts";
import * as docker from "../docker.ts";
import { agentFiles, cloneScript, gh, ghToken, issueCheckFn, issueNumber, owner, parentSpecScript, pushCommits, repo, prRefusal, resetOnFailure, runAgent, safeRef, statusTag } from "../run.ts";

// The spec is whatever issue the PR body says it closes, the same rule as the course's review workflow.
const specScript = (pr: number) => `
  gh pr view ${pr} --repo ${owner}/${repo} --json body --jq .body > /tmp/pr-body.md
  issue=$(grep -oiE '(closes|fixes|resolves) #[0-9]+' /tmp/pr-body.md | head -n1 | grep -oE '[0-9]+' || true)
  ${issueCheckFn}
  if [ -n "$issue" ]; then
    gh issue view "$issue" --repo ${owner}/${repo} --json number,title,body \\
      --jq '"# Ticket #" + (.number|tostring) + ": " + .title + "\\n\\n" + .body' > /tmp/review-spec.md
    # Read first, then check. A collaborator's PR may fix a stranger's bug report. Then the review goes on without that text.
    if sf_issue_ok "$issue"; then ${parentSpecScript('"$issue"', "/tmp/review-spec.md")}
    else echo "No spec available: someone outside the repo wrote or changed #$issue, so the factory does not read it." > /tmp/review-spec.md; fi
  else
    echo "No spec available: this PR does not say which ticket it closes." > /tmp/review-spec.md
  fi
`;

export const reviewPr = inngest.createFunction(
  {
    id: "review-pr",
    triggers: { event: ev("review.requested") },
    singleton: { key: "event.data.prNumber", mode: "skip" }, // one active run per PR
    retries: 1,
    onFailure: resetOnFailure((d) => d.prNumber as number),
  },
  async ({ event, step, runId }) => {
    const n = issueNumber(event.data.prNumber);

    const pr = (await step.run("read-pr", async () => {
      const { data } = await gh.pulls.get({ owner, repo, pull_number: n });
      await gh.issues.removeLabel({ owner, repo, issue_number: n, name: "agent:review" }).catch(() => {});
      const refusal = prRefusal(data);
      if (refusal) {
        await gh.issues.addLabels({ owner, repo, issue_number: n, labels: ["agent:blocked"] });
        await gh.issues.createComment({ owner, repo, issue_number: n, body: `The factory does not review this PR: ${refusal}.${statusTag}` });
        return { refusal };
      }
      await gh.issues.addLabels({ owner, repo, issue_number: n, labels: ["agent:in-progress"] });
      return { branch: safeRef(data.head.ref), base: safeRef(data.base.ref) };
    })) as { refusal?: string; branch: string; base: string };
    if (pr.refusal) return { refused: pr.refusal };

    try {
      // review.ts reads BASE_REF, PR_NUMBER and BRANCH. They are not secrets, so they go in the script.
      await runAgent(
        step,
        runId,
        specScript(n) + cloneScript(`git checkout ${pr.branch}`),
        `BASE_REF=${pr.base} PR_NUMBER=${n} BRANCH=${pr.branch} OUTPUT_DIR=/tmp npx tsx .sandcastle/agent-workflows/review/review.ts`,
        `review PR #${n}`,
      );

      // The reviewer may commit fixes. pushCommits pushes them, or does nothing when there are none.
      await pushCommits(step, runId, pr.branch, { base: pr.branch });

      // Each post is its own step, so a retry never posts a comment twice.
      // Read without the token first: a missing verdict, or a fallback note without the course's
      // "## Standards:" heading, keeps the PR a draft.
      const verdict = ((await step.run("read-verdict", () => docker.oneShot(runId, `${agentFiles}
        if ! agent_file /tmp/review-verdict.md; then echo none
        elif grep -q '## Standards:' /tmp/review-verdict.md; then echo full
        else echo note; fi
      `))) as string).trim().split("\n").pop();
      if (verdict === "none") throw new NonRetriableError("The review produced no verdict.");

      await step.run("post-verdict", () => docker.oneShot(runId, `
        cd /${agentFiles}
        gh pr comment ${n} --repo ${owner}/${repo} --body-file /tmp/review-verdict.md "\${attach[@]}"
      `, ghToken()));
      // The inline comments, as one review. The token step builds the body itself: the agent controls the file,
      // and a raw body could approve or request changes. review.ts dropped any comment outside the diff,
      // because GitHub rejects the whole review for one bad line.
      await step.run("post-inline", () => docker.oneShot(runId, `
        cd /${agentFiles}
        agent_file /tmp/review-comments.json || exit 0
        # GitHub needs a body for a COMMENT review.
        jq '{event: "COMMENT", body: "Inline notes from the factory review. The verdict is in the comment above.", comments: [(.comments // [])[]
          | {path, line, side, start_line, start_side, body} | with_entries(select(.value != null))]}' \\
          /tmp/review-comments.json > "$HOME/review.json"
        [ "$(jq '.comments | length' "$HOME/review.json")" -gt 0 ] || exit 0
        gh api --method POST repos/${owner}/${repo}/pulls/${n}/reviews --input "$HOME/review.json" --silent
      `, ghToken()));
      if (verdict !== "full") throw new NonRetriableError("The review produced no verdict (no ## Standards: heading). The PR stays a draft.");
      await step.run("mark-ready", () => docker.oneShot(runId, `cd / && gh pr ready ${n} --repo ${owner}/${repo}`, ghToken()));
    } catch (err) {
      await step.run("report-failure", async () => {
        await gh.issues.addLabels({ owner, repo, issue_number: n, labels: ["agent:blocked"] });
        await gh.issues.createComment({
          owner, repo, issue_number: n,
          body: `Review run failed: ${(err as Error).message} Re-add \`agent:review\` to retry.${statusTag}`,
        });
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
