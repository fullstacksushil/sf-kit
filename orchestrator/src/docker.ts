import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FACTORY_NAME } from "./inngest.ts";

const exec = promisify(execFile);

// Every run gets two volumes: /work (the clone) and /tmp (ticket.md, pr-body.md, evidence/, review files).
// The course's .sandcastle scripts read and write fixed /tmp paths, so they run unchanged.
const IMAGE = process.env.RUNNER_IMAGE ?? "factory-runner:latest";
const LIMITS = [
  "--network", process.env.RUNNER_NETWORK ?? "factory-net",
  "--cpus", process.env.RUNNER_CPUS ?? "4",
  "--memory", process.env.RUNNER_MEMORY ?? "8g",
  "--pids-limit", "2048",
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
export async function oneShot(runId: string, script: string, vars: Record<string, string> = {}): Promise<string> {
  try {
    const { stdout } = await exec(
      "docker",
      ["run", "--rm", ...LIMITS, ...envFlags(vars), ...volumes(runId), "-w", "/work", IMAGE, "bash", "-euo", "pipefail", "-c", script],
      { env: { ...process.env, ...vars }, maxBuffer: 20 * 1024 * 1024 },
    );
    return stdout;
  } catch (e) {
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
// check: tested with the image's jq and no --init (process 1 is the start script). Not tested with the OTel variables set.
const hook = (fields: string) => ({ hooks: [{ type: "command", command: `jq -c '{sf:1,t:(now|todate),ev:.hook_event_name${fields}}' > /proc/1/fd/1` }] });
const activitySettings = JSON.stringify({ hooks: {
  PreToolUse: [{ matcher: "*", ...hook(",tool:.tool_name,in:(.tool_input|tostring|.[0:80])") }],
  PostToolUse: [{ matcher: "*", ...hook(",tool:.tool_name,ms:.duration_ms") }],
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
  // The labels let `sf` show which ticket or PR each running agent of its repo works on.
  await exec(
    "docker",
    ["run", "-d", "--name", `agent-${agent}`, "--label", `factory.subject=${subject}`, "--label", repoLabel(), ...LIMITS, ...envFlags(vars), ...volumes(runId), "-w", "/work/repo", IMAGE, "bash", "-c", activityHook + script],
    { env: { ...process.env, ...vars } },
  );
}

/** null while the agent runs, else its exit code. */
export async function agentExitCode(agent: string): Promise<number | null> {
  const { stdout } = await exec("docker", ["inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", `agent-${agent}`]);
  const [status, code] = stdout.trim().split(" ");
  return status === "exited" || status === "dead" ? Number(code) : null;
}

/** True when this run's agent container exists, running or not. */
export async function agentExists(agent: string): Promise<boolean> {
  const { stdout } = await exec("docker", ["ps", "-aq", "--filter", `name=^agent-${agent}$`]);
  return stdout.trim() !== "";
}

/** Number of agent containers running on this host, from every factory. The machine-slot count. */
export async function runningAgents(): Promise<number> {
  const { stdout } = await exec("docker", ["ps", "-q", "--filter", "name=^agent-"]);
  return stdout.split("\n").filter(Boolean).length;
}

export async function cleanup(runId: string): Promise<void> {
  // Every agent of the run: agent-<runId> and agent-<runId>-<key>.
  const { stdout } = await exec("docker", ["ps", "-aq", "--filter", `name=^agent-${runId}`]).catch(() => ({ stdout: "" }));
  const ids = stdout.split("\n").filter(Boolean);
  if (ids.length) await exec("docker", ["rm", "-f", ...ids]).catch(() => {});
  await exec("docker", ["volume", "rm", "-f", `run-${runId}-work`, `run-${runId}-tmp`]).catch(() => {});
}

/** Model token plus optional OTLP trace export (Phoenix or self-hosted Langfuse). */
export function agentEnv(runId: string): Record<string, string> {
  const env: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN! };
  const endpoint = process.env.OTEL_TRACES_ENDPOINT;
  if (endpoint) {
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
