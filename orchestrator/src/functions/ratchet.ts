import { cron } from "inngest";
import { inngest, ev } from "../inngest.ts";
import * as docker from "../docker.ts";
import { cloneScript, gh, ghToken, owner, pushCommits, repo, runAgent, setupScript } from "../run.ts";

// The course's lint ratchet (lesson 08-05): fix ONE failing instance per run, as a PR for a human.
// The project owns two npm scripts:
//   ratchet:list   prints one failing instance per line, the same text on every run. Empty = done.
//                  It exits 0 whenever it ran, also while failures exist. Non-zero means the list itself broke.
//   ratchet:fix    optional. Gets the instance as its argument. The deterministic try before an agent.
const MAX_OPEN = Number(process.env.RATCHET_MAX_OPEN ?? 5);
const LABEL = "ratchet";
const title = (instance: string) => `ratchet: ${instance}`.slice(0, 200);

// No token: ratchet:list is project code. Pick the first failure that no open ratchet PR already fixes.
// PR titles are cut at 200 characters (title()), so compare the cut form.
const pickScript = (taken: string[]) => `
  cd repo
  npm run --silent ratchet:list > /tmp/ratchet-all.txt
  printf '%s\\n' ${taken.map((t) => `'${t.replace(/'/g, `'\\''`)}'`).join(" ")} > /tmp/ratchet-taken.txt
  awk 'NR==FNR { taken[$0]=1; next } NF && !(substr("ratchet: " $0, 1, 200) in taken) { print; exit }' \\
    /tmp/ratchet-taken.txt /tmp/ratchet-all.txt > /tmp/ratchet-target.txt
  cat /tmp/ratchet-target.txt
`;

// A broken ratchet:list (for example, an agent that broke the lint config) fails the step, so it never counts as a fix.
const stillFails = `{ npm run --silent ratchet:list > /tmp/ratchet-after.txt || { echo "ratchet:list failed"; exit 1; }; grep -qxF -f /tmp/ratchet-target.txt /tmp/ratchet-after.txt; }`;

// Deterministic first. Prints "fixed" when ratchet:fix alone removed the failure.
const fixScript = `
  cd repo
  npm run --if-present ratchet:fix -- "$(cat /tmp/ratchet-target.txt)" || true
  if ${stillFails}; then git checkout -- . && git clean -fdq; echo agent
  else git add -A && git commit -qm "$(sed 's/^/ratchet: /' /tmp/ratchet-target.txt)" && echo fixed; fi
`;

// The container is the sandbox: no tokens, no LAN, a fixed CPU and memory share.
const agentScript = `
  {
    echo "Fix exactly one lint failure, then stop:"
    echo; cat /tmp/ratchet-target.txt; echo
    echo "Read CODING_STANDARDS.md first. Do not disable, weaken or skip the rule. Do not fix any other failure."
    echo "Run the project's checks. Then commit all changes with the message: ratchet: <the failure above>."
  } > /tmp/ratchet-task.md
  claude -p "$(cat /tmp/ratchet-task.md)" --dangerously-skip-permissions
`;

export const lintRatchet = inngest.createFunction(
  {
    id: "lint-ratchet",
    // The cron, plus an event for a manual run or a "PR merged, go again" trigger.
    triggers: [cron(process.env.RATCHET_CRON ?? "0 6 * * 1-5"), { event: ev("ratchet.requested") }],
    singleton: { mode: "skip" },
    retries: 0,
    onFailure: async ({ event }) => docker.cleanup(event.data.run_id),
  },
  async ({ step, runId }) => {
    const branch = `agent/ratchet-${runId}`;
    const taken = (await step.run("open-ratchet-prs", async () => {
      const prs = await gh.paginate(gh.issues.listForRepo, { owner, repo, state: "open", labels: LABEL, per_page: 100 });
      return prs.filter((p) => p.pull_request).map((p) => p.title);
    })) as string[];
    // The brake on unreviewed work: stop when humans fall behind.
    if (taken.length >= MAX_OPEN) return { skipped: `${taken.length} open ratchet PRs (limit ${MAX_OPEN})` };

    try {
      await step.run("prepare", () => docker.oneShot(runId, cloneScript(`git checkout -b ${branch}`), ghToken()));
      await step.run("setup", () => docker.oneShot(runId, setupScript));
      const target = ((await step.run("pick", () => docker.oneShot(runId, pickScript(taken)))) as string).trim();
      if (!target) return { skipped: "no failing instance left that no open PR covers" };

      const how = ((await step.run("deterministic-fix", () => docker.oneShot(runId, fixScript))) as string).trim().split("\n").pop();
      if (how !== "fixed") {
        await runAgent(step, runId, null, agentScript, `ratchet ${target}`);
        await step.run("verify", () => docker.oneShot(runId, `cd repo && if ${stillFails}; then echo "Still failing: $(cat /tmp/ratchet-target.txt)"; exit 1; fi`));
      }

      if (!(await pushCommits(step, runId, branch, { base: "HEAD" }))) throw new Error("The fix made no commit.");
      const pr = await step.run("open-pr", async () => {
        const { data } = await gh.pulls.create({
          owner, repo, head: branch, base: (await gh.repos.get({ owner, repo })).data.default_branch, title: title(target),
          body: `## Summary\n\nFixes one instance of a lint failure.\n\n## Evidence\n\n- Before: \`npm run ratchet:list\` printed \`${target}\`.\n- After: it does not.\n- Fixed by: ${how === "fixed" ? "`ratchet:fix` (no agent)" : "the agent"}.\n\n## Merge Danger\n\nTwo-way door. Blast radius: the files in this diff.\n\n---\nInngest run ${runId}.`,
        });
        await gh.issues.addLabels({ owner, repo, issue_number: data.number, labels: [LABEL] });
        return data.html_url;
      });
      return { target, how, pr };
    } finally {
      await step.run("cleanup", () => docker.cleanup(runId));
    }
  },
);
