import { NonRetriableError } from "inngest";
import { inngest } from "../inngest.ts";
import * as docker from "../docker.ts";
import {
  agentFiles, blockersFromBody, cloneScript, gh, ghToken, issueNumber, owner, promptAgent, publishFileScript, pushCommits, pushScript, repo,
  noWorkflowChanges, resetOnFailure, runAgent, setupScript, SLOTS, specFileScript, statusTag, ticketScript,
} from "../run.ts";

// The course's implement-spec as lesson 09's design two, the "night shift": a spec labelled
// agent:implement-spec is built ticket by ticket, without a human, into one integration branch.
//
//   1. No tickets yet: the course's decompose.ts writes a queue, and it becomes sub-issues with blocking edges.
//   2. An exploration run writes notes to the branch spec/<n>-notes. Every ticket run reads them.
//   3. Waves: each frontier ticket is built on its own runner, from spec/<n>, on spec/<n>-t<ticket>.
//      Then a merge step joins each into spec/<n>. A script merges first. An agent runs only on a conflict.
//   4. When every ticket is closed, one PR spec/<n> -> main goes to review, then to a human.
//
// A failed ticket is labelled agent:blocked. Waves continue around it, and the spec stops when nothing else can start.
// Remove agent:blocked from the ticket and re-add agent:implement-spec on the spec to resume.

type Ticket = { number: number; title: string; open: boolean; parked: boolean; blockers: number[] };
const MAX_WAVES = 100;

/** The spec's tickets: its sub-issues, with blockers from the body section and GitHub's native edges. */
async function listTickets(spec: number): Promise<Ticket[]> {
  const subs = await gh.paginate("GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues", { owner, repo, issue_number: spec, per_page: 100 }) as
    { number: number; title: string; state: string; body?: string | null; labels: ({ name?: string } | string)[] }[];
  return Promise.all(subs.map(async (i) => {
    const native = await gh.request("GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by", { owner, repo, issue_number: i.number })
      // 404: the repo has no dependencies feature. Any other error stops the survey: a missed edge builds a blocked ticket.
      .then((r) => (r.data as { number: number }[]).map((b) => b.number), (e: { status?: number }) => { if (e.status === 404) return [] as number[]; throw e; });
    return {
      number: i.number, title: i.title, open: i.state === "open",
      parked: i.labels.some((l) => (typeof l === "string" ? l : l.name) === "agent:blocked"),
      blockers: [...new Set([...blockersFromBody(i.body ?? ""), ...native])],
    };
  }));
}

/** Open tickets that can start now: not parked, and every blocker closed. Blockers outside the spec count as closed only if they are. */
export function frontierOf(tickets: Ticket[], closedOutside: Set<number> = new Set()): Ticket[] {
  const state = new Map(tickets.map((t) => [t.number, t.open]));
  return tickets.filter((t) => t.open && !t.parked && t.blockers.every((b) => (state.has(b) ? !state.get(b) : closedOutside.has(b))));
}

