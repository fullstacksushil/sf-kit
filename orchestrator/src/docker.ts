import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FACTORY_NAME } from "./inngest.ts";

const exec = promisify(execFile);

// ── machines: where agent containers run ─────────────────────────────────
// FACTORY_MACHINES="local=2 ssh://factory@linux-box=3": a target and its slot count. `local` is the factory host's
// own Docker. An ssh target is a worker machine's Docker, reached with DOCKER_HOST. Without the list: local=FACTORY_SLOTS.
export const LOCAL = "local";
export type Machine = { target: string; slots: number };
// A host name, an optional port, and a user. The strict shape keeps ssh options (`-o...`) and shell text out.
const SSH_TARGET = /^ssh:\/\/[A-Za-z0-9._][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?$/;
export function parseMachines(list: string | undefined, slots: string | undefined): Machine[] {
  // An env file line `FACTORY_MACHINES=` gives an empty string. It means "not set", like a missing line.
  if (!list?.trim()) {
    if (!/^\d+$/.test(slots ?? "2")) throw new Error(`FACTORY_SLOTS: not a whole number: ${JSON.stringify(slots)}.`);
    return [{ target: LOCAL, slots: Number(slots ?? 2) }];
  }
  const bad = (why: string) => { throw new Error(`FACTORY_MACHINES: ${why}. Write it as "local=2 ssh://user@host=3".`); };
  const machines = list.split(/\s+/).filter(Boolean).map((entry) => {
    const eq = entry.lastIndexOf("="), target = entry.slice(0, eq), slotCount = entry.slice(eq + 1);
    if (eq < 0 || !/^\d+$/.test(slotCount)) bad(`no slot count in ${JSON.stringify(entry)}`);
    if (target !== LOCAL && !SSH_TARGET.test(target)) bad(`not local or ssh://user@host: ${JSON.stringify(target)}`);
    return { target, slots: Number(slotCount) };
  });
  if (!machines.length) bad("the list is empty");
  if (new Set(machines.map((m) => m.target)).size !== machines.length) bad("a machine is listed twice");
  return machines;
}
export const MACHINES = parseMachines(process.env.FACTORY_MACHINES, process.env.FACTORY_SLOTS);

// Every docker call goes through here. A call that hangs (a worker machine that sleeps) fails after the timeout.
const CALL_TIMEOUT = 60_000;
export async function dockerCall(machine: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeout?: number } = {}) {
  const timeout = opts.timeout ?? CALL_TIMEOUT;
  const env = { ...process.env, ...opts.env, ...(machine === LOCAL ? {} : { DOCKER_HOST: machine }) };
  try {
    return await exec("docker", args, { maxBuffer: 20 * 1024 * 1024, env, timeout });
  } catch (e) {
    // Node also kills the child when the output passes maxBuffer. Only a kill without that code is the timeout.
    const { killed, code } = e as { killed?: boolean; code?: unknown };
    if (killed && code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw Object.assign(new Error(`docker ${args[0]} on ${machine} timed out after ${timeout} ms.`), { code: "TIMEOUT" });
    throw e;
  }
}

// ── placement: which machine a run uses ──────────────────────────────────
// A run's two volumes live on one machine for the whole run, so every container of the run must go there.
// The volumes are also the record of where a run is: after a restart, findRun asks each machine.
const runMachine = new Map<string, string>();
const hostOf = (target: string) => target.replace(/^ssh:\/\/[^@]*@/, "").replace(/:\d+$/, "");
const lines = (out: string) => out.split("\n").map((l) => l.trim()).filter(Boolean);
// A machine that does not answer counts as "no volumes here".
const volumeNames = (machine: string, prefix: string) =>
  dockerCall(machine, ["volume", "ls", "-q", "--filter", `name=${prefix}`]).then((r) => lines(r.stdout), () => [] as string[]);

/** The machine that holds the run's volumes, or undefined. */
export async function findRun(runId: string, machines = MACHINES): Promise<string | undefined> {
  const found = await Promise.all(machines.map(async (m) => (await volumeNames(m.target, `run-${runId}-work`)).includes(`run-${runId}-work`)));
  return machines.find((_, i) => found[i])?.target;
}

/** The run's machine. A run with no volumes yet (not placed) uses local, as before machines existed. */
async function machineOf(runId: string): Promise<string> {
  const known = runMachine.get(runId) ?? await findRun(runId);
  if (known) runMachine.set(runId, known);
  return known ?? LOCAL;
}

/**
 * Pick the machine for a new run and create its volumes there. null when no machine has a slot.
 * Call it under the slot lock, so the next pick sees these volumes. A retry returns the machine already picked.
 * The load is the share of a machine's slots that its runs hold, counting runs that only prepare.
 */
export async function place(runId: string, machines = MACHINES): Promise<string | null> {
  const found = await findRun(runId, machines);
  if (found) return (runMachine.set(runId, found), found);
  const open = machines.filter((m) => m.slots > 0);
  const loads = await Promise.all(open.map(async (m) => (await volumeNames(m.target, "run-")).filter((v) => /^run-.+-work$/.test(v)).length / m.slots));
  // Least load first. On a tie, the machine with more slots.
  const best = open.map((m, i) => ({ m, load: loads[i] })).sort((a, b) => a.load - b.load || b.m.slots - a.m.slots)[0]?.m;
  if (!best) return null;
  for (const v of ["work", "tmp"]) await dockerCall(best.target, ["volume", "create", "--label", repoLabel(), `run-${runId}-${v}`]);
  runMachine.set(runId, best.target);
  return best.target;
}

/** For a failure message: " (on <host>)" for a worker machine, "" for local, so local messages stay as before. */
export async function failureNote(runId: string): Promise<string> {
  const m = await machineOf(runId);
  return m === LOCAL ? "" : ` (on ${hostOf(m)})`;
}

// Every run gets two volumes: /work (the clone) and /tmp (ticket.md, pr-body.md, evidence/, review files).
// The course's .sandcastle scripts read and write fixed /tmp paths, so they run unchanged.
const IMAGE = process.env.RUNNER_IMAGE ?? "factory-runner:latest";
const LIMITS = [
  "--network", process.env.RUNNER_NETWORK ?? "factory-net",
  "--cpus", process.env.RUNNER_CPUS ?? "4",
  "--memory", process.env.RUNNER_MEMORY ?? "8g",
  "--pids-limit", "2048",
  // An init as process 1 reaps orphans. Without it, a finished background job stays a zombie, and an agent that
  // waits with `while kill -0 $pid` waits until the container is stopped.
  "--init",
  "--security-opt", "no-new-privileges",
  "--cap-drop", "ALL",
  // Public resolvers: the run network may not reach LAN addresses, and a home router is usually the host's DNS.
  // Container names on factory-net (phoenix) still resolve through Docker's own DNS.
  ...(process.env.RUNNER_DNS ?? "1.1.1.1 8.8.8.8").split(/\s+/).filter(Boolean).flatMap((d) => ["--dns", d]),
];

// The first container of a run creates its volumes. The label lets a person list one factory's volumes.
export const volumes = (runId: string) => ["work", "tmp"].flatMap((v) => ["--mount", `type=volume,src=run-${runId}-${v},dst=/${v},volume-label=${repoLabel()}`]);
// `-e NAME` with no value copies NAME from our env, so secrets never appear in the process list.
const envFlags = (vars: Record<string, string>) => Object.keys(vars).flatMap((k) => ["-e", k]);

/** Run a short script to completion in a fresh container on the run's volumes. Returns stdout. */
// A clone plus project setup can take long. The limit only catches a call that hangs.
const ONE_SHOT_TIMEOUT = 60 * 60_000;
export async function oneShot(runId: string, script: string, vars: Record<string, string> = {}): Promise<string> {
  try {
    const { stdout } = await dockerCall(
      await machineOf(runId),
      ["run", "--rm", ...LIMITS, ...envFlags(vars), ...volumes(runId), "-w", "/work", IMAGE, "bash", "-euo", "pipefail", "-c", script],
      { env: vars, timeout: ONE_SHOT_TIMEOUT },
    );
    return stdout;
  } catch (e) {
    // ponytail: the timeout kills the docker client, not the container, which runs on until the run's cleanup.
    // The sweep of stale containers on each machine (multi-machine ticket 04) also catches it.
    if ((e as { code?: unknown }).code === "TIMEOUT") throw e; // its message already says what hung
    // Node's message holds the whole docker command and script. The failure reasons the scripts print are
    // what a person needs on GitHub, so the error carries the output tail. `code` stays for callers that test it.
    const { stdout = "", stderr = "", code } = e as { stdout?: string; stderr?: string; code?: number };
    const out = `${stdout}\n${stderr}`.trim().slice(-1500);
    throw Object.assign(new Error(out || `The script failed with exit code ${code}.`), { code });
  }
}

/** sf filters on this label. GitHub ignores case in repo names, so the value is lowercase. */
export const repoLabel = () => `factory.repo=${(process.env.GITHUB_REPO ?? "").toLowerCase()}`;

// The activity line `sf` reads: one JSON object per hook event on the container's stdout. "sf":1 comes first.
// Hook stderr stays inside Claude Code, so the hook writes to process 1's stdout, which is the `docker logs` stream.
// With --init, process 1 is docker-init, which holds the same stdout. Not tested with the OTel variables set.
// A hook never fails a tool call (exit 2 from PreToolUse would block it): jq and write errors are dropped, exit is 0.
// PostToolUseFailure and PermissionDenied close a call that PostToolUse never reports. Inputs, `tool_use_id` and
// `duration_ms` as stated on https://code.claude.com/docs/en/hooks, read on 2026-11-13.
const hook = (fields: string) => ({ hooks: [{ type: "command", command: `{ jq -c '{sf:1,t:(now|todate),ev:.hook_event_name${fields}}' > /proc/1/fd/1; } 2>/dev/null || true` }] });
const call = ",id:.tool_use_id,tool:.tool_name";
// `in`: the most useful single value of the input as plain text, else the input as JSON. Cut to 80 characters.
const input = "(.tool_input as $i | (($i | objects | .command // .file_path // .pattern // .url // .description) // ($i | tostring)) | tostring | .[0:80])";
const activitySettings = JSON.stringify({ hooks: {
  PreToolUse: [
    { matcher: "*", ...hook(`${call},in:${input}`) },
    // rtk (in the runner image) rewrites a Bash command to its shorter-output form. An image without rtk skips it.
    { matcher: "Bash", hooks: [{ type: "command", command: "if command -v rtk >/dev/null; then rtk hook claude; fi" }] },
  ],
  PostToolUse: [{ matcher: "*", ...hook(`${call},ms:.duration_ms`) }],
  // `err`: the start of the error text, so `sf logs` can say why a call failed.
  PostToolUseFailure: [{ matcher: "*", ...hook(`${call},ms:.duration_ms,err:((.error // "") | tostring | .[0:120])`) }],
  PermissionDenied: [{ matcher: "*", ...hook(call) }],
  Stop: [hook("")],
} });
// The user settings file covers plain `claude -p` and Sandcastle's agent alike. The image ships $HOME/.claude
// without a settings.json and no start script writes one. If one is there, it stays and the agent runs without the hook.
// check: a --settings file next to this user file was not tested. The hook can fire two times.
const activityHook = `if [ -e "$HOME/.claude/settings.json" ]; then echo "sf: $HOME/.claude/settings.json exists, no activity hook"
else mkdir -p "$HOME/.claude" && cat > "$HOME/.claude/settings.json" <<'SF_HOOKS'
${activitySettings}
SF_HOOKS
fi
`;

/** Start the agent in the background and return at once. */
// One run can start several agents (implement-spec: decompose, notes, merges). `agent` names the container,
// `runId` names the volumes they share.
export async function startAgent(runId: string, script: string, vars: Record<string, string>, subject: string, agent = runId): Promise<void> {
  const machine = await machineOf(runId);
  // The labels let `sf` show which ticket or PR each running agent of its repo works on, and on which machine.
  await dockerCall(
    machine,
    ["run", "-d", "--name", `agent-${agent}`, "--label", `factory.subject=${subject}`, "--label", repoLabel(), "--label", `factory.machine=${hostOf(machine)}`, ...LIMITS, ...envFlags(vars), ...volumes(runId), "-w", "/work/repo", IMAGE, "bash", "-c", activityHook + script],
    { env: vars },
  );
}

/** null while the agent runs, else its exit code. */
export async function agentExitCode(runId: string, agent: string): Promise<number | null> {
  const { stdout } = await dockerCall(await machineOf(runId), ["inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", `agent-${agent}`]);
  const [status, code] = stdout.trim().split(" ");
  return status === "exited" || status === "dead" ? Number(code) : null;
}

/** The last lines an ended agent printed, without the activity lines. For the failure message: cleanup deletes the log. */
export async function agentLogTail(runId: string, agent: string): Promise<string> {
  const { stdout, stderr } = await dockerCall(await machineOf(runId), ["logs", "--tail", "60", `agent-${agent}`]).catch(() => ({ stdout: "", stderr: "" }));
  return tailForMessage(stdout + stderr, [process.env.CLAUDE_CODE_OAUTH_TOKEN ?? ""]);
}
// The message goes into a GitHub comment, and the agent's container holds the model token: redact it.
export const tailForMessage = (log: string, secrets: string[] = []) =>
  [...secrets.filter(Boolean), /sk-ant-[\w-]+/g].reduce<string>((t, s) => t.replaceAll(s, "<redacted>"), log)
    .split("\n").filter((l) => l.trim() && !l.startsWith('{"sf":1')).slice(-8).join("\n").slice(-600).replaceAll("```", "~~~");

/** True when this run's agent container exists, running or not. */
async function agentExists(machine: string, agent: string): Promise<boolean> {
  const { stdout } = await dockerCall(machine, ["ps", "-aq", "--filter", `name=^agent-${agent}$`]);
  return stdout.trim() !== "";
}

/** Number of agent containers running on one machine, from every factory. The machine-slot count. */
export async function runningAgents(machine: string): Promise<number> {
  const { stdout } = await dockerCall(machine, ["ps", "-q", "--filter", "name=^agent-"]);
  return stdout.split("\n").filter(Boolean).length;
}

/**
 * Start the run's agent if its machine has a free slot. true: started, or started already by an earlier try.
 * Call it under the slot lock, so "count, then start" cannot race another run for the last slot.
 */
export async function startIfFree(runId: string, script: string, subject: string, agent = runId, machines = MACHINES): Promise<boolean> {
  const machine = await machineOf(runId);
  if (await agentExists(machine, agent)) return true;
  if ((await runningAgents(machine)) >= (machines.find((m) => m.target === machine)?.slots ?? 0)) return false;
  await startAgent(runId, script, agentEnv(runId, machine), subject, agent);
  return true;
}

export async function cleanup(runId: string): Promise<void> {
  const machine = await machineOf(runId);
  runMachine.delete(runId);
  // Every agent of the run: agent-<runId> and agent-<runId>-<key>.
  const { stdout } = await dockerCall(machine, ["ps", "-aq", "--filter", `name=^agent-${runId}`]).catch(() => ({ stdout: "" }));
  const ids = stdout.split("\n").filter(Boolean);
  if (ids.length) await dockerCall(machine, ["rm", "-f", ...ids]).catch(() => {});
  await dockerCall(machine, ["volume", "rm", "-f", `run-${runId}-work`, `run-${runId}-tmp`]).catch(() => {});
}

/** Model token plus optional OTLP trace export (Phoenix or self-hosted Langfuse). */
// A worker machine gets no trace settings: the trace endpoint (phoenix on the run network) exists only on the factory host.
export function agentEnv(runId: string, machine = LOCAL): Record<string, string> {
  const env: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN! };
  const endpoint = process.env.OTEL_TRACES_ENDPOINT;
  if (endpoint && machine === LOCAL) {
    Object.assign(env, {
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint,
      OTEL_RESOURCE_ATTRIBUTES: `factory.run_id=${runId},factory.name=${FACTORY_NAME}`,
    });
    if (process.env.OTEL_TRACES_HEADERS) env.OTEL_EXPORTER_OTLP_TRACES_HEADERS = process.env.OTEL_TRACES_HEADERS;
  }
  return env;
}
