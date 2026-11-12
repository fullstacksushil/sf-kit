import express from "express";
import { serve } from "inngest/express";
import { inngest } from "./inngest.ts";
import { githubWebhook } from "./webhooks.ts";
import { implementTicket } from "./functions/implement.ts";
import { reviewPr } from "./functions/review.ts";
import { exploreBatch } from "./functions/explore.ts";
import { lintRatchet } from "./functions/ratchet.ts";
import { githubPoll } from "./functions/poll.ts";
import { prototypeIssue, prototypeRequeue } from "./functions/prototype.ts";
import { rebasePr, rebaseSweep } from "./functions/rebase.ts";
import { architectureReview } from "./functions/architecture.ts";
import { implementSpec, specTicket } from "./functions/implement-spec.ts";

for (const name of ["INNGEST_SIGNING_KEY", "INNGEST_EVENT_KEY", "GITHUB_WEBHOOK_SECRET", "FACTORY_PAT", "GITHUB_REPO", "CLAUDE_CODE_OAUTH_TOKEN"]) {
  if (!process.env[name]) throw new Error(`Missing env var ${name}. See /etc/factory/orchestrator.env`);
}

// GITHUB_POLL=1 adds the poller: the local fallback when GitHub cannot reach a webhook URL.
const functions = [
  exploreBatch, implementTicket, reviewPr, lintRatchet, prototypeIssue, prototypeRequeue, rebaseSweep, rebasePr, architectureReview, implementSpec, specTicket,
  ...(process.env.GITHUB_POLL === "1" ? [githubPoll] : []),
];

const app = express();
// The webhook needs the raw body for its signature check, so it comes before express.json().
app.post("/webhooks/github", express.raw({ type: "application/json" }), githubWebhook);
app.use(express.json({ limit: "10mb" }));
app.use("/api/inngest", serve({ client: inngest, functions }));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`orchestrator listening on :${port}`));
