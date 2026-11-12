// One table of trigger labels for the webhook and the poller, so both start the same runs.
export const ISSUE_LABELS: Record<string, string> = {
  "agent:explore": "factory/explore.requested",
  "agent:implement": "factory/implement.requested",
  "agent:prototype": "factory/prototype.requested",
  "agent:implement-spec": "factory/implement-spec.requested",
};
export const PR_LABELS: Record<string, string> = {
  "agent:review": "factory/review.requested",
  "agent:rebase": "factory/rebase.requested",
};

/** The event a label starts, or null. Issue events carry issueNumber, PR events prNumber. */
export function eventForLabel(label: string, number: number, isPr: boolean) {
  const name = (isPr ? PR_LABELS : ISSUE_LABELS)[label];
  if (!name) return null;
  const data: Record<string, number> = isPr ? { prNumber: number } : { issueNumber: number };
  return { name, data };
}

/** A new prototype version, from a comment. The id makes Inngest drop the duplicate when webhook and poller both see it. */
export const prototypeCommentEvent = (issueNumber: number, commentId: number) =>
  ({ id: `prototype-comment-${commentId}`, name: "factory/prototype.requested", data: { issueNumber } });
