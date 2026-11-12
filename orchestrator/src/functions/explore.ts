import { inngest } from "../inngest.ts";
import * as docker from "../docker.ts";
import { cloneScript, gh, ghToken, owner, repo, runAgent, statusTag } from "../run.ts";

// The course's agent-explore.yml as one Inngest function. The agent reads every open
// `agent:explore` issue as one batch and returns a plan. It holds no GitHub token.
// This function checks the plan, then writes the comments and labels with the PAT.

type Entry = { number: number; tag: string; duplicate_of?: number; comment: string };

// The branch on the agent's verdict. "prototype-needed" is the third verdict from lesson 08-08. The course's
// plan-schema.ts allows only the first three, so add it to the enum there (and say when to use it in prompt.md).
const NEXT_LABEL: Record<string, string> = {
  "easy-call": "agent:implement", "needs-a-human": "needs-a-human", blocked: "needs-a-human", "prototype-needed": "agent:prototype",
};

// Titles, bodies and collaborator comments go into a file. They never pass through the shell.
const listScript = `
  mkdir -p /tmp/explore
  gh issue list --repo ${owner}/${repo} --state open --label agent:explore --limit 100 \\
    --json number,title,body,createdAt,comments \\
    | jq 'map(.comments |= map(select((.authorAssociation | IN("OWNER","MEMBER","COLLABORATOR"))
          and (.body | contains("<!-- factory:status -->") | not))))' > /tmp/explore/issues.json
  jq -c '[.[].number] | sort' /tmp/explore/issues.json
`;
const hasLabel = (labels: (string | { name?: string })[], name: string) => labels.some((l) => (typeof l === "string" ? l : l.name) === name);

/** The apply job's checks from the course workflow. An empty list means the plan is safe to apply. */
export function planProblems(plan: { issues?: Entry[] }, batch: number[]): string[] {
  const issues = plan.issues ?? [];
  const out: string[] = [];
  const got = issues.map((e) => e.number).sort((a, b) => a - b);
  if (JSON.stringify(got) !== JSON.stringify(batch)) out.push(`The plan needs exactly one entry for each of ${JSON.stringify(batch)}.`);
  for (const e of issues) {
    if (!Object.keys(NEXT_LABEL).includes(e.tag)) out.push(`#${e.number} has an unknown tag: ${e.tag}.`);
    if (!/\S/.test(e.comment ?? "")) out.push(`#${e.number} has an empty comment.`);
    if (e.duplicate_of != null && !issues.some((s) => s.number === e.duplicate_of && s.duplicate_of == null))
      out.push(`#${e.number} is a duplicate of #${e.duplicate_of}, which is not a surviving issue in this batch.`);
  }
  return out;
}

export const exploreBatch = inngest.createFunction(
  {
    id: "explore-batch",
    triggers: { event: "factory/explore.requested" },
    // Labels often land several at once. Wait for the burst to end, then run once (the course's `sleep 5`).
    debounce: { period: "15s" },
    retries: 0, // the batch labels are already swapped, so a blind retry would explore an empty batch
    // If the body could not clean up (for example, a restart during failure), at least remove the containers.
    onFailure: async ({ event }) => docker.cleanup(event.data.run_id),
  },
  async ({ step, runId }) => {
    let batch: number[] = [];
    const applied = new Set<number>(); // issues apply has handed on. Steps replay on resume, so this is rebuilt each time.
    try {
      batch = JSON.parse((await step.run("list-batch", () => docker.oneShot(runId, listScript, ghToken()))) as string) as number[];
      if (batch.length === 0) return { batch };
      // agent:explore off, agent:in-progress on, so a second run sees a disjoint batch. A failure here is
      // reported below: every issue already claimed gets agent:blocked and a comment.
      await step.run("claim-batch", async () => {
        for (const n of batch) {
          for (const name of ["agent:explore", "agent:blocked"]) await gh.issues.removeLabel({ owner, repo, issue_number: n, name }).catch(() => {});
          await gh.issues.addLabels({ owner, repo, issue_number: n, labels: ["agent:in-progress"] });
        }
      });

      await runAgent(step, runId, cloneScript(""), "npx tsx .sandcastle/agent-workflows/explore/explore.ts", `explore ${batch.map((n) => `#${n}`).join(" ")}`);

      const plan = JSON.parse((await step.run("read-plan", () => docker.oneShot(runId, "cat /tmp/plan.json"))) as string);
      const problems = planProblems(plan, batch);
      if (problems.length) throw new Error(`Refused the plan, nothing was written: ${problems.join(" ")}`);

      // Survivors first, so "duplicate of #N" points at an issue that already has its findings.
      const entries = (plan.issues as Entry[]).sort((a, b) => Number(a.duplicate_of != null) - Number(b.duplicate_of != null) || a.number - b.number);
      for (const e of entries) {
        await step.run(`apply-${e.number}`, async () => {
          const next = e.duplicate_of != null ? `Closed as duplicate of #${e.duplicate_of}.`
            : e.tag === "easy-call" ? "Easy call. Handed to the implementer. Nobody is being asked first."
            : e.tag === "prototype-needed" ? "Needs a prototype first. Handed to the prototype task. Reply with @factory to steer it."
            : `Stopped at \`${e.tag}\`. Settle the open questions, then label \`agent:implement\` yourself.`;
          // Not tagged factory:status: the implementer needs to read these findings. The marker stops the footer's
          // "@factory" from counting as prototype feedback.
          await gh.issues.createComment({ owner, repo, issue_number: e.number, body: `${e.comment}\n\n---\n\n_${next}_ Inngest run ${runId}.\n<!-- factory:findings -->` });
          await gh.issues.removeLabel({ owner, repo, issue_number: e.number, name: "agent:in-progress" }).catch(() => {});
          if (e.duplicate_of != null) await gh.issues.update({ owner, repo, issue_number: e.number, state: "closed", state_reason: "duplicate" });
          // A label added with the PAT fires the webhook, which starts implement-ticket. That is the chain.
          else await gh.issues.addLabels({ owner, repo, issue_number: e.number, labels: [NEXT_LABEL[e.tag]] });
        });
        applied.add(e.number);
      }
      return { batch, tags: Object.fromEntries(entries.map((e) => [e.number, e.duplicate_of ? `duplicate of #${e.duplicate_of}` : e.tag])) };
    } catch (err) {
      await step.run("report-failure", async () => {
        for (const n of batch) {
          // Only issues explore still holds. Ones apply already handed on may belong to implement now.
          if (applied.has(n)) continue;
          const { data } = await gh.issues.get({ owner, repo, issue_number: n });
          if (!hasLabel(data.labels, "agent:in-progress")) continue;
          await gh.issues.removeLabel({ owner, repo, issue_number: n, name: "agent:in-progress" }).catch(() => {});
          await gh.issues.addLabels({ owner, repo, issue_number: n, labels: ["agent:blocked"] });
          await gh.issues.createComment({ owner, repo, issue_number: n, body: `Explore run failed: ${(err as Error).message} Re-add \`agent:explore\` to retry.${statusTag}` });
        }
      });
      throw err;
    } finally {
      // Labels are not touched here: apply moved each issue on, and implement may already hold agent:in-progress.
      await step.run("cleanup", () => docker.cleanup(runId));
    }
  },
);
