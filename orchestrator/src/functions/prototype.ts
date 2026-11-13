import { inngest, ev } from "../inngest.ts";
import * as docker from "../docker.ts";
import {
  agentFiles, cloneScript, gh, ghToken, issueNumber, owner, promptAgent, pushCommits, repo, resetOnFailure, runAgent, statusTag, ticketScript,
} from "../run.ts";

// The course's prototype task (lesson 08-08). A throwaway prototype that people react to, not production code.
// Triggers: the label agent:prototype (from a human, or explore's "prototype-needed" verdict), or a collaborator's
// comment with "@factory" on an issue labelled `prototype`. The comment thread is the conversation history.
// Output: a draft PR labelled do-not-merge on prototype/issue-<n>, and a comment on the issue with screenshots.
export const PROTOTYPE_MENTION = "@factory";

const prompt = (n: number) => `
You build a throwaway prototype, so people can react to how something looks or behaves.

- The request is /tmp/ticket.md: the issue, then the comments. The newest comment that mentions ${PROTOTYPE_MENTION} is the latest feedback. Act on it.
- Put every file under prototypes/issue-${n}/. Do not change any other file. If that folder exists, update the prototype; do not start again.
- Keep it rough and cheap. Fake data is fine. It only has to answer the question in the issue.
- prototypes/issue-${n}/README.md says in one command how to run it.
- Run it and take a screenshot of each screen or state with agent-browser. Save them as /tmp/evidence/<n>-<name>.png. Close the browser.
- Write /tmp/prototype-summary.md: what this version shows, what changed since the last one, and the open questions for the reader. Reference each screenshot by its absolute path, for example ![list](/tmp/evidence/1-list.png).
- Commit all changes with the message "prototype #${n}: <one line>".
`;

