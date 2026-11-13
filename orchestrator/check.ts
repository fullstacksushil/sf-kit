// Run: npx tsx check.ts. The guards that keep untrusted text out of the shell, and the explore plan rules.
import assert from "node:assert";
process.env.GITHUB_REPO = "a/b";
process.env.FACTORY_NAME = "qf";
const { planProblems } = await import("./src/functions/explore.ts");
const { safeRef, issueNumber, pushScript } = await import("./src/run.ts");
assert.deepEqual(planProblems({ issues: [{ number: 1, tag: "easy-call", comment: "x" }] }, [1]), []);
assert.equal(planProblems({ issues: [{ number: 1, tag: "go", comment: " " }] }, [1]).length, 2);
assert.equal(safeRef("agent/issue-12-abc"), "agent/issue-12-abc");
for (const bad of ["x$(curl evil)", "a;b", "-x", "a..b", "a b"]) assert.throws(() => safeRef(bad), undefined, bad);
assert.equal(issueNumber(12), 12);
for (const bad of [0, -1, 1.5, "12", "1; rm -rf /", null]) assert.throws(() => issueNumber(bad), undefined, String(bad));
assert.throws(() => pushScript("main;id", { base: "HEAD" }));
assert.throws(() => pushScript("agent/x", { base: "main;id" }));
assert.ok(!/cd repo/.test(pushScript("agent/x", { base: "HEAD" })), "the token push must not run git inside the agent's repo");
{ // Private deps: the token clone strips the token, and setup redirects to the local copy.
  process.env.RUN_PRIVATE_DEPS = "acme/shared";
  const r = await import("./src/run.ts?deps");
  assert.match(r.cloneScript(""), /remote set-url origin https:\/\/github.com\/acme\/shared.git/);
  assert.match(r.setupScript, /url.file:\/\/\/work\/deps\/acme\/shared.git.insteadOf ssh:\/\/git@github.com\/acme\/shared.git/);
  assert.ok(!/GH_TOKEN/.test(r.setupScript), "setup must not see the token");
  process.env.RUN_PRIVATE_DEPS = "acme/x;id";
  await assert.rejects(import("./src/run.ts?bad"));
  delete process.env.RUN_PRIVATE_DEPS;
}
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
assert.equal(eventForLabel("agent:rebase", 5, true)?.name, "factory/qf/rebase.requested");
assert.equal(eventForLabel("agent:rebase", 5, false), null, "a PR label on an issue starts nothing");
assert.ok(isPrototypeMention({ body: "@factory make it blue", author_association: "OWNER" }));
assert.ok(!isPrototypeMention({ body: "@factory make it blue", author_association: "NONE" }), "strangers cannot trigger runs");
assert.ok(!isPrototypeMention({ body: "Reply with @factory <!-- factory:prototype -->", author_association: "OWNER" }), "the factory's own comment");
assert.match(pushScript("spec/3-t4", { base: "spec/3", force: true }), /push -q --force /);
assert.match(pushScript("agent/x", { base: "main", leaseSha: "a".repeat(40) }), /--force-with-lease=refs\/heads\/agent\/x:a{40} /);
assert.throws(() => pushScript("agent/x", { base: "main", leaseSha: "nope" }));
console.log("new task checks ok");

