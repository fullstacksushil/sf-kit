import { cron } from "inngest";
import { inngest, ev } from "../inngest.ts";
import * as docker from "../docker.ts";
import { cloneScript, gh, ghToken, owner, promptAgent, repo, runAgent } from "../run.ts";

// The course's architecture loop (lesson 08-04, first design): every two days a runner runs the
// improve-codebase-architecture analysis, and each candidate becomes one ticket labelled `architecture`.
// A human reviews each ticket and labels it (for example agent:explore) to send it into the factory.
// The label is also the memory: earlier tickets, open or closed, are never proposed again.
const LABEL = "architecture";
const STOP_AT = 20; // the stop condition: humans are this far behind
const PER_RUN = 5;

const prompt = `
This run is unattended. Use the improve-codebase-architecture skill's Explore step (and the codebase-design
vocabulary) to find deepening opportunities in this repository. Skip its HTML report and its questions:
nobody is here to answer them.

/tmp/arch-existing.json lists the candidates already proposed, open or closed. Do not propose any of them again,
not even reworded.

Write /tmp/candidates.json with this shape, strongest first, at most ${PER_RUN} candidates:
{"candidates": [{"title": "<the module to deepen, in GLOSSARY.md words, under 100 characters>",
  "strength": "Strong" | "Worth exploring" | "Speculative",
  "body": "<Markdown: ## Files, ## Problem, ## Solution, ## Benefits (locality, leverage, how tests improve), ## Deletion test>"}]}
Write nothing else and change no file in the repository.
`;

type Candidate = { title: string; strength: string; body: string };

export const architectureReview = inngest.createFunction(
  {
    id: "architecture-review",
    triggers: [cron(process.env.ARCHITECTURE_CRON ?? "0 3 */2 * *"), { event: ev("architecture.requested") }],
    singleton: { mode: "skip" },
    retries: 0,
    onFailure: async ({ event }) => docker.cleanup(event.data.run_id),
  },
  async ({ step, runId }) => {
    const open = (await step.run("count-open", async () =>
      (await gh.paginate(gh.issues.listForRepo, { owner, repo, state: "open", labels: LABEL, per_page: 100 })).filter((i) => !i.pull_request).length)) as number;
    if (open >= STOP_AT) return { skipped: `${open} open ${LABEL} tickets (limit ${STOP_AT})` };

    try {
      await runAgent(step, runId,
        `gh issue list --repo ${owner}/${repo} --label ${LABEL} --state all --limit 500 --json title,state > /tmp/arch-existing.json\n` + cloneScript(""),
        `cat > /tmp/arch-prompt.md <<'SF_PROMPT'\n${prompt}\nSF_PROMPT\n${promptAgent("/tmp/arch-prompt.md")}`,
        "architecture review");

      const raw = (await step.run("read-candidates", () => docker.oneShot(runId, "cat /tmp/candidates.json"))) as string;
      const created = (await step.run("file-tickets", async () => {
        const known = new Set((await gh.paginate(gh.issues.listForRepo, { owner, repo, state: "all", labels: LABEL, per_page: 100 }))
          .map((i) => i.title.trim().toLowerCase()));
        const out: number[] = [];
        for (const c of strongCandidates(JSON.parse(raw)).slice(0, Math.min(PER_RUN, STOP_AT - open))) {
          if (known.has(c.title.trim().toLowerCase())) continue;
          const { data } = await gh.issues.create({ owner, repo, title: c.title.trim().slice(0, 120), labels: [LABEL],
            body: `${c.body}\n\n---\n_Strength: ${c.strength}. Proposed by the architecture review (Inngest run ${runId})._\n_Label \`agent:explore\` to send it into the factory, or close it to reject it. Either way it is not proposed again._` });
          out.push(data.number);
        }
        return out;
      })) as number[];
      return { created };
    } finally {
      await step.run("cleanup", () => docker.cleanup(runId));
    }
  },
);

/** Well-formed candidates the course would ticket: Strong and Worth exploring. Speculative ones are dropped. */
export function strongCandidates(json: unknown): Candidate[] {
  const list = (json as { candidates?: unknown })?.candidates;
  if (!Array.isArray(list)) throw new Error("candidates.json has no candidates array.");
  return list.filter((c): c is Candidate =>
    typeof c?.title === "string" && c.title.trim() !== "" && typeof c?.body === "string" && c.body.trim() !== ""
    && ["Strong", "Worth exploring"].includes(c?.strength));
}
