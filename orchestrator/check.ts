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
{
  const { openFactoryPr } = await import("./src/run.ts");
  const prs = [{ number: 1, head: { ref: "agent/issue-320-01ABC" } }, { number: 2, head: { ref: "feature/issue-32-x" } }, { number: 3, head: { ref: "agent/issue-32-01DEF" } }];
  assert.equal(openFactoryPr(prs, 32)?.number, 3, "finds the PR of issue 32, not of issue 320");
  assert.equal(openFactoryPr(prs, 3), undefined, "no PR for issue 3");
}
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

{ // Every agent container writes the activity hook before the agent runs. A fake docker records the script.
  const { startAgent } = await import("./src/docker.ts");
  const { writeFileSync, chmodSync, mkdirSync } = await import("node:fs");
  const dir = mkdtempSync(`${tmpdir()}/sf-hook-`);
  writeFileSync(`${dir}/docker`, `#!/bin/sh\nfor a in "$@"; do last="$a"; done\nprintf '%s' "$last" > "${dir}/script"\n`);
  chmodSync(`${dir}/docker`, 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  await startAgent("r1", "echo agent-ran", {}, "issue #1");
  process.env.PATH = path;
  const script = readFileSync(`${dir}/script`, "utf8");
  const home = `${dir}/home`;
  mkdirSync(home);
  const run = (h: string) => spawnSync("bash", ["-c", script], { env: { PATH: path!, HOME: h }, encoding: "utf8" });
  assert.equal(run(home).stdout.trim(), "agent-ran");
  const hooks = JSON.parse(readFileSync(`${home}/.claude/settings.json`, "utf8")).hooks;
  // Run each hook command for real. A temp file stands in for the container's stdout.
  const out = `${dir}/out`;
  const fire = (ev: string, input: object) => {
    const cmd: string = hooks[ev][0].hooks[0].command;
    assert.ok(cmd.includes("> /proc/1/fd/1"), cmd);
    const r = spawnSync("sh", ["-c", cmd.replace("/proc/1/fd/1", out)], { input: JSON.stringify(input), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const line = readFileSync(out, "utf8");
    assert.match(line, /^\{"sf":1,"t":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ",/);
    assert.ok(line.endsWith("}\n") && line.split("\n").length === 2, line);
    return line.replace(/"t":"[^"]*"/, '"t":"T"');
  };
  const cmdIn = { command: 'echo "a"\nb' + "x".repeat(100) };
  const base = { session_id: "s", cwd: "/work/repo", tool_use_id: "u" };
  // `in` is the most useful value of the input as plain text, cut to 80 characters. A multi-line command stays one line.
  assert.equal(fire("PreToolUse", { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: cmdIn }),
    `{"sf":1,"t":"T","ev":"PreToolUse","id":"u","tool":"Bash","in":${JSON.stringify(cmdIn.command.slice(0, 80))}}\n`);
  assert.equal(fire("PreToolUse", { ...base, hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/work/repo/src/a.ts", limit: 20 } }),
    `{"sf":1,"t":"T","ev":"PreToolUse","id":"u","tool":"Read","in":"/work/repo/src/a.ts"}\n`);
  assert.equal(fire("PreToolUse", { ...base, hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: { pattern: "x\\|y", path: "src" } }),
    `{"sf":1,"t":"T","ev":"PreToolUse","id":"u","tool":"Grep","in":"x\\\\|y"}\n`);
  const odd = { todos: [{ content: "a", status: "pending" }] };
  assert.equal(fire("PreToolUse", { ...base, hook_event_name: "PreToolUse", tool_name: "TodoWrite", tool_input: odd }),
    `{"sf":1,"t":"T","ev":"PreToolUse","id":"u","tool":"TodoWrite","in":${JSON.stringify(JSON.stringify(odd))}}\n`);
  assert.equal(fire("PostToolUse", { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: cmdIn, tool_response: {}, duration_ms: 2105 }),
    `{"sf":1,"t":"T","ev":"PostToolUse","id":"u","tool":"Bash","ms":2105}\n`);
  // A failed or denied call closes its id too. Input shapes from https://code.claude.com/docs/en/hooks, read on 2026-11-13.
  assert.equal(fire("PostToolUseFailure", { ...base, hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: cmdIn, error: "Exit code 1", is_interrupt: false, duration_ms: 40 }),
    `{"sf":1,"t":"T","ev":"PostToolUseFailure","id":"u","tool":"Bash","ms":40,"err":"Exit code 1"}\n`);
  assert.equal(fire("PermissionDenied", { ...base, hook_event_name: "PermissionDenied", tool_name: "Bash", tool_input: cmdIn, reason: "[x]" }),
    `{"sf":1,"t":"T","ev":"PermissionDenied","id":"u","tool":"Bash"}\n`);
  // A hook never fails a tool call: exit 2 from PreToolUse would block it. Bad JSON and an unwritable target both exit 0.
  for (const ev of Object.keys(hooks)) {
    const cmd: string = hooks[ev][0].hooks[0].command;
    assert.equal(spawnSync("sh", ["-c", cmd.replace("/proc/1/fd/1", out)], { input: "{not json", encoding: "utf8" }).status, 0, `${ev} with bad JSON`);
    assert.equal(spawnSync("sh", ["-c", cmd.replace("/proc/1/fd/1", `${dir}/no/such/dir/out`)], { input: '{"hook_event_name":"Stop"}', encoding: "utf8" }).status, 0, `${ev} with an unwritable target`);
  }
  assert.equal(fire("Stop", { ...base, hook_event_name: "Stop", last_assistant_message: "done" }), `{"sf":1,"t":"T","ev":"Stop"}\n`);
  // The rtk hook, Bash only. In an image without rtk it does nothing: exit 0, no output, the command unchanged.
  const rtkHook = hooks.PreToolUse[1];
  assert.equal(rtkHook.matcher, "Bash");
  const noRtk = spawnSync("sh", ["-c", rtkHook.hooks[0].command], { input: JSON.stringify({ tool_input: cmdIn }), env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  assert.deepEqual([noRtk.status, noRtk.stdout], [0, ""]);
  // An existing user settings file stays as it was. The agent still runs.
  const home2 = `${dir}/home2`;
  mkdirSync(`${home2}/.claude`, { recursive: true });
  writeFileSync(`${home2}/.claude/settings.json`, '{"model":"x"}');
  const r2 = run(home2);
  assert.match(r2.stdout, /agent-ran/);
  assert.equal(readFileSync(`${home2}/.claude/settings.json`, "utf8"), '{"model":"x"}');
}
{
  const { tailForMessage } = await import("./src/docker.ts");
  const log = ['{"sf":1,"t":1,"ev":"PreToolUse"}', ...Array.from({ length: 12 }, (_, i) => `line ${i}`), "", "token tok-123 and sk-ant-oat01-AbC_d", "```", "Error: boom"].join("\n");
  const tail = tailForMessage(log, ["tok-123", ""]);
  assert.ok(tail.endsWith("Error: boom") && tail.split("\n").length === 8, "the last 8 lines with text");
  assert.ok(!/tok-123|sk-ant|"sf":1|```/.test(tail) && tail.includes("token <redacted> and <redacted>"), "no secret, no activity line, no fence");
  assert.ok(tailForMessage("x".repeat(5000)).length === 600 && tailForMessage("") === "");
}
console.log("activity hook checks ok");

{ // Machines: FACTORY_MACHINES lists where agents run, with a slot count each. Without it: local with FACTORY_SLOTS.
  const { parseMachines } = await import("./src/docker.ts");
  assert.deepEqual(parseMachines(undefined, "3"), [{ target: "local", slots: 3 }]);
  assert.deepEqual(parseMachines(undefined, undefined), [{ target: "local", slots: 2 }]);
  assert.deepEqual(parseMachines(" ", "3"), [{ target: "local", slots: 3 }], "an empty FACTORY_MACHINES= line means not set");
  assert.throws(() => parseMachines(undefined, "abc"), /FACTORY_SLOTS/);
  assert.deepEqual(parseMachines(" local=2  ssh://factory@linux-box=3 ssh://f@mac-mini.tail1.ts.net:2222=0 ", "9"),
    [{ target: "local", slots: 2 }, { target: "ssh://factory@linux-box", slots: 3 }, { target: "ssh://f@mac-mini.tail1.ts.net:2222", slots: 0 }]);
  for (const bad of ["local", "local=", "local=x", "local=-1", "local=1.5", "http://h=2", "ssh://h=1", "ssh://u@h;id=1", "ssh://-oProxyCommand=x@h=1", "local=1 local=2", "abc", "x=1 y"])
    assert.throws(() => parseMachines(bad, "2"), /FACTORY_MACHINES/, JSON.stringify(bad));
  process.env.FACTORY_MACHINES = "local=1 ssh://u@h;id=1";
  await assert.rejects(import("./src/docker.ts?badmachines"), /FACTORY_MACHINES/, "a bad list stops the orchestrator at start");
  process.env.FACTORY_MACHINES = "ssh://u@h=2 ssh://u@g=3";
  // A fresh process: run.ts reads MACHINES from docker.ts, which this process already loaded.
  const workersOnly = spawnSync(process.execPath, ["--import", "tsx", "-e", 'import("./src/run.ts").then((r) => console.log(r.TOTAL_SLOTS))'], { env: { ...process.env }, encoding: "utf8", timeout: 20000 });
  assert.equal(workersOnly.stdout.trim(), "5", "a list without local works, and the slots add up");
  delete process.env.FACTORY_MACHINES;
}
{ // Every docker call goes to its machine: DOCKER_HOST for a remote one, the process env for local. Every call has a timeout.
  const { dockerCall, runningAgents } = await import("./src/docker.ts");
  const { writeFileSync, chmodSync } = await import("node:fs");
  const dir = mkdtempSync(`${tmpdir()}/sf-machine-`);
  writeFileSync(`${dir}/docker`, `#!/bin/sh\necho "\${DOCKER_HOST:-none} $*" >> "${dir}/log"\n[ "$1" = hang ] && exec sleep 5\n[ "$1" = ps ] && printf 'a\\nb\\n'\nexit 0\n`);
  chmodSync(`${dir}/docker`, 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    await dockerCall("local", ["info"]);
    await dockerCall("ssh://factory@linux-box", ["info"]);
    assert.equal(await runningAgents("ssh://factory@linux-box"), 2);
    assert.equal(await runningAgents("local"), 2);
    assert.deepEqual(readFileSync(`${dir}/log`, "utf8").trim().split("\n"), [
      "none info", "ssh://factory@linux-box info",
      "ssh://factory@linux-box ps -q --filter name=^agent-", "none ps -q --filter name=^agent-"]);
    const t = Date.now();
    await assert.rejects(dockerCall("local", ["hang"], { timeout: 300 }), /timed out after 300 ms/);
    assert.ok(Date.now() - t < 3000, "the timeout ends a hung call");
  } finally { process.env.PATH = path; }
}
{ // Placement: a run's volumes live on one machine and record where the run is. Every call of the run goes there.
  const { place, findRun, oneShot, cleanup, startIfFree, agentExitCode, failureNote, remember, sweep, takeReadyToSweep } = await import("./src/docker.ts");
  const { writeFileSync, chmodSync, readdirSync: ls, rmSync, mkdirSync } = await import("node:fs");
  const dir = mkdtempSync(`${tmpdir()}/sf-place-`);
  // A fake docker with state per DOCKER_HOST. A volume or container is a file that holds "<run> <created> <name>".
  // A machine named *down*, or one with a file in off/, does not answer.
  writeFileSync(`${dir}/docker`, `#!/bin/sh
h=$(printf %s "\${DOCKER_HOST:-local}" | tr -c 'A-Za-z0-9' _); d="${dir}/m/$h"; mkdir -p "$d/vol" "$d/agents"
case "\${DOCKER_HOST:-}" in *down*) echo "ssh: connect to host down: No route to host" >&2; exit 255 ;; esac
[ -e "${dir}/off/$h" ] && { echo "error during connect: ssh: connect to host: Connection timed out" >&2; exit 255; }
echo "\${DOCKER_HOST:-local} $*" | tr "\\n" " " >> "${dir}/log"; echo >> "${dir}/log"
labels() { run=-; at=0; while [ $# -gt 0 ]; do case "$1" in --label) case "$2" in factory.run=*) run="\${2#factory.run=}" ;; factory.created=*) at="\${2#factory.created=}" ;; esac ;; esac; shift; done; }
case "$1 $2" in
  "volume create") for a in "$@"; do last="$a"; done; labels "$@"; echo "$run $at $last" > "$d/vol/$last" ;;
  "volume ls") case "$*" in *factory.run*) cat "$d"/vol/* 2>/dev/null ;; *) ls "$d/vol" ;; esac ;;
  "volume rm") shift 3; for v in "$@"; do rm -f "$d/vol/$v"; done ;;
  "ps -q") ls "$d/agents" ;;
  "ps -a") cat "$d"/agents/* 2>/dev/null | grep -v '^- ' ;;
  "ps -aq") case "$4" in
      label=factory.run=*) id="\${4#label=factory.run=}"; for f in "$d"/agents/*; do [ -e "$f" ] && read -r run at n < "$f" && [ "$run" = "$id" ] && echo "$n"; done ;;
      name=*) n="\${4#name=^}"; n="\${n%$}"; for f in "$d"/agents/"$n"*; do [ -e "$f" ] && basename "$f"; done ;;
    esac ;;
  "rm -f") shift 2; for c in "$@"; do rm -f "$d/agents/$c"; done ;;
  "run -d") labels "$@"; echo "$run $at $4" > "$d/agents/$4" ;;
  "inspect -f") case "$4" in *gone*) echo "Error: No such object: $4" >&2; exit 1 ;; esac; echo "exited 0" ;;
esac
exit 0
`);
  chmodSync(`${dir}/docker`, 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  const machines = [{ target: "local", slots: 1 }, { target: "ssh://f@b", slots: 2 }, { target: "ssh://f@c", slots: 0 }];
  const log = () => readFileSync(`${dir}/log`, "utf8").trim().split("\n").map((l) => l.trim());
  try {
    assert.equal(await place("r1", machines), "ssh://f@b", "no load anywhere: the machine with the most slots");
    assert.equal(await place("r2", machines), "local", "b holds 1 of 2, local 0 of 1");
    assert.equal(await place("r3", machines), "ssh://f@b", "local holds 1 of 1, b 1 of 2");
    assert.equal(await place("r1", machines), "ssh://f@b", "a retry keeps the run's machine");
    assert.equal(log().filter((l) => /volume create .*run-r1-work$/.test(l)).length, 1, "a retry creates no second volume");
    assert.ok(log().some((l) => l.startsWith("ssh://f@b volume create --label factory.repo=")), "the volumes carry the repo label");
    assert.equal(await place("r4", [{ target: "local", slots: 0 }]), null, "no machine with a slot: no place");
    assert.deepEqual(ls(`${dir}/m/ssh___f_c/vol`), [], "a machine with 0 slots gets no volume");
    // After a restart the orchestrator has no memory. The volumes still say where each run is.
    assert.equal(await findRun("r2", machines), "local");
    assert.equal(await findRun("r3", machines), "ssh://f@b");
    assert.equal(await findRun("nope", machines), undefined);

    // Every call of r3 goes to b: one-shot steps, the agent start, the exit check, the cleanup.
    const before = log().length;
    process.env.OTEL_TRACES_ENDPOINT = "http://phoenix:6006/v1/traces";
    await oneShot("r3", "true");
    assert.equal(await startIfFree("r3", "true", "issue #3", "r3", machines), true);
    assert.equal(await startIfFree("r3", "true", "issue #3", "r3", machines), true, "a retry after the start: still started");
    delete process.env.OTEL_TRACES_ENDPOINT;
    assert.equal(await agentExitCode("r3", "r3"), 0);
    await cleanup("r3");
    const r3calls = log().slice(before);
    assert.ok(r3calls.length >= 5 && r3calls.every((l) => l.startsWith("ssh://f@b ")), r3calls.join("\n"));
    assert.ok(r3calls.some((l) => l.includes("--label factory.machine=b")), "the agent carries its machine");
    assert.ok(!r3calls.some((l) => l.includes("OTEL_")), "no trace settings go to a worker machine");
    assert.ok(r3calls.some((l) => l.includes("-e CLAUDE_CODE_OAUTH_TOKEN")), "the model token goes to the agent");
    assert.ok(!ls(`${dir}/m/ssh___f_b/vol`).some((v) => v.startsWith("run-r3-")), "cleanup removes the volumes on b");

    // The start step checks the slots of the run's own machine. local has 1 slot.
    writeFileSync(`${dir}/m/local/agents/agent-other`, "");
    assert.equal(await startIfFree("r2", "true", "issue #2", "r2", machines), false, "local is full");
    // A failure on a worker machine names it. On local, the message stays as it was.
    assert.equal(await failureNote("r1"), " (on b)");
    assert.equal(await failureNote("r2"), "");

    // A machine that does not answer is left out of the pick. It never counts as an empty machine.
    const withDown = [{ target: "ssh://f@down", slots: 5 }, ...machines];
    assert.equal(await place("r5", withDown), "ssh://f@b", "the down machine has the most slots and no known load");
    // Finding a run: a hit counts even when another machine is down. No hit while a machine is down is an error,
    // because the run may be on that machine. Only a run that no machine holds is "not placed".
    assert.equal(await findRun("r5", withDown), "ssh://f@b");
    await assert.rejects(findRun("r-lost", withDown), /down did not answer/);
    assert.equal(await findRun("r-lost", machines), undefined);
    // The pick's step result is what later steps use, also after a restart, without asking any machine.
    remember("r6", "ssh://f@down");
    await assert.rejects(oneShot("r6", "true"), /No route to host/, "a run on a down machine fails, it does not move to local");

    // A drained machine (0 slots) still lets the runs it holds start their agents, one at a time.
    const drained = [{ target: "local", slots: 1 }, { target: "ssh://f@b", slots: 0 }];
    for (const a of ls(`${dir}/m/ssh___f_b/agents`)) rmSync(`${dir}/m/ssh___f_b/agents/${a}`);
    assert.equal(await startIfFree("r5", "true", "issue #5", "r5", drained), true, "its run finishes there");
    assert.equal(await startIfFree("r1", "true", "issue #1", "r1", drained), false, "one agent at a time");

    // The exit check: a lost connection means "still running". A real docker error still fails the step.
    assert.equal(await agentExitCode("r6", "r6"), null, "the machine of r6 does not answer");
    remember("rg", "ssh://f@b");
    await assert.rejects(agentExitCode("rg", "gone"), /No such object/);
    // The agent stops itself after the maximum run time, also when no one checks it any more.
    assert.ok(log().some((l) => /factory-runner:latest timeout --kill-after=1m 45m bash -c /.test(l)), "the agent runs under timeout");
    // Cleanup on a machine that does not answer logs it and goes on. The sweep removes the leftovers later.
    const warn = console.warn; const warned: string[] = []; console.warn = (m: string) => warned.push(m);
    try { await cleanup("r6"); } finally { console.warn = warn; }
    assert.ok(warned.some((m) => /r6/.test(m) && /down/.test(m)), warned.join("\n"));

    // Cleanup also stops the one-shot containers of the run, found by their run label.
    const sm = "ssh://f@s", only = [{ target: sm, slots: 3 }];
    mkdirSync(`${dir}/m/ssh___f_s/agents`, { recursive: true });
    writeFileSync(`${dir}/m/ssh___f_s/agents/oneshot1`, "rk 1 oneshot1\n");
    remember("rk", sm);
    await cleanup("rk");
    assert.ok(!ls(`${dir}/m/ssh___f_s/agents`).includes("oneshot1"), "the run's one-shot container is gone");

    // The sweep: containers and volumes of runs that Inngest no longer runs, older than an hour.
    for (const id of ["keep", "stale", "young"]) assert.equal(await place(id, only), sm);
    assert.equal(await startIfFree("stale", "true", "issue #9", "stale", only), true);
    assert.deepEqual(await sweep(sm, new Set(["keep"])), [], "nothing is an hour old yet");
    const later = Date.now() + 2 * 3600_000;
    const removed = await sweep(sm, new Set(["keep"]), later);
    assert.deepEqual(removed.sort(), ["agent-stale", "run-stale-tmp", "run-stale-work", "run-young-tmp", "run-young-work"]);
    assert.deepEqual(ls(`${dir}/m/ssh___f_s/vol`).sort(), ["run-keep-tmp", "run-keep-work"], "an active run keeps its volumes");

    // A machine that comes back after it did not answer is ready for a sweep, once.
    const flaky = [{ target: "ssh://f@flaky", slots: 1 }];
    mkdirSync(`${dir}/off`, { recursive: true }); writeFileSync(`${dir}/off/ssh___f_flaky`, "");
    assert.equal(await place("rf", flaky), null);
    takeReadyToSweep();
    rmSync(`${dir}/off/ssh___f_flaky`);
    assert.equal(await place("rf", flaky), "ssh://f@flaky");
    assert.deepEqual(takeReadyToSweep(), ["ssh://f@flaky"]);
    assert.deepEqual(takeReadyToSweep(), [], "once");
  } finally { process.env.PATH = path; }
}
console.log("machine checks ok");