// Multi-factory: event names, the factory name and port checks, the serve origin, the host-wide slot lock.
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
const { inngest, ev, serveOrigin } = await import("./src/inngest.ts");
const { ISSUE_LABELS, PR_LABELS, prototypeCommentEvent } = await import("./src/triggers.ts");
assert.equal(inngest.id, "software-factory-qf");
assert.equal(ev("ratchet.requested"), "factory/qf/ratchet.requested");
for (const name of [...Object.values(ISSUE_LABELS), ...Object.values(PR_LABELS), prototypeCommentEvent(1, 2).name, eventForLabel("agent:rebase", 5, true)!.name])
  assert.match(name, /^factory\/qf\/[a-z-]+\.[a-z]+$/, name);
{ // No raw event name in the source: every name goes through ev().
  const files = readdirSync("src", { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
  const raw = files.flatMap((f) => readFileSync(`src/${f}`, "utf8").split("\n").filter((l) => /["'`]factory\//.test(l)).map((l) => `${f}: ${l.trim()}`));
  assert.deepEqual(raw, ["inngest.ts: export const ev = (event: string) => `factory/${FACTORY_NAME}/${event}`;"]);
}
assert.equal(serveOrigin(3001), "http://host.docker.internal:3001");
{ // The server registers with Inngest under the serve origin. A fake Inngest records the register call.
  const { createServer } = await import("node:http");
  const bodies: string[] = [];
  const fake = createServer((q, r) => { let b = ""; q.on("data", (d) => (b += d)); q.on("end", () => { bodies.push(b); r.setHeader("content-type", "application/json"); r.end("{}"); }); });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const free = createServer(); await new Promise<void>((r) => free.listen(0, "127.0.0.1", r));
  const port = (free.address() as { port: number }).port; free.close();
  const srv = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { stdio: ["ignore", "pipe", "inherit"], env: {
    PATH: process.env.PATH!, FACTORY_NAME: "qf", PORT: String(port), INNGEST_DEV: "0", INNGEST_BASE_URL: `http://127.0.0.1:${(fake.address() as { port: number }).port}`,
    INNGEST_SIGNING_KEY: `signkey-prod-${"ab".repeat(32)}`, INNGEST_EVENT_KEY: "k", GITHUB_WEBHOOK_SECRET: "s", FACTORY_PAT: "p", GITHUB_REPO: "a/b", CLAUDE_CODE_OAUTH_TOKEN: "t" } });
  try {
    await new Promise((r) => srv.stdout!.once("data", r));
    await fetch(`http://127.0.0.1:${port}/api/inngest`, { method: "PUT" });
    assert.equal(JSON.parse(bodies[0] ?? "{}").url, `http://host.docker.internal:${port}/api/inngest`, "server.ts must register under serveOrigin()");
  } finally { srv.kill(); fake.close(); }
}
{ // The server refuses a bad factory name and a missing port, with a message that names the variable.
  const start = (env: Record<string, string>) => spawnSync(process.execPath, ["--import", "tsx", "src/server.ts"], { env: { PATH: process.env.PATH!, ...env }, encoding: "utf8", timeout: 20000 });
  for (const name of ["", "QF", "1qf", "q_f", "a".repeat(22)]) {
    const r = start({ FACTORY_NAME: name, PORT: "3001" });
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, /FACTORY_NAME/, name);
  }
  for (const port of [undefined, "", "x", "0"]) {
    const r = start({ FACTORY_NAME: "qf", ...(port === undefined ? {} : { PORT: port }) });
    assert.notEqual(r.status, 0, String(port));
    assert.match(r.stderr, /PORT/, String(port));
  }
}
{ // Two slot callers run one after the other, also when they do not share the in-process queue.
  const { hostLock } = await import("./src/run.ts");
  const lock = `${mkdtempSync(`${tmpdir()}/sf-lock-`)}/slots.lock`;
  const log: string[] = [];
  const caller = (n: string) => hostLock(async () => { log.push(`in ${n}`); await new Promise((r) => setTimeout(r, 300)); log.push(`out ${n}`); }, lock);
  await Promise.all([caller("a"), caller("b")]);
  assert.ok(["in a,out a,in b,out b", "in b,out b,in a,out a"].includes(log.join()), log.join());
  await assert.rejects(hostLock(async () => { throw new Error("boom"); }, lock));
  assert.equal(await hostLock(async () => 2, lock), 2, "a failed caller frees the lock");
  // A killed holder releases the lock: the kernel drops it with the holder's process.
  const holder = spawn(process.execPath, ["--import", "tsx", "-e",
    `const { hostLock } = await import("./src/run.ts"); await hostLock(() => { console.log("holding"); return new Promise(() => {}); }, ${JSON.stringify(lock)});`],
    { env: { ...process.env }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((res) => holder.stdout!.once("data", () => res()));
  const waiting = hostLock(async () => 4, lock);
  const timer = (ms: number) => new Promise((r) => setTimeout(() => r("timeout"), ms));
  assert.equal(await Promise.race([waiting, timer(300)]), "timeout", "the waiter must wait while the holder lives");
  holder.kill("SIGKILL");
  assert.equal(await Promise.race([waiting, timer(5000)]), 4, "a killed holder releases the lock");
  // A wait that runs out says so, as a LockTimeout. runAgent treats that like "no slot now" and waits on.
  const { LockTimeout } = await import("./src/run.ts");
  let release!: () => void;
  const held = hostLock(() => new Promise<void>((r) => (release = r)), lock);
  await new Promise((r) => setTimeout(r, 200));
  await assert.rejects(hostLock(async () => 5, lock, 1), (e: Error) => e instanceof LockTimeout && /timed out/.test(e.message));
  release(); await held;
}
{ // The container label and sf's docker filter both use the lowercased repo.
  process.env.GITHUB_REPO = "Acme/My-App";
  const { repoLabel } = await import("./src/docker.ts");
  assert.equal(repoLabel(), "factory.repo=acme/my-app");
  const { volumes } = await import("./src/docker.ts");
  assert.deepEqual(volumes("r1"), [
    "--mount", "type=volume,src=run-r1-work,dst=/work,volume-label=factory.repo=acme/my-app",
    "--mount", "type=volume,src=run-r1-tmp,dst=/tmp,volume-label=factory.repo=acme/my-app",
  ]);
  process.env.GITHUB_REPO = "a/b";
}
{ // Traces carry the factory name.
  process.env.OTEL_TRACES_ENDPOINT = "http://phoenix:6006/v1/traces";
  const { agentEnv } = await import("./src/docker.ts");
  assert.equal(agentEnv("r1").OTEL_RESOURCE_ATTRIBUTES, "factory.run_id=r1,factory.name=qf");
  delete process.env.OTEL_TRACES_ENDPOINT;
}
console.log("multi-factory checks ok");