export const prototypeIssue = inngest.createFunction(
  {
    id: "prototype-issue",
    triggers: { event: ev("prototype.requested") },
    // One version at a time per issue. Feedback that lands during a run starts the next one (see "requeue").
    singleton: { key: "event.data.issueNumber", mode: "skip" },
    retries: 1,
    onFailure: resetOnFailure((d) => d.issueNumber as number),
  },
  async ({ event, step, runId }) => {
    const n = issueNumber(event.data.issueNumber);
    const branch = `prototype/issue-${n}`;

    const seen = (await step.run("mark-in-progress", async () => {
      await gh.issues.removeLabel({ owner, repo, issue_number: n, name: "agent:prototype" }).catch(() => {});
      await gh.issues.removeLabel({ owner, repo, issue_number: n, name: "agent:blocked" }).catch(() => {});
      await gh.issues.addLabels({ owner, repo, issue_number: n, labels: ["agent:in-progress", "prototype"] });
      return latestMention(n);
    })) as number;

    try {
      // An existing prototype branch is updated, so each version builds on the last.
      await runAgent(step, runId,
        ticketScript(n) + cloneScript(`
          if git rev-parse -q --verify origin/${branch} >/dev/null; then git checkout -q -B ${branch} origin/${branch}
          else git checkout -q -b ${branch}; fi`),
        `cat > /tmp/prototype-prompt.md <<'SF_PROMPT'\n${prompt(n)}\nSF_PROMPT\n${promptAgent("/tmp/prototype-prompt.md")}`,
        `prototype #${n}`,
      );
      if (!(await pushCommits(step, runId, branch, { base: "HEAD" }))) throw new Error("The agent made no commits.");

      // From /, never inside the agent's repo, while the token is present.
      const prUrl = ((await step.run("open-or-update-pr", () => docker.oneShot(runId, `
        cd /
        url=$(gh pr list --repo ${owner}/${repo} --head ${branch} --state open --json url --jq '.[0].url // empty')
        if [ -z "$url" ]; then
          printf 'A throwaway prototype for #${n}. **Do not merge.** It is a detailed spec to react to, not production code.\\n' > "$HOME/pr.md"
          url=$(gh pr create --repo ${owner}/${repo} --draft --head ${branch} --label do-not-merge --label prototype \\
            --title "Prototype: $(gh issue view ${n} --repo ${owner}/${repo} --json title --jq .title)" --body-file "$HOME/pr.md")
        fi
        echo "$url"
      `, ghToken()))) as string).trim().split("\n").pop()!;

      // The link goes on the issue only once the prototype exists (lesson 08-08).
      await step.run("post-on-issue", () => docker.oneShot(runId, `
        cd /${agentFiles}
        { agent_file /tmp/prototype-summary.md && cat /tmp/prototype-summary.md || echo "A new version of the prototype is ready."
          printf '\\n\\n---\\nCode: ${prUrl} (draft, do not merge). Run it: see prototypes/issue-${n}/README.md on that branch.\\n'
          printf 'Reply with **${PROTOTYPE_MENTION}** and your feedback to get the next version.\\n${FACTORY_MARK}\\n'; } > "$HOME/comment.md"
        gh issue comment ${n} --repo ${owner}/${repo} --body-file "$HOME/comment.md" "\${attach[@]}"
      `, ghToken()));

      // Feedback that arrived while this version was built was skipped by the singleton. Start the next version.
      // Sent now, the event would meet this run's singleton and be skipped. prototypeRequeue sends it a minute later.
      // A future `ts` does not delay a run: probed on 2026-11-12, Inngest published it at once and the singleton skipped it.
      await step.run("requeue", async () => {
        if ((await latestMention(n)) > seen) await inngest.send({ name: ev("prototype.requeue"), data: { issueNumber: n } });
      });
      return { prUrl };
    } catch (err) {
      await step.run("report-failure", async () => {
        await gh.issues.addLabels({ owner, repo, issue_number: n, labels: ["agent:blocked"] });
        await gh.issues.createComment({ owner, repo, issue_number: n, body: `Prototype run failed: ${(err as Error).message} Add \`agent:prototype\` to retry.${statusTag}` });
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

/** Starts the next prototype version after the current run has ended. A step.sleep relay, probed on 2026-11-12. */
export const prototypeRequeue = inngest.createFunction(
  { id: "prototype-requeue", triggers: { event: ev("prototype.requeue") }, retries: 1 },
  async ({ event, step }) => {
    const n = issueNumber(event.data.issueNumber);
    await step.sleep("let-the-run-end", "1m");
    await step.sendEvent("next-version", { name: ev("prototype.requested"), data: { issueNumber: n } });
  },
);

const TRUSTED = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
// The factory's comments carry this. FACTORY_PAT is often the owner's own token, so the author can't tell them apart.
const FACTORY_MARK = "<!-- factory:prototype -->";
/** A collaborator's comment, not the factory's own, that asks for a new version. */
export const isPrototypeMention = (c: { body?: string | null; author_association?: string }) =>
  TRUSTED.has(c.author_association ?? "") && (c.body ?? "").includes(PROTOTYPE_MENTION) && !/<!-- factory:/.test(c.body ?? "");

/** The id of the newest collaborator comment that mentions the factory, or 0. */
async function latestMention(n: number): Promise<number> {
  const comments = await gh.paginate(gh.issues.listComments, { owner, repo, issue_number: n, per_page: 100 });
  return Math.max(0, ...comments.filter(isPrototypeMention).map((c) => c.id));
}

/**
 * Feedback no version answered yet: the newest mention's id when it is newer than the factory's newest
 * prototype comment, else 0. Level-based, so feedback posted while the orchestrator was down still counts.
 */
export async function pendingFeedback(n: number): Promise<number> {
  const comments = await gh.paginate(gh.issues.listComments, { owner, repo, issue_number: n, per_page: 100 });
  const answered = Math.max(0, ...comments.filter((c) => (c.body ?? "").includes(FACTORY_MARK)).map((c) => c.id));
  const asked = Math.max(0, ...comments.filter(isPrototypeMention).map((c) => c.id));
  return asked > answered ? asked : 0;
}