type QueueEntry = { position: number; title: string; body: string; depends_on: number[] };
/** decompose.ts's queue as sub-issues, blockers first, so every "Blocked by" names a real issue. */
async function createTickets(spec: number, queue: { tickets?: QueueEntry[] }): Promise<void> {
  const entries = [...(queue.tickets ?? [])].sort((a, b) => a.position - b.position);
  if (!entries.length) throw new NonRetriableError("decompose.ts returned no tickets.");
  const made = new Map<number, { number: number; id: number }>();
  try {
    for (const e of entries) {
      const blockers = e.depends_on.map((p) => made.get(p)).filter(Boolean) as { number: number; id: number }[];
      const { data } = await gh.issues.create({ owner, repo, title: e.title.slice(0, 120), labels: ["ready-for-agent"],
        body: `## Parent\n\n#${spec}\n\n${e.body}\n\n## Blocked by\n\n${blockers.length ? blockers.map((b) => `- #${b.number}`).join("\n") : "None (can start immediately)"}\n` });
      made.set(e.position, { number: data.number, id: data.id });
      // The sub-issue link is how the factory finds the spec's tickets, so it must not fail quietly.
      await gh.request("POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues", { owner, repo, issue_number: spec, sub_issue_id: data.id });
      // Blocking edges render the graph in GitHub's UI. The body's "Blocked by" section is what the factory reads.
      for (const b of blockers)
        await gh.request("POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by", { owner, repo, issue_number: data.number, issue_id: b.id }).catch(() => {});
    }
  } catch (err) {
    // A half-made set would be built as if it were whole, or decomposed again. A person finishes or deletes it.
    const list = [...made.values()].map((t) => `#${t.number}`).join(", ") || "none";
    throw new NonRetriableError(`Creating the tickets failed after ${made.size} of ${entries.length} (made: ${list}): ${(err as Error).message} Remove them from the spec's sub-issues to decompose again, or add the missing tickets yourself. Then resume.`);
  }
}

const notesPrompt = `
You explore for the night shift. Nobody is here to answer questions, and you change no file in the repository.
Read /tmp/spec.md and /tmp/tickets.md (the spec's tickets), then GLOSSARY.md, docs/adr/ and CODING_STANDARDS.md,
then the code each ticket will touch. Write /tmp/spec-notes.md for the agents that build the tickets, one per ticket,
each in a fresh context: where each ticket lands, the modules and seams to reuse, traps you found, and how the
tickets meet each other. Keep it under 300 lines.
`;

const mergePrompt = (branch: string, title: string) => `
A git merge of ${branch} ("${title}") into this branch stopped on conflicts. Finish it.
Run git status. Resolve each conflict so both sides' intent survives. Read both sides' commits first.
git add the files, then git commit --no-edit. Run the project's checks and fix anything the merge broke, in a new commit.
Do not change anything the conflicts do not need. If you cannot resolve a conflict with confidence,
run git merge --abort and write the reason to /tmp/merge-failed.md.
`;

export const specTicket = inngest.createFunction(
  {
    id: "spec-ticket",
    triggers: { event: "factory/spec-ticket.requested" }, // started by implement-spec with step.invoke
    retries: 1,
    onFailure: resetOnFailure((d) => d.ticket as number),
  },
  async ({ event, step, runId }) => {
    const spec = issueNumber(event.data.spec), ticket = issueNumber(event.data.ticket);
    const branch = `spec/${spec}-t${ticket}`;
    await step.run("mark-in-progress", () => gh.issues.addLabels({ owner, repo, issue_number: ticket, labels: ["agent:in-progress"] }));
    try {
      // The ticket, the spec and the exploration notes, then a branch from the integration branch.
      await runAgent(step, runId,
        ticketScript(ticket) + specFileScript(spec) + cloneScript(`
          git checkout -q -B ${branch} origin/spec/${spec}
          if git cat-file -e origin/spec/${spec}-notes:NOTES.md 2>/dev/null; then
            { printf '\\n\\n## Exploration notes\\n\\n'; git show origin/spec/${spec}-notes:NOTES.md; } >> /tmp/spec.md
          fi`),
        "npx tsx .sandcastle/agent-workflows/implement-spec/build.ts",
        `spec #${spec} ticket #${ticket}`);
      // A scratch branch the factory owns, so a retry may replace it.
      if (!(await pushCommits(step, runId, branch, { force: true }))) throw new Error("The agent made no commits.");
      return { branch };
    } catch (err) {
      await step.run("report-failure", async () => {
        await gh.issues.addLabels({ owner, repo, issue_number: ticket, labels: ["agent:blocked"] });
        await gh.issues.createComment({ owner, repo, issue_number: ticket,
          body: `Night-shift build failed: ${(err as Error).message} Remove \`agent:blocked\`, then add \`agent:implement-spec\` to #${spec} to retry.${statusTag}` });
      });
      throw err;
    } finally {
      await step.run("cleanup", async () => {
        await gh.issues.removeLabel({ owner, repo, issue_number: ticket, name: "agent:in-progress" }).catch(() => {});
        await docker.cleanup(runId);
      });
    }
  },
);

export const implementSpec = inngest.createFunction(
  {
    id: "implement-spec",
    triggers: { event: "factory/implement-spec.requested" },
    singleton: { key: "event.data.issueNumber", mode: "skip" },
    retries: 0, // each step is safe to repeat; a failed night ends with a comment on the spec
    onFailure: resetOnFailure((d) => d.issueNumber as number),
  },
  async ({ event, step, runId }) => {
    const spec = issueNumber(event.data.issueNumber);
    const integration = `spec/${spec}`, notes = `spec/${spec}-notes`;

    const specTitle = (await step.run("mark-in-progress", async () => {
      for (const name of ["agent:implement-spec", "agent:blocked"]) await gh.issues.removeLabel({ owner, repo, issue_number: spec, name }).catch(() => {});
      await gh.issues.addLabels({ owner, repo, issue_number: spec, labels: ["agent:in-progress"] });
      return (await gh.issues.get({ owner, repo, issue_number: spec })).data.title;
    })) as string;

    try {
      // 1. Tickets. /to-tickets usually made them already. If not, the course's decomposer does.
      if (!((await step.run("read-tickets", () => listTickets(spec))) as Ticket[]).length) {
        await runAgent(step, runId, specFileScript(spec) + cloneScript(""),
          "npx tsx .sandcastle/agent-workflows/implement-spec/decompose.ts", `decompose spec #${spec}`, "decompose");
        const queue = JSON.parse((await step.run("read-queue", () => docker.oneShot(runId, "cat /tmp/queue.json"))) as string);
        await step.run("create-tickets", () => createTickets(spec, queue));
      }

      // 2. The integration branch, from the default branch.
      await step.run("integration-branch", async () => {
        const exists = await gh.git.getRef({ owner, repo, ref: `heads/${integration}` }).then(() => true, () => false);
        if (exists) return;
        const base = (await gh.repos.get({ owner, repo })).data.default_branch;
        const sha = (await gh.git.getRef({ owner, repo, ref: `heads/${base}` })).data.object.sha;
        await gh.git.createRef({ owner, repo, ref: `refs/heads/${integration}`, sha });
      });

      // 3. Exploration notes, once per spec.
      if (!(await step.run("has-notes", () => gh.git.getRef({ owner, repo, ref: `heads/${notes}` }).then(() => true, () => false)))) {
        const list = ((await step.run("tickets-for-notes", () => listTickets(spec))) as Ticket[]).map((t) => `- #${t.number} ${t.title}`).join("\n");
        await runAgent(step, runId,
          specFileScript(spec) + `cat > /tmp/tickets.md <<'SF_TICKETS'\n${list.replace(/^SF_TICKETS$/gm, "")}\nSF_TICKETS\n` + cloneScript(`git checkout -q ${integration}`),
          `cat > /tmp/notes-prompt.md <<'SF_PROMPT'\n${notesPrompt}\nSF_PROMPT\n${promptAgent("/tmp/notes-prompt.md")}`, `notes spec #${spec}`, "notes");
        await step.run("publish-notes", () => docker.oneShot(runId, `
          ${agentFiles}
          agent_file /tmp/spec-notes.md || { rm -f /tmp/spec-notes.md; echo "The exploration run wrote no notes." > /tmp/spec-notes.md; }
          ${publishFileScript("/tmp/spec-notes.md", notes, "NOTES.md", `Exploration notes for spec #${spec}`)}`, ghToken()));
      }

      // 4. Waves over the frontier.
      for (let w = 0; ; w++) {
        if (w >= MAX_WAVES) throw new Error(`Stopped after ${MAX_WAVES} waves.`);
        const tickets = (await step.run(`survey-${w}`, () => listTickets(spec))) as Ticket[];
        const open = tickets.filter((t) => t.open);
        if (!open.length) break;
        const outside = [...new Set(open.flatMap((t) => t.blockers))].filter((b) => !tickets.some((t) => t.number === b));
        const closedOutside = new Set((await step.run(`outside-blockers-${w}`, async () => {
          const closed: number[] = [];
          // A missing issue (a typo in "Blocked by") counts as open, so the ticket waits and the stop message names it.
          for (const b of outside) {
            const state = await gh.issues.get({ owner, repo, issue_number: b }).then((r) => r.data.state, (e: { status?: number }) => { if (e.status === 404 || e.status === 410) return "missing"; throw e; });
            if (state === "closed") closed.push(b);
          }
          return closed;
        })) as number[]);
        // At most SLOTS tickets a wave: a larger wave would queue the rest past runAgent's slot wait.
        const frontier = frontierOf(tickets, closedOutside).slice(0, SLOTS);
        if (!frontier.length) {
          const parked = open.filter((t) => t.parked).map((t) => `#${t.number}`);
          const waiting = outside.filter((b) => !closedOutside.has(b)).map((b) => `#${b}`);
          throw new Error(`${open.length} ticket(s) are open and none can start.${parked.length ? ` Parked for a person: ${parked.join(", ")}.` : ""}${waiting.length ? ` Waiting on open or missing issues outside the spec: ${waiting.join(", ")}.` : ""}`);
        }

        // Each frontier ticket on its own runner, at once.
        const built = await Promise.allSettled(frontier.map((t) =>
          step.invoke(`build-${w}-${t.number}`, { function: specTicket, data: { spec, ticket: t.number } })));

        // Then merge them into the integration branch, one at a time.
        for (const [i, t] of frontier.entries()) {
          const r = built[i];
          if (r.status !== "fulfilled") continue; // spec-ticket parked it with agent:blocked
          const from = (r.value as { branch: string }).branch, key = `merge-${w}-${t.number}`;
          await step.run(`${key}:prepare`, () => docker.oneShot(runId, cloneScript(`git checkout -q ${integration}`), ghToken()));
          const how = ((await step.run(`${key}:try`, () => docker.oneShot(runId, `
            cd repo
            if git -c core.hooksPath=/dev/null merge -q --no-ff origin/${from} -m "Merge #${t.number} into ${integration}" >/dev/null 2>&1; then echo clean; else echo conflict; fi
          `))) as string).trim().split("\n").pop();
          if (how === "conflict") {
            await step.run(`${key}:setup`, () => docker.oneShot(runId, setupScript));
            await runAgent(step, runId, null,
              `cat > /tmp/merge-prompt.md <<'SF_PROMPT'\n${mergePrompt(from, t.title.replace(/[`$\\]/g, ""))}\nSF_PROMPT\n${promptAgent("/tmp/merge-prompt.md")}`,
              `merge #${t.number} into ${integration}`, key);
          }
          const verified = await step.run(`${key}:verify`, () => docker.oneShot(runId, `
            cd repo
            [ ! -s /tmp/merge-failed.md ] || { echo "The agent gave up: $(head -c 500 /tmp/merge-failed.md)"; rm -f /tmp/merge-failed.md; exit 1; }
            [ ! -f .git/MERGE_HEAD ] || { echo "The merge is still in progress."; exit 1; }
            test -z "$(git status --porcelain)" || { echo "The merge left uncommitted changes."; exit 1; }
            git merge-base --is-ancestor origin/${from} HEAD || { echo "${from} is not merged."; exit 1; }
            ${noWorkflowChanges(`origin/${integration}`)}
          `).catch(async (e: Error) => {
            // A merge that fails parks the ticket for a person. The night goes on. The posts sit in a step:
            // a failed step replays its error, and this handler with it, on every later replay.
            await step.run(`${key}:park`, async () => {
              await gh.issues.addLabels({ owner, repo, issue_number: t.number, labels: ["agent:blocked"] });
              await gh.issues.createComment({ owner, repo, issue_number: t.number, body: `Built on \`${from}\`, but the merge into \`${integration}\` failed: ${e.message}${statusTag}` });
            });
            return "parked";
          }));
          if (verified === "parked") continue;
          await step.run(`${key}:push`, () => docker.oneShot(runId, pushScript(integration), ghToken()));
          await step.run(`${key}:close`, async () => {
            await gh.issues.createComment({ owner, repo, issue_number: t.number, body: `Built and merged into \`${integration}\`. The review happens on the spec's PR.${statusTag}` });
            await gh.issues.update({ owner, repo, issue_number: t.number, state: "closed", state_reason: "completed" });
          });
        }
      }

      // 5. One PR for the whole spec. Review reads it first, then a human merges it.
      const pr = await step.run("open-spec-pr", async () => {
        const existing = (await gh.pulls.list({ owner, repo, head: `${owner}:${integration}`, state: "open" })).data[0];
        if (existing) return existing.html_url;
        const base = (await gh.repos.get({ owner, repo })).data.default_branch;
        const done = (await listTickets(spec)).map((t) => `- #${t.number} ${t.title}`).join("\n");
        const { data } = await gh.pulls.create({ owner, repo, head: integration, base, draft: true, title: `Spec #${spec}: ${specTitle}`.slice(0, 200),
          body: `Implements spec #${spec}. Built by the night shift, ticket by ticket, on \`${integration}\`.\n\n## Tickets\n\n${done}\n\nCloses #${spec}.\n\n---\nInngest run ${runId}. Nobody has read it yet.` });
        await gh.issues.addLabels({ owner, repo, issue_number: data.number, labels: ["agent:review"] });
        return data.html_url;
      });
      await step.run("report", () => gh.issues.createComment({ owner, repo, issue_number: spec, body: `Every ticket is built and merged into \`${integration}\`. The spec PR is in review: ${pr}${statusTag}` }));
      return { pr };
    } catch (err) {
      await step.run("report-failure", async () => {
        await gh.issues.addLabels({ owner, repo, issue_number: spec, labels: ["agent:blocked"] });
        await gh.issues.createComment({ owner, repo, issue_number: spec,
          body: `The night shift stopped: ${(err as Error).message} Fix or unpark the tickets, then add \`agent:implement-spec\` again to resume.${statusTag}` });
      });
      throw err;
    } finally {
      await step.run("cleanup", async () => {
        await gh.issues.removeLabel({ owner, repo, issue_number: spec, name: "agent:in-progress" }).catch(() => {});
        await docker.cleanup(runId);
      });
    }
  },
);
