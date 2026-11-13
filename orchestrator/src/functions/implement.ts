import { inngest, ev } from "../inngest.ts";
import * as docker from "../docker.ts";
import { agentFiles, cloneScript, gh, ghToken, issueNumber, owner, openFactoryPr, pushCommits, repo, resetOnFailure, runAgent, statusTag, ticketScript } from "../run.ts";

export const implementTicket = inngest.createFunction(
  {
    id: "implement-ticket",
    triggers: { event: ev("implement.requested") },
    // One active run per ticket. A label added during a run is skipped, so re-add it after.
    // Not `concurrency`: it counts executing steps, and a run waiting on step.sleep holds no slot.
    singleton: { key: "event.data.issueNumber", mode: "skip" },
    retries: 1,
    onFailure: resetOnFailure((d) => d.issueNumber as number),
  },
  async ({ event, step, runId }) => {
    const n = issueNumber(event.data.issueNumber);
    const branch = `agent/issue-${n}-${runId}`;

    // A second run for a ticket that already has an open factory PR would open a second PR. The poller starts one
    // when the label is added during a run: the singleton skips that event, the label stays, and the next poll sends it again.
    // ponytail: reads the first 100 open PRs. Page through them when a repo holds more.
    const open = await step.run("check-open-pr", async () => {
      const pr = openFactoryPr((await gh.pulls.list({ owner, repo, state: "open", per_page: 100 })).data, n);
      if (!pr) return null;
      await gh.issues.removeLabel({ owner, repo, issue_number: n, name: "agent:implement" }).catch(() => {});
      await gh.issues.createComment({ owner, repo, issue_number: n,
        body: `Not started: PR #${pr.number} is open for this ticket. Close it to build again, or label the PR \`agent:review\` or \`agent:rebase\`.${statusTag}` });
      return pr.number;
    });
    if (open) return { skipped: `PR #${open} is open` };

    await step.run("mark-in-progress", async () => {
      await gh.issues.removeLabel({ owner, repo, issue_number: n, name: "agent:implement" }).catch(() => {});
      await gh.issues.removeLabel({ owner, repo, issue_number: n, name: "agent:blocked" }).catch(() => {});
      await gh.issues.addLabels({ owner, repo, issue_number: n, labels: ["agent:in-progress"] });
    });

    try {
      await runAgent(
        step,
        runId,
        ticketScript(n) + cloneScript(`git checkout -b ${branch}`),
        "npx tsx .sandcastle/agent-workflows/implement/implement.ts",
        `implement #${n}`,
      );

      if (!(await pushCommits(step, runId, branch, { base: "HEAD" }))) throw new Error("The agent made no commits.");

      // In a container so `gh --attach` can upload the agent's /tmp/evidence screenshots. It runs from /,
      // not the agent's repo, so no agent-written git config runs while the token is present.
      // A retry finds the PR it already opened instead of failing on "already exists".
      const prUrl = (await step.run("open-draft-pr", () =>
        docker.oneShot(runId, `
          cd /${agentFiles}
          existing=$(gh pr list --repo ${owner}/${repo} --head ${branch} --state open --json url --jq '.[0].url // empty')
          if [ -n "$existing" ]; then echo "$existing"; exit 0; fi
          { agent_file /tmp/pr-body.md && cat /tmp/pr-body.md || echo "Built by the factory."
            printf '\\n\\n---\\nCloses #${n}. Built unattended by Inngest run ${runId}.\\n'; } > "$HOME/body.md"
          gh pr create --repo ${owner}/${repo} --draft --head ${branch} \\
            --title "$(gh issue view ${n} --repo ${owner}/${repo} --json title --jq .title)" \\
            --body-file "$HOME/body.md" "\${attach[@]}"
        `, ghToken()),
      )) as string;

      await step.run("hand-to-review", async () => {
        const prNumber = Number(prUrl.trim().split("/").pop());
        await gh.issues.addLabels({ owner, repo, issue_number: prNumber, labels: ["agent:review"] });
        await gh.issues.createComment({ owner, repo, issue_number: n, body: `Implementer run succeeded. Draft PR: ${prUrl.trim()}${statusTag}` });
      });
    } catch (err) {
      await step.run("report-failure", async () => {
        await gh.issues.addLabels({ owner, repo, issue_number: n, labels: ["agent:blocked"] });
        await gh.issues.createComment({
          owner, repo, issue_number: n,
          body: `Implementer run failed: ${(err as Error).message} Re-add \`agent:implement\` to retry.${statusTag}`,
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
