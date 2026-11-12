import { cron } from "inngest";
import { inngest } from "../inngest.ts";
import { gh, owner, repo } from "../run.ts";
import { ISSUE_LABELS, PR_LABELS, eventForLabel, prototypeCommentEvent } from "../triggers.ts";
import { pendingFeedback } from "./prototype.ts";

// The local fallback for webhooks: once a minute, find trigger labels and prototype feedback, and send the same
// events the webhook sends. Duplicates are safe. Each task removes its trigger label in its first step, singleton
// and debounce skip repeats, and comment events carry an id that Inngest deduplicates.
// The cost is up to a minute of delay, one API call per trigger label a minute, and one per open `prototype`
// issue a minute (the PAT allows 5,000 an hour).
const labelled = (label: string) => gh.paginate(gh.issues.listForRepo, { owner, repo, state: "open", labels: label, per_page: 100 });

export const githubPoll = inngest.createFunction(
  { id: "github-poll", triggers: [cron("* * * * *")], singleton: { mode: "skip" }, retries: 0 },
  async ({ step }) => {
    const events = await step.run("find-triggers", async () => {
      const out: { id?: string; name: string; data: Record<string, number> }[] = [];
      for (const [label, isPr] of [...Object.keys(ISSUE_LABELS).map((l) => [l, false] as const), ...Object.keys(PR_LABELS).map((l) => [l, true] as const)]) {
        const items = (await labelled(label)).filter((i) => Boolean(i.pull_request) === isPr);
        // Explore takes the whole labelled batch in one run, so one event is enough.
        for (const i of label === "agent:explore" ? items.slice(0, 1) : items) out.push(eventForLabel(label, i.number, isPr)!);
      }
      // Prototype feedback no version answered yet. Level-based: a mention posted while the orchestrator was
      // down still fires. Running and parked issues wait. The mention's id dedupes repeats.
      for (const i of (await labelled("prototype")).filter((i) => !i.pull_request)) {
        if (i.labels.some((l) => ["agent:in-progress", "agent:blocked"].includes(typeof l === "string" ? l : l.name ?? ""))) continue;
        const mention = await pendingFeedback(i.number);
        if (mention) out.push(prototypeCommentEvent(i.number, mention));
      }
      return out;
    });
    if (events.length) await step.sendEvent("send-trigger-events", events);
    return { sent: events.length };
  },
);
