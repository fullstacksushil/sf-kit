import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { inngest } from "./inngest.ts";
import { eventForLabel, prototypeCommentEvent } from "./triggers.ts";
import { isPrototypeMention } from "./functions/prototype.ts";

export function validSignature(secret: string, raw: Buffer, header: string | undefined): boolean {
  const want = Buffer.from("sha256=" + createHmac("sha256", secret).update(raw).digest("hex"));
  const got = Buffer.from(header ?? "");
  return want.length === got.length && timingSafeEqual(want, got);
}

/** GitHub label events become Inngest events. Only collaborators can add labels, which is the access control. */
export async function githubWebhook(req: Request, res: Response) {
  const raw = req.body as Buffer;
  if (!validSignature(process.env.GITHUB_WEBHOOK_SECRET!, raw, req.header("X-Hub-Signature-256"))) {
    res.sendStatus(401);
    return;
  }
  const body = JSON.parse(raw.toString("utf8"));
  const event = req.header("X-GitHub-Event");
  // GitHub names are case-insensitive: "Acme/Web" in the env file is the same repo as "acme/web".
  if (String(body.repository?.full_name).toLowerCase() !== String(process.env.GITHUB_REPO).toLowerCase()) {
    res.sendStatus(202); // another repo on the same hook: ignore
    return;
  }

  if ((event === "issues" || event === "pull_request") && body.action === "labeled") {
    const isPr = event === "pull_request";
    const e = eventForLabel(body.label?.name ?? "", isPr ? body.pull_request.number : body.issue.number, isPr);
    if (e) await inngest.send(e);
  }
  // Feedback on a prototype: a collaborator's "@factory" comment on an issue labelled `prototype`.
  if (event === "issue_comment" && body.action === "created" && !body.issue.pull_request
      && body.issue.labels?.some((l: { name: string }) => l.name === "prototype") && isPrototypeMention(body.comment)) {
    await inngest.send(prototypeCommentEvent(body.issue.number, body.comment.id));
  }
  res.sendStatus(200);
}
