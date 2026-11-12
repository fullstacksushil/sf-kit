// Run: npx tsx check.ts. The guards that keep untrusted text out of the shell, and the explore plan rules.
import assert from "node:assert";
process.env.GITHUB_REPO = "a/b";
const { planProblems } = await import("./src/functions/explore.ts");
const { safeRef, issueNumber, pushScript } = await import("./src/run.ts");
assert.deepEqual(planProblems({ issues: [{ number: 1, tag: "easy-call", comment: "x" }] }, [1]), []);
assert.equal(planProblems({ issues: [{ number: 1, tag: "go", comment: " " }] }, [1]).length, 2);
assert.equal(safeRef("agent/issue-12-abc"), "agent/issue-12-abc");
for (const bad of ["x$(curl evil)", "a;b", "-x", "a..b", "a b"]) assert.throws(() => safeRef(bad), undefined, bad);
assert.equal(issueNumber(12), 12);
for (const bad of [0, -1, 1.5, "12", "1; rm -rf /", null]) assert.throws(() => issueNumber(bad), undefined, String(bad));
assert.throws(() => pushScript("main;id"));
assert.ok(!/cd repo/.test(pushScript("agent/x")), "the token push must not run git inside the agent's repo");
console.log("checks ok");

// The new tasks' pure logic.
const { frontierOf } = await import("./src/functions/implement-spec.ts");
const { strongCandidates } = await import("./src/functions/architecture.ts");
const { eventForLabel } = await import("./src/triggers.ts");
const { isPrototypeMention } = await import("./src/functions/prototype.ts");
const t = (number: number, open: boolean, blockers: number[] = [], parked = false) => ({ number, title: "", open, parked, blockers });
assert.deepEqual(frontierOf([t(1, false), t(2, true, [1]), t(3, true, [2]), t(4, true, [], true)]).map((x) => x.number), [2]);
assert.deepEqual(frontierOf([t(2, true, [99])]).map((x) => x.number), [], "an open outside blocker blocks");
assert.deepEqual(frontierOf([t(2, true, [99])], new Set([99])).map((x) => x.number), [2], "a closed outside blocker does not");
assert.deepEqual(strongCandidates({ candidates: [
  { title: "Bookings", strength: "Strong", body: "b" }, { title: "X", strength: "Speculative", body: "b" }, { title: "", strength: "Strong", body: "b" },
] }).map((c) => c.title), ["Bookings"]);
assert.throws(() => strongCandidates({}));
assert.equal(eventForLabel("agent:rebase", 5, true)?.name, "factory/rebase.requested");
assert.equal(eventForLabel("agent:rebase", 5, false), null, "a PR label on an issue starts nothing");
assert.ok(isPrototypeMention({ body: "@factory make it blue", author_association: "OWNER" }));
assert.ok(!isPrototypeMention({ body: "@factory make it blue", author_association: "NONE" }), "strangers cannot trigger runs");
assert.ok(!isPrototypeMention({ body: "Reply with @factory <!-- factory:prototype -->", author_association: "OWNER" }), "the factory's own comment");
assert.match(pushScript("spec/3-t4", { force: true }), /push -q --force /);
assert.match(pushScript("agent/x", { leaseSha: "a".repeat(40) }), /--force-with-lease=refs\/heads\/agent\/x:a{40} /);
assert.throws(() => pushScript("agent/x", { leaseSha: "nope" }));
console.log("new task checks ok");
