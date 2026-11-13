#!/usr/bin/env node
// sf: from an idea to merged PRs, one confirmed step at a time.
//
//   sf new <name> ["<idea>"]             a new project: React Router + TypeScript + Vitest base, agent files,
//                                        checks, first commit, optional private GitHub repo with factory labels
//   sf idea "<what you want to build>"   start: grilling, Wayfinder if needed, spec, tickets, factory
//     --recommended, -r                  grilling takes its own recommended answers and asks you only what it
//                                        cannot decide. It lists every decision at the end for you to overrule.
//   sf build "<...>"                     the same as sf idea
//   sf                                   resume from where the last step stopped
//   sf status | sf watch                 the tickets and the agents, once or live
//   sf logs <text>                       follow the actions of the agent whose subject contains <text>
//   sf retro | sf architecture | sf ratchet | sf rebase
//
// Run it in the project's root. State lives on GitHub (issues, labels, PRs). .sf/state.json keeps only
// this machine's Claude session id and the spec and map numbers. Each planning step is an interactive
// Claude session: you talk, then type /exit to come back to sf. Factory steps are labels the orchestrator reacts to.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";

const KIT = new URL("..", import.meta.url).pathname;
const SF = ".sf", STATE = `${SF}/state.json`;
const INNGEST = process.env.INNGEST_BASE_URL ?? "http://127.0.0.1:8288";
const ENV_DIR = process.env.ENV_DIR ?? "/etc/factory";
const c = { b: (s) => `\x1b[1m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, c: (s) => `\x1b[36m${s}\x1b[0m` };

// ── shell, gh, state ──────────────────────────────────────────────────────
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"], ...opts });
const tryShell = (cmd, args, opts) => { try { return sh(cmd, args, opts); } catch { return null; } };
let REPO;
const repo = () => REPO ??= (() => {
  const url = tryShell("git", ["remote", "get-url", "origin"])?.trim() ?? "";
  const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/);
  if (!m) die("This folder has no GitHub `origin` remote. Create the repo first: gh repo create <name> --private --source . --push");
  return m[1];
})();
const gh = (...args) => sh("gh", args);
const ghApi = (path, ...rest) => JSON.parse(gh("api", path, ...rest) || "null");
const ghPaged = (path) => JSON.parse(gh("api", "--paginate", "--slurp", path)).flat();

// Every folder where an idea started, so sf can point you back to one from anywhere.
const REGISTRY = `${process.env.XDG_STATE_HOME ?? `${process.env.HOME}/.local/state`}/sf/projects.json`;
const projects = () => { try { return JSON.parse(fs.readFileSync(REGISTRY, "utf8")); } catch { return []; } };
function remember() {
  const list = [...new Set([process.cwd(), ...projects()])];
  fs.mkdirSync(REGISTRY.replace(/\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify(list, null, 2) + "\n");
}
function noIdeaHere() {
  const open = projects().flatMap((dir) => {
    try { const st = JSON.parse(fs.readFileSync(`${dir}/${STATE}`, "utf8")); return st.phase === "finished" ? [] : [{ dir, st }]; } catch { return []; }
  });
  if (!open.length) die('No idea in progress here. Start one: sf idea "<what you want to build>"');
  console.error(c.r("sf: no idea in progress in this folder. sf keeps its state in each project's .sf/ folder."));
  console.error("Ideas in progress:");
  for (const { dir, st } of open) console.error(`  ${c.b(`cd ${dir} && sf`)}  ${c.d(`step "${st.phase}"${st.spec ? `, spec #${st.spec}` : ""}: ${st.idea.slice(0, 60)}`)}`);
  process.exit(1);
}

const load = () => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : null);
const save = (s) => { remember(); fs.mkdirSync(SF, { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(s, null, 2) + "\n"); };
const marker = (name) => `${SF}/${name}.json`;
const readMarker = (name) => { try { return JSON.parse(fs.readFileSync(marker(name), "utf8")); } catch { return null; } };
const clearMarker = (name) => fs.rmSync(marker(name), { force: true });

function die(msg) { console.error(c.r(`sf: ${msg}`)); process.exit(1); }

// Without a terminal, sf reads one answer per line from stdin (scripted tests). It never answers for you:
// several defaults write to GitHub, so running out of answers stops sf.
let piped;
function pipedAnswer(prompt) {
  if (!piped) { try { piped = fs.readFileSync(0, "utf8").split("\n"); } catch { piped = []; } if (piped.at(-1) === "") piped.pop(); }
  if (!piped.length) die(`No answer for: ${prompt.trim()}\nsf needs a terminal, or one piped answer per question.`);
  const a = piped.shift();
  console.log(`${prompt}${a}`);
  return a;
}

async function ask(question, choices = "Yn") {
  // choices: the first upper-case letter is the default. Returns the lower-case letter.
  const def = [...choices].find((ch) => ch === ch.toUpperCase() && /[A-Z]/.test(ch))?.toLowerCase() ?? choices[0];
  const prompt = `${c.y("?")} ${question} [${choices}] `;
  if (!process.stdin.isTTY) {
    const a = pipedAnswer(prompt).trim().toLowerCase()[0] ?? def;
    return [...choices.toLowerCase()].includes(a) ? a : def;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question(prompt, res));
  rl.close();
  const a = answer.trim().toLowerCase()[0] ?? def;
  return [...choices.toLowerCase()].includes(a) ? a : def;
}
async function askText(question) {
  if (!process.stdin.isTTY) return pipedAnswer(`${c.y("?")} ${question} `).trim();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question(`${c.y("?")} ${question} `, res));
  rl.close();
  return answer.trim();
}

/** An interactive Claude session. Returns when the user types /exit. */
function claude(args, prompt) {
  console.log(c.d(`\n── Claude session. Type /exit when this step is done, to come back to sf. ──\n`));
  const r = spawnSync("claude", [...args, prompt], { stdio: "inherit" });
  if (r.error) die(`could not start claude: ${r.error.message}`);
  console.log(c.d(`\n── back in sf ──\n`));
  return r.status;
}
/** A GitHub write that must not crash sf. Prints the error and returns false. */
function act(what, fn) {
  try { const out = fn(); if (out) console.log(String(out).trim()); return true; }
  catch (e) { console.log(c.r(`Could not ${what}: ${String(e.stderr || e.message).trim().split("\n")[0]}`)); return false; }
}
const toInt = (x) => { const n = Number(String(x).trim().replace(/^#/, "")); return Number.isInteger(n) && n > 0 ? n : null; };
/** The marker the session wrote, else the newest open issue with the label, after you confirm it. */
async function findIssue(fromMarker, label, what) {
  if (toInt(fromMarker)) return toInt(fromMarker);
  const top = JSON.parse(gh("issue", "list", "-R", repo(), "--label", label, "--state", "open", "--limit", "1", "--json", "number,title"))[0];
  if (top && (await ask(`The session did not record the ${what}. Use the newest one, #${top.number} "${top.title}"?`)) === "y") return top.number;
  return toInt(await askText(`${what} issue number?`));
}
const tail = (file, json, extra = "") =>
  `\n\n(sf) ${extra}When this step is finished, write ${file} with exactly this JSON: ${json}. Then tell me to type /exit to go back to sf.`;

// ── issues: tickets, blockers, status ────────────────────────────────────
const issue = (n) => ghApi(`repos/${repo()}/issues/${n}`);
const subIssues = (n) => ghPaged(`repos/${repo()}/issues/${n}/sub_issues?per_page=100`);
const labels = (i) => i.labels.map((l) => (typeof l === "string" ? l : l.name));

/** Blockers from the body's "## Blocked by" section, plus native dependencies when the API has them. */
function blockersFromBody(body = "") {
  const sec = body.match(/##\s*Blocked by\s*\n([\s\S]*?)(\n##\s|$)/i)?.[1] ?? body.match(/^Blocked by:(.*)$/im)?.[1] ?? "";
  return [...sec.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
}
// Native edges cost one API call per ticket, so they are cached for 5 minutes. Edges change rarely.
const nativeCache = new Map();
function nativeBlockers(n) {
  const hit = nativeCache.get(n);
  if (!hit || Date.now() - hit.at > 5 * 60_000) {
    let list;
    try { list = JSON.parse(gh("api", `repos/${repo()}/issues/${n}/dependencies/blocked_by`)).map((i) => i.number); }
    catch (e) {
      // 404: no dependencies feature, so no edges. Other errors keep the last list: a missed edge would offer a blocked ticket.
      if (!/HTTP 404/.test(String(e.stderr ?? e.message))) { if (hit) return hit.list; throw e; }
      list = [];
    }
    nativeCache.set(n, { at: Date.now(), list });
  }
  return nativeCache.get(n).list;
}

/**
 * Every ticket of the spec with its derived status. mode "spec" (the night shift) builds the tickets itself,
 * so no ticket is offered to explore, and one extra row tracks the spec's integration PR.
 */
function tickets(spec, mode = "explore") {
  let list = spec ? subIssues(spec) : [];
  if (spec && !list.length) {
    // No sub-issues: fall back to issues whose body names the spec as parent.
    list = JSON.parse(gh("issue", "list", "-R", repo(), "--state", "all", "--limit", "200", "--search", `"#${spec}" in:body`, "--json", "number,title,state,body,labels,assignees"))
      .filter((i) => i.number !== spec && /##\s*Parent[\s\S]{0,200}#/.test(i.body ?? "") && new RegExp(`#${spec}\\b`).test(i.body ?? ""));
  }
  // Only PRs from this repo's own branches. Anyone can open a fork PR that says "Closes #12", and sf offers to merge PRs.
  const prs = JSON.parse(gh("pr", "list", "-R", repo(), "--state", "open", "--limit", "100", "--json", "number,title,body,isDraft,labels,url,isCrossRepository"))
    .filter((p) => !p.isCrossRepository);
  // Issues filed or labelled on GitHub outside this spec, so sf shows all the factory's work in the repo.
  const inSpec = new Set([spec, ...list.map((i) => i.number)]);
  const others = JSON.parse(gh("issue", "list", "-R", repo(), "--state", "open", "--limit", "200", "--json", "number,title,state,body,labels,url"))
    .filter((i) => !inSpec.has(i.number) && labels(i).some((l) => OTHER_LABELS.has(l)) && !labels(i).some((l) => l === "spec" || l.startsWith("wayfinder:")))
    .map((i) => ({ ...i, other: true }));
  list = [...list, ...others];
  // PRs with a factory label that no listed issue claims, for example a review or rebase you labelled on GitHub.
  const claimed = (p) => list.some((i) => new RegExp(`(closes|fixes|resolves) #${i.number}\\b`, "i").test(p.body ?? "")) || /Implements spec #\d+\./.test(p.body ?? "");
  const prRows = prs.filter((p) => p.labels.some((l) => PR_LABELS.has(l.name)) && !claimed(p));
  const byNum = new Map(list.map((i) => [i.number, i]));
  // A blocker outside the spec. A missing one (a typo in "Blocked by") counts as open, so the ticket waits.
  const outsideOpen = (b) => { try { return isOpen(issue(b)); } catch (e) { if (/HTTP 40[34]|HTTP 410/.test(String(e.stderr ?? e.message))) return true; throw e; } };
  const isOpen = (i) => String(i.state).toLowerCase() === "open";
  const rows = [...list.map((i) => {
    const ls = labels(i);
    const blockedBy = [...new Set([...blockersFromBody(i.body), ...nativeBlockers(i.number)])];
    const openBlockers = blockedBy.filter((b) => { const x = byNum.get(b); return x ? isOpen(x) : outsideOpen(b); });
    const pr = prs.find((p) => new RegExp(`(closes|fixes|resolves) #${i.number}\\b`, "i").test(p.body ?? ""));
    const prLabels = pr ? pr.labels.map((l) => l.name) : [];
    let status;
    if (!isOpen(i)) status = "done";
    else if (ls.includes("agent:blocked")) status = "failed";
    else if (pr && prLabels.includes("agent:blocked")) status = "failed"; // the review run failed on the PR
    else if (ls.includes("needs-a-human")) status = "needs-you";
    else if (pr && (prLabels.includes("agent:review") || prLabels.includes("agent:in-progress"))) status = "reviewing";
    else if (pr && pr.isDraft) status = "pr-draft";
    else if (pr) status = "pr-ready";
    else if (ls.includes("agent:in-progress")) status = "running";
    else if (ls.includes("agent:prototype")) status = "queued-prototype";
    else if (ls.includes("prototype")) status = "prototype-ready";
    else if (ls.includes("agent:explore")) status = "queued-explore";
    else if (ls.includes("agent:implement")) status = "queued-implement";
    else if (openBlockers.length) status = "waiting";
    // An issue outside the spec is offered to the factory only when someone marked it ready-for-agent.
    else if (i.other) status = ls.includes("ready-for-agent") ? "frontier" : "needs-you";
    else status = mode === "spec" ? "night-shift" : "frontier";
    return { number: i.number, title: i.title, status, blockedBy, openBlockers, pr, other: Boolean(i.other), url: i.url ?? i.html_url ?? `https://github.com/${repo()}/issues/${i.number}` };
  }), ...prRows.map((p) => {
    const ls = p.labels.map((l) => l.name);
    const status = ls.includes("agent:blocked") ? "failed" : ls.includes("agent:review") ? "reviewing" : "running";
    return { number: p.number, title: `PR: ${p.title}`, status, blockedBy: [], openBlockers: [], pr: p, other: true, prRow: true, url: p.url };
  })].sort((a, b) => Number(a.other) - Number(b.other) || a.number - b.number);
  if (mode !== "spec" || !spec) return rows;
  // The night shift's one PR, spec/<n> -> main. Done when it merges, because its "Closes #<spec>" closes the spec.
  const sp = prs.find((p) => p.body?.includes(`Implements spec #${spec}.`));
  const spLabels = sp ? sp.labels.map((l) => l.name) : [];
  const specIssue = issue(spec), specLs = labels(specIssue);
  // The night shift labels the spec itself agent:blocked when it stops (decompose, an outside blocker, a push).
  const specStopped = specLs.includes("agent:blocked") && !specLs.includes("agent:in-progress");
  const status = !isOpen(specIssue) ? "done" : specStopped || spLabels.includes("agent:blocked") ? "failed" : !sp ? "night-shift"
    : spLabels.includes("agent:review") || spLabels.includes("agent:in-progress") ? "reviewing" : sp.isDraft ? "pr-draft" : "pr-ready";
  rows.push({ number: spec, title: "Spec PR: every ticket, merged on the integration branch", status, blockedBy: [], openBlockers: [], pr: sp, specRow: true,
    url: `https://github.com/${repo()}/issues/${spec}` });
  return rows;
}

/** Labels that put a PR on the board when no listed issue claims it. */
const PR_LABELS = new Set(["agent:review", "agent:rebase", "agent:in-progress", "agent:blocked"]);
/** Labels that make an issue outside the spec part of the factory's work. */
const OTHER_LABELS = new Set(["ready-for-agent", "agent:explore", "agent:implement", "agent:prototype", "agent:in-progress", "agent:blocked", "needs-a-human", "prototype"]);
/** The spec's own tickets. Issues from outside the spec never hold the spec open. */
const specRows = (list) => list.filter((t) => !t.other);

// [text, colour]. Padding happens before colouring, because escape codes break padEnd.
const STATUS = {
  done: ["✓ done", c.g], frontier: ["● ready", c.c], waiting: ["◌ waiting", c.d], "queued-explore": ["… explore queued", String],
  "queued-implement": ["… implement queued", String], running: ["▶ agent running", c.y], "pr-draft": ["◐ draft PR", String],
  reviewing: ["▶ reviewing", c.y], "pr-ready": ["★ PR ready for you", (x) => c.b(c.g(x))], "queued-prototype": ["… prototype queued", String],
  "prototype-ready": ["◐ prototype to see", (x) => c.b(c.c(x))], "night-shift": ["… night shift", String], "needs-you": ["? needs you", (x) => c.b(c.y(x))],
  failed: ["✗ failed", c.r],
};
const statusCell = (s) => STATUS[s][1](STATUS[s][0].padEnd(20));
const GATES = new Set(["pr-ready", "needs-you", "failed", "prototype-ready"]);

// ── agents: docker containers labelled by the orchestrator ───────────────
// Agent text is untrusted: drop escape sequences, control and bidi characters before it reaches the terminal.
const clean = (s) => String(s ?? "").replace(/\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)?)/g, "").replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ");
// A subject as one shell word, safe to paste: single quotes, each ' written as '\''.
const shellWord = (s) => `'${clean(s).replace(/'/g, `'\\''`)}'`;
// An activity line, written by the agent container's hook: {"sf":1,"t":...,"ev":...}. Other JSON is not one.
const activityLine = (l) => { if (!l.startsWith('{"sf":1,')) return null; try { return JSON.parse(l); } catch { return null; } };
const dur = (ms) => (!Number.isFinite(ms) ? "?" : ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}s`);
// A multi-line value (a heredoc, a long command) shows on one line: each whitespace run is one space.
const action = (e) => `${clean(e.tool).padEnd(6)} ${clean(e.in).replace(/\s+/g, " ").trim()}`;
/** Current action (the last open PreToolUse), the last 3 closed ones, and Stop. Stop closes every open call. */
const CLOSE = new Set(["PostToolUse", "PostToolUseFailure", "PermissionDenied"]);
function activity(events) {
  let open = [], stop = false;
  const done = [];
  for (const e of events) {
    stop = e.ev === "Stop";
    if (stop) open = [];
    if (e.ev === "PreToolUse") open.push(e);
    if (!CLOSE.has(e.ev)) continue;
    // A line with an id closes that call. A line from an older hook has none: pair the oldest open call of the tool.
    const i = open.findIndex((o) => (e.id ? o.id === e.id : o.tool === e.tool));
    if (i >= 0) done.push({ ...open.splice(i, 1)[0], ms: Number(e.ms), end: e.ev });
  }
  return { now: stop ? null : open.at(-1), done: done.slice(-3).reverse(), stop };
}
function agents() {
  const out = tryShell("docker", ["ps", "--filter", `label=factory.repo=${repo().toLowerCase()}`, "--format", '{{.Names}}\t{{.Label "factory.subject"}}\t{{.RunningFor}}']);
  if (out === null) return null; // no docker access here: the factory runs elsewhere
  return out.trim().split("\n").filter(Boolean).map((l) => {
    const [name, subject, since] = l.split("\t");
    // ponytail: 200 lines bound the read. A run with more Sandcastle noise than that shows fewer finished actions.
    // Upgrade path: read with --since from the container start, or have the hook write to a file of its own.
    const r = spawnSync("docker", ["logs", "--tail", "200", name], { encoding: "utf8" });
    const raw = `${r.stdout ?? ""}${r.stderr ?? ""}`.split("\n").map((s) => s.trim()).filter(Boolean);
    const events = raw.map(activityLine).filter(Boolean);
    if (!events.length) return { name, subject, since, lines: raw.slice(-4).map((s) => clean(s).trim()) }; // an old container: no hook
    const { now, done, stop } = activity(events);
    const lines = [
      ...(stop ? ["finishing: the agent stopped"] : []),
      ...(now ? [`now  ${action(now)} · ${dur(Date.now() - Date.parse(now.t))}`] : []),
      ...done.map((d) => `${d.end === "PostToolUse" ? "done" : "fail"} ${action(d)} · ${d.end === "PermissionDenied" ? "denied" : dur(d.ms)}`),
    ];
    return { name, subject, since, lines };
  });
}
/** sf logs: every log line of one agent as it comes. Activity lines in readable form, other lines cleaned. */
function followActivity(name) {
  const p = spawn("docker", ["logs", "-f", "--tail", "200", name], { stdio: ["ignore", "pipe", "pipe"] });
  const show = (l) => {
    const e = activityLine(l.trim());
    if (!e) return console.log(clean(l));
    const t = new Date(e.t), at = isNaN(t) ? "--:--:--" : t.toLocaleTimeString();
    console.log(`${c.d(at)} ${e.ev === "PreToolUse" ? `${c.y("▶")} ${action(e)}` : e.ev === "PostToolUse" ? `${c.g("✓")} ${clean(e.tool).padEnd(6)} ${dur(Number(e.ms))}` : e.ev === "Stop" ? c.b("■ stop") : clean(e.ev)}`);
  };
  for (const s of [p.stdout, p.stderr]) readline.createInterface({ input: s }).on("line", show);
}

// ── runs: the factory's Inngest runs, so a run with no agent container (prepare, push, a wait) shows too ──
// Read-only GraphQL. One deadline per board bounds the requests, so a slow Inngest cannot stall the refresh.
// check: read on this host on 2026-11-13 from the live self-hosted Inngest, not from docs: POST /v0/gql with no key,
// `apps { id externalID }`, the `runs` filter (from: Time!, appIDs: [UUID!], status), `run(runID:) { trace }` and
// `runTrigger(runID:) { payloads }` (a list of JSON event strings).
const gql = (query, signal, variables = {}) => fetch(`${INNGEST}/v0/gql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }), signal })
  .then((r) => r.json()).then((j) => j.data ?? Promise.reject(new Error("no data")));
const DONE = new Set(["COMPLETED", "FAILED", "CANCELLED", "SKIPPED"]);
/** The RUNNING and QUEUED runs, or a string that says why there are none to show. undefined: no block. */
async function runs() {
  if (process.env.SF_ORCHESTRATOR_URL && !process.env.INNGEST_BASE_URL) return undefined; // another machine and no Inngest URL: nothing to ask
  const name = FACTORY?.name ?? (process.env.SF_ORCHESTRATOR_URL ? process.env.SF_FACTORY : factoryFile()?.slice(0, -4)), app = `software-factory-${name}`;
  if (!name) return "no factory found for this repo.";
  const signal = AbortSignal.timeout(2000), from = new Date(Date.now() - 7 * 86_400_000).toISOString();
  try {
    const id = (await gql("{ apps { id externalID } }", signal)).apps.find((a) => a.externalID === app)?.id;
    if (!id) return `Inngest has no app ${app}.`;
    const edges = (await gql(`query($from: Time!, $app: UUID!) { runs(first: 11, orderBy: [{field: QUEUED_AT, direction: DESC}], filter: {from: $from, appIDs: [$app], status: [RUNNING, QUEUED]}) { edges { node { id status startedAt function { name } } } } }`, signal, { from, app: id })).runs.edges;
    const list = edges.map((e) => e.node).filter((r) => r.function?.name !== "github-poll").slice(0, 10);
    // One request per run: a run Inngest cannot find (a queued one) fails the whole request, so runs are not batched.
    return await Promise.all(list.map(async (r) => {
      const d = await gql("query($id: String!) { run(runID: $id) { trace { childrenSpans { name status stepOp attempts startedAt endedAt } } } t: runTrigger(runID: $id) { payloads } }", signal, { id: r.id }).catch(() => null);
      let ev = {}; try { ev = JSON.parse(d?.t?.payloads?.[0] ?? "{}")?.data ?? {}; } catch {}
      // check: seen on 2026-11-13, a RUNNING run lists only finished steps plus "Execution" (stepOp null). Not seen: a step.sleep span.
      // So the row names the last finished step and the time since it ended. The unfinished-step branch is an assumed shape.
      const steps = (d?.run?.trace?.childrenSpans ?? []).filter((s) => s.stepOp), now = steps.findLast((s) => !DONE.has(s.status)), last = steps.findLast((s) => DONE.has(s.status));
      const ms = (t) => Date.now() - Date.parse(t);
      const step = now ? `step ${clean(now.name)} · ${dur(ms(now.startedAt))}${now.attempts > 0 ? ` · attempt ${now.attempts}` : ""}`
        : last ? `last step ${clean(last.name)} ended ${dur(ms(last.endedAt))} ago` : r.status === "QUEUED" ? "queued" : "starting";
      const subject = Number.isInteger(ev.issueNumber) ? `#${ev.issueNumber}` : Number.isInteger(ev.prNumber) ? `PR #${ev.prNumber}` : "";
      return { fn: clean(r.function?.name), subject, step, age: r.startedAt ? ` · run ${dur(ms(r.startedAt))}` : "" };
    }));
  } catch { return `Inngest at ${INNGEST} does not answer.`; }
}

// The factory that serves this repo: its env file in $ENV_DIR/factories has GITHUB_REPO = origin. Name = file name.
const envValue = (file, key) => { try { return fs.readFileSync(file, "utf8").match(new RegExp(`^${key}=['"]?([^'"\\n]+)`, "m"))?.[1]; } catch { return undefined; } };
/** The env file name of the factory that serves this repo, or undefined. Never stops sf. */
function factoryFile() {
  let files = []; try { files = fs.readdirSync(`${ENV_DIR}/factories`).filter((f) => f.endsWith(".env")).sort(); } catch {}
  return files.find((f) => envValue(`${ENV_DIR}/factories/${f}`, "GITHUB_REPO")?.toLowerCase() === repo().toLowerCase());
}
function findFactory() {
  const f = factoryFile();
  if (!f) return undefined;
  const file = `${ENV_DIR}/factories/${f}`, port = envValue(file, "PORT") ?? die(`No PORT in ${file}. Add the factory's port, for example PORT=3001.`);
  return { name: f.slice(0, -4), url: `http://127.0.0.1:${port}` };
}
let FACTORY;
async function factory() {
  if (FACTORY) return FACTORY;
  if (process.env.SF_ORCHESTRATOR_URL) return FACTORY = { name: process.env.SF_FACTORY ?? die("SF_ORCHESTRATOR_URL needs SF_FACTORY, the factory name for event names."), url: process.env.SF_ORCHESTRATOR_URL };
  FACTORY = findFactory();
  if (!FACTORY) {
    const wiz = process.env.SF_WIZARD ?? `${KIT}setup-wizard.sh`, cmd = `${wiz} --repo ${repo()}`;
    if ((await ask(`No factory serves ${repo()}. Set one up now?`)) !== "y") die(`Run: ${cmd}`);
    spawnSync(wiz, ["--repo", repo()], { stdio: "inherit" });
    FACTORY = findFactory() ?? die(`Still no factory for ${repo()}. Run: ${cmd}`);
  }
  return FACTORY;
}

async function factoryUp() {
  const { url } = await factory();
  try { await fetch(`${url}/api/inngest`, { signal: AbortSignal.timeout(2000) }); return true; } catch { return false; }
}

// ── rendering ────────────────────────────────────────────────────────────
// check once per process. Never fails: no herdr, a failing herdr or a linked plugin all give no hint.
let herdrHint;
function herdrNote() {
  if (herdrHint === undefined) {
    const out = tryShell("herdr", ["plugin", "list"], { timeout: 1000 }); // check: output format read on 2026-11-13: "- <id> (<name>) enabled [source]"
    herdrHint = out !== null && !/^- sf /m.test(out) ? c.d(`The herdr plugin lets you pick and follow an agent in herdr: herdr plugin link ${KIT}herdr-plugin`) : "";
  }
  return herdrHint;
}
function render(st, list, ags, rns) {
  const w = Math.max(60, process.stdout.columns ?? 100);
  const cut = (s, n = w - 4) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const out = [];
  out.push(c.b(`sf · ${repo()}`) + c.d(`${st.spec ? `  ·  spec #${st.spec}` : ""}  ·  Inngest ${INNGEST}  ·  ${new Date().toLocaleTimeString()}`));
  if (st.idea) out.push(c.d(cut(`idea: ${st.idea}`)));
  out.push("");
  const row = (t) => {
    const extra = t.status === "waiting" ? c.d(` blocked by ${t.openBlockers.map((b) => `#${b}`).join(", ")}`) : t.pr ? c.d(` PR #${t.pr.number}`) : "";
    out.push(`  ${(t.specRow ? "spec" : `#${t.number}`).padEnd(6)} ${statusCell(t.status)} ${cut(t.title, w - 50)}${extra}`);
  };
  if (st.spec) {
    const own = specRows(list), real = own.filter((t) => !t.specRow), done = real.filter((t) => t.status === "done").length;
    out.push(c.b(`Tickets ${done}/${real.length} done`) + c.d(st.mode === "spec" ? "  ·  night shift: the factory builds them into one PR" : ""));
    own.forEach(row);
    out.push("");
  }
  const others = list.filter((t) => t.other);
  out.push(c.b(`Other issues and PRs ${others.length}`) + c.d("  ·  open, with a factory label, outside any spec sf runs"));
  if (!others.length) out.push(c.d("  none. Label an issue ready-for-agent on GitHub, and sf offers it to the factory."));
  others.forEach(row);
  out.push("");
  if (typeof rns === "string") out.push(c.d(`Runs: ${rns}`));
  else if (rns && !rns.length) out.push(c.d("Runs: none running or queued."));
  else if (rns) {
    out.push(c.b(`Runs ${rns.length}`) + c.d("  ·  from Inngest"));
    for (const r of rns) out.push(cut(`  ${c.c("▷")} ${[r.fn, r.subject].filter(Boolean).join(" ")} ${c.d(`· ${r.step}${r.age}`)}`, w + 20));
  }
  if (ags === null) out.push(c.d("Agents: no docker access on this machine. Open the Inngest dashboard for runs."));
  else if (!ags.length) out.push(c.d("Agents: none running."));
  else {
    out.push(c.b(`Agents running: ${ags.length}`));
    for (const a of ags) {
      out.push(`  ${c.y("▶")} ${clean(a.subject)} ${c.d(`· ${clean(a.since)} · sf logs ${shellWord(a.subject)}`)}`);
      for (const l of a.lines) out.push(c.d(`      ${cut(l, w - 8)}`));
    }
  }
  if (herdrNote()) out.push(herdrNote());
  return out.join("\n");
}

/** Live view. Returns when a ticket needs you, a new ticket reaches the frontier, or you press q. */
const lastStatus = new Map();
async function watch(st, { skip = new Set(), once = false } = {}) {
  const tty = process.stdout.isTTY && process.stdin.isTTY;
  let quit = false;
  if (tty && !once) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKey);
  }
  function onKey(_s, k) { if (k?.name === "q" || (k?.ctrl && k.name === "c")) quit = true; }
  try {
    for (;;) {
      const list = tickets(st.spec, st.mode), ags = agents(), rns = await runs();
      // A skip lasts while the status lasts. Prototype v2 is "prototype-ready" again, after a run in between.
      for (const t of list) {
        if (lastStatus.has(t.number) && lastStatus.get(t.number) !== t.status) for (const k of skip) if (k.startsWith(`${t.number}:`)) skip.delete(k);
        lastStatus.set(t.number, t.status);
      }
      if (tty) process.stdout.write("\x1b[2J\x1b[H");
      console.log(render(st, list, ags, rns));
      if (once) return list;
      const gates = list.filter((t) => GATES.has(t.status) && !skip.has(`${t.number}:${t.status}`));
      const frontier = list.filter((t) => t.status === "frontier" && !skip.has(`${t.number}:frontier`));
      const own = specRows(list), finished = Boolean(st.spec) && own.length > 0 && own.every((t) => t.status === "done");
      if (gates.length || frontier.length || finished) { if (tty) process.stdout.write("\x07"); return list; }
      console.log(c.d("\nWatching. sf stops here when something needs you. Press q to go back to the menu."));
      for (let i = 0; i < 20 && !quit; i++) await new Promise((r) => setTimeout(r, 500)); // refresh every 10 s
      if (quit) return list;
    }
  } finally {
    if (tty && !once) { process.stdin.off("keypress", onKey); process.stdin.setRawMode(false); process.stdin.pause(); }
  }
}

// ── the pipeline ─────────────────────────────────────────────────────────
// ── sf new ────────────────────────────────────────────────────────────────

/** A factory-ready project: the base the agents build on, with the checks they run, committed and optionally on GitHub. */
async function newProject(dir, idea, recommended = false) {
  if (!/^[A-Za-z0-9._-]+$/.test(dir ?? "")) die('Give a folder name: sf new <name> ["<idea>"]. Letters, digits, . _ and - only.');
  if (fs.existsSync(dir)) die(`${dir} exists already. sf new starts a fresh project. For an existing one, run sf-kit/init-project.sh.`);
  const run = (what, cmd, args) => {
    console.log(c.b(`\n· ${what}`));
    // No stdin for the tools: npm and npx would read the answers meant for sf.
    if (spawnSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"] }).status !== 0) die(`${what} failed. Fix the cause, delete ${dir}, then run sf new again.`);
  };
  run("React Router + TypeScript base", "npx", ["-y", "create-react-router@latest", dir, "--yes", "--no-git-init", "--no-install"]);
  process.chdir(dir);
  // The agents run `npm run check` before each commit, and `npm run build` must pass too.
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  Object.assign(pkg.scripts, { test: "vitest run --passWithNoTests", check: "npm run typecheck && npm run test" });
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
  run("Agent files, skills and agent scripts", `${KIT}init-project.sh`, ["--path", "."]);
  const edit = (file, pairs) => { let t = fs.readFileSync(file, "utf8"); for (const [a, b] of pairs) t = t.replace(a, b); fs.writeFileSync(file, t); };
  edit("AGENTS.md", [
    ["<!-- CHANGEME: list the checks that npm run check chains (format, lint, types, boundaries, tests). -->",
      "`npm run check` runs `typecheck` (React Router typegen, then `tsc`), then `test` (Vitest). `npm run build` must pass too."],
    ["| <!-- CHANGEME --> | |", "| `+types` imports fail | Run `npm run typecheck`. It generates the route types first. |"],
  ]);
  edit("GLOSSARY.md", [["<!-- CHANGEME: product name -->", dir]]);
  if (!/^\/?node_modules\/?$/m.test(fs.readFileSync(".gitignore", "utf8"))) fs.appendFileSync(".gitignore", "node_modules/\n");
  run("Dependencies", "npm", ["i", "--no-audit", "--no-fund"]);
  run("Agent runner dependencies", "npm", ["i", "-D", "--no-audit", "--no-fund", "@ai-hero/sandcastle@^0.14", "tsx", "zod@^3.25", "vitest"]);
  run("npm run check", "npm", ["run", "check"]);
  run("npm run build", "npm", ["run", "build"]);
  // init-project.sh may have run git init already. Either way the branch is main.
  if (!fs.existsSync(".git")) sh("git", ["init", "-q"]);
  sh("git", ["symbolic-ref", "HEAD", "refs/heads/main"]);
  console.log(c.b("\n· First commit"));
  sh("git", ["add", "-A"]);
  sh("git", ["commit", "-qm", "Factory-ready base: React Router, TypeScript, Vitest, agent files"]);
  console.log(c.g(`\n${dir} is ready: npm run check and npm run build pass.`));

  const login = tryShell("gh", ["api", "user", "--jq", ".login"])?.trim();
  if (login && (await ask(`Create the private GitHub repo ${login}/${dir}, push, and add the factory labels?`)) === "y") {
    run("GitHub repo", "gh", ["repo", "create", `${login}/${dir}`, "--private", "--source", ".", "--push"]);
    run("Factory labels", `${KIT}init-project.sh`, ["--path", ".", "--labels-only"]);
    console.log(c.d(`Add its factory: ${KIT}setup-wizard.sh --repo ${login}/${dir}`));
  } else {
    console.log(c.d(`Later: gh repo create <owner>/${dir} --private --source . --push, then ${KIT}init-project.sh --path . --labels-only`));
  }
  if (idea && tryShell("git", ["remote", "get-url", "origin"]) && (await ask("Start the idea now?")) === "y") return startIdea(idea, recommended);
  console.log(`\nNext: ${c.b(`cd ${dir} && sf idea ${recommended ? "--recommended " : ""}"${idea ?? "<what you want to build>"}"`)}`);
}

async function preflight() {
  for (const [bin, hint] of [["gh", "https://cli.github.com"], ["claude", "npm i -g @anthropic-ai/claude-code"], ["git", ""]])
    if (tryShell(bin, ["--version"]) === null) die(`${bin} is missing. ${hint}`);
  if (tryShell("gh", ["auth", "status"]) === null) die("gh is not signed in. Run: gh auth login");
  if (!fs.existsSync(".claude/skills/grill-with-docs") && !fs.existsSync(".agents/skills/grill-with-docs"))
    die("The skills are not in this repo. For a new project run: sf new <name>. For an existing one: sf-kit/init-project.sh --path . --labels");
  if (!fs.existsSync(".claude/skills")) console.log(c.y("Warning: no .claude/skills link, so Claude Code may not find the skills. Rerun init-project.sh."));
  repo();
}

// --recommended: the grilling decides with its own recommendations and asks only what it cannot decide.
const RECOMMENDED = `

Recommended mode: for each question you would ask me, take your own recommended answer. State the question and \
your answer in one line, record it the way the skill says (GLOSSARY.md, an ADR), and go to the next question \
without waiting for me. Ask me only for what you cannot decide: a fact only I know (users, budget, accounts, \
names), or a choice that is hard to reverse and has no clear recommendation. At the end, list every decision \
you took for me, numbered, so I can overrule any of them before I type /exit.`;

/**
 * The agents clone from GitHub, so the glossary, standards, ADRs and docs the planning sessions wrote must be on
 * GitHub before the factory starts. True when they are. Commits only those paths: code changes stay yours.
 * Pulls before it pushes, so docs the factory merged meanwhile (its PRs update the glossary too) come in first.
 */
const DOC_PATHS = ["GLOSSARY.md", "CODING_STANDARDS.md", "docs", "CONTEXT.md", "CONTEXT-MAP.md"];
async function docsOnGitHub(what) {
  const paths = DOC_PATHS.filter((p) => fs.existsSync(p));
  const changed = tryShell("git", ["status", "--porcelain", "--", ...paths])?.trim();
  if (changed) {
    console.log(`${what} changed these files. The factory's agents read them from GitHub:\n${c.d(changed)}`);
    if ((await ask("Commit them now?")) !== "y") { console.log(c.y("The agents will not see them until you commit and push.")); return false; }
    // Only paths git tracks after the add: an empty docs/ folder is not one, and would fail the commit.
    if (!act("commit the docs", () => {
      sh("git", ["add", "--", ...paths]);
      const tracked = paths.filter((p) => sh("git", ["ls-files", "--", p]).trim());
      return sh("git", ["commit", "-qm", `docs: ${what.toLowerCase()}`, "--", ...tracked]);
    })) return false;
  }
  if (tryShell("git", ["rev-parse", "--abbrev-ref", "@{u}"]) === null) {
    console.log(c.y("This branch has no upstream on GitHub. Push it once: git push -u origin HEAD")); return false;
  }
  if (!act("fetch", () => sh("git", ["fetch", "-q"]))) return false;
  if (Number(sh("git", ["rev-list", "--count", "HEAD..@{u}"])) > 0) {
    console.log(c.d("GitHub has newer commits. Pulling them first."));
    if (tryShell("git", ["pull", "--rebase", "--autostash", "-q"]) === null) {
      tryShell("git", ["rebase", "--abort"]);
      console.log(c.y("Your commits conflict with GitHub (often GLOSSARY.md: the factory's PRs add terms too)."));
      console.log(c.y("Run git pull, merge the files by hand, commit, then run sf again."));
      return false;
    }
  }
  const unpushed = tryShell("git", ["diff", "--name-only", "@{u}", "HEAD", "--", ...paths])?.trim();
  if (!unpushed) return true;
  console.log(`Not on GitHub yet:\n${c.d(unpushed)}\nCommits to push:\n${c.d(sh("git", ["log", "--oneline", "@{u}..HEAD"]).trim())}`);
  if ((await ask("Push them now?")) !== "y") { console.log(c.y("The agents will not see them until you push.")); return false; }
  return act("push", () => sh("git", ["push", "-q"]));
}

async function phaseGrill(st) {
  console.log(`${c.b("Step 1 · Grilling")}  Claude interviews you about the idea with /grill-with-docs.`);
  console.log(c.d("It writes GLOSSARY.md and ADRs as you decide, and judges if the plan needs a Wayfinder map."));
  if ((await ask("Start the grilling session?")) !== "y") return false;
  clearMarker("grill");
  const first = !st.grilled;
  const status = claude(first ? ["--session-id", st.session] : ["--resume", st.session],
    (first ? `/grill-with-docs ${st.idea}` : "Let's continue the grilling.") + (st.recommended ? RECOMMENDED : "") +
    tail(marker("grill"), `{"wayfinder": true or false, "why": "<one sentence>"}`,
      "Set wayfinder to true only if settling the open decisions needs more than one agent session. "));
  // Only a session that ran can be resumed. If claude failed to start, the next try starts it fresh.
  if (status === 0) { st.grilled = true; save(st); }
  else { console.log(c.r(`Claude exited with status ${status}.`)); return (await ask("Try the grilling session again?")) === "y"; }
  const m = readMarker("grill");
  if (!m && (await ask("The session did not record a result. Is the grilling finished?", "yN")) !== "y") return true;
  await docsOnGitHub("The grilling");
  const suggest = m?.wayfinder ? "y" : "n";
  console.log(m ? `The agent suggests ${m.wayfinder ? c.b("a Wayfinder map") : c.b("going straight to a spec")}: ${m.why}` : "");
  // Recommended mode takes the agent's suggestion here too, when it made one.
  const big = st.recommended && m ? suggest : await ask("Plan it as a Wayfinder map first?", suggest === "y" ? "Yn" : "yN");
  st.phase = big === "y" ? "wayfinder" : "spec"; save(st);
  return true;
}

async function phaseWayfinder(st) {
  if (!st.map) {
    console.log(`${c.b("Step 2 · Wayfinder")}  Chart the map: one issue that links the open decision tickets.`);
    if ((await ask("Chart the map in the same Claude session?")) !== "y") return false;
    clearMarker("map");
    claude(["--resume", st.session], `/wayfinder Chart the map for the idea we just grilled.` + tail(marker("map"), `{"map": <the map issue number>}`));
    st.map = await findIssue(readMarker("map")?.map, "wayfinder:map", "Wayfinder map");
    if (!st.map) die("No map issue. Run sf again to retry.");
    save(st);
  }
  for (;;) {
    const kids = subIssues(st.map), open = kids.filter((k) => k.state === "open");
    const openNums = new Set(open.map((k) => k.number));
    const rows = open.map((k) => {
      const blocked = [...new Set([...blockersFromBody(k.body), ...nativeBlockers(k.number)])].filter((b) => openNums.has(b));
      return { k, type: (labels(k).find((l) => l.startsWith("wayfinder:")) ?? "wayfinder:?").slice(10), blocked, claimed: k.assignees?.length > 0 };
    });
    console.log(`\n${c.b(`Wayfinder map #${st.map}`)}  ${kids.length - open.length}/${kids.length} decisions made`);
    for (const r of rows) console.log(`  #${String(r.k.number).padEnd(5)} ${r.type.padEnd(10)} ${r.blocked.length ? c.d(`waiting on ${r.blocked.map((b) => `#${b}`).join(", ")}`) : r.claimed ? c.y("claimed") : c.c("ready")}  ${r.k.title}`);
    if (!open.length) { console.log(c.g("The map is clear: every decision is made.")); await docsOnGitHub("The Wayfinder map"); st.phase = "spec"; save(st); return true; }
    const frontier = rows.filter((r) => !r.blocked.length && !r.claimed);
    if (!frontier.length) {
      const a = await ask("No unclaimed ticket is ready. [r]efresh, [w]ork a claimed one, or [q]uit?", "Rwq");
      if (a === "q") return false;
      if (a === "r") continue;
    }
    const next = frontier[0] ?? rows.find((r) => !r.blocked.length) ?? rows[0];
    const proto = next.type === "prototype";
    const a = await ask(`Work "${next.k.title}" (${next.type}) in a fresh session? [y]es, [p]ick another, ${proto ? "[f]actory builds the prototype, " : ""}[q]uit`, proto ? "Ypfq" : "Ypq");
    if (a === "q") return false;
    if (a === "f") {
      // The factory's prototype task: screenshots on the ticket, then a session settles the decision with them.
      act(`label #${next.k.number}`, () => gh("issue", "edit", String(next.k.number), "-R", repo(), "--add-label", "agent:prototype"));
      console.log(c.d("Sent. When the screenshots are on the ticket, work it again here to settle the decision."));
      if ((await ask("Back to the map, or [q]uit for now?", "Bq")) === "q") return false;
      continue;
    }
    const n = a === "p" ? toInt(await askText("Ticket number?")) : next.k.number;
    if (!n) { console.log(c.r("That is not an issue number.")); continue; }
    claude([], `/wayfinder https://github.com/${repo()}/issues/${st.map} Work ticket #${n}.\n\n(sf) Type /exit when the ticket is resolved.`);
  }
}

async function phaseSpec(st) {
  console.log(`${c.b("Step 3 · Spec")}  /to-spec writes the spec issue from ${st.map ? `the Wayfinder map #${st.map}` : "the grilling session"}.`);
  if ((await ask("Write the spec?")) !== "y") return false;
  clearMarker("spec");
  const args = st.map ? ["--session-id", (st.specSession = randomUUID())] : ["--resume", st.session];
  if (st.map) save(st);
  claude(args, (st.map ? `/to-spec Read the Wayfinder map #${st.map} and its closed tickets first. They hold the decisions.` : "/to-spec") +
    tail(marker("spec"), `{"spec": <the spec issue number>}`, "Label the spec issue `spec` and `ready-for-agent`. "));
  st.spec = await findIssue(readMarker("spec")?.spec, "spec", "spec");
  if (!st.spec) die("No spec issue. Run sf again to retry.");
  st.phase = "tickets"; save(st);
  return true;
}

async function phaseTickets(st) {
  console.log(`${c.b("Step 4 · Tickets")}  /to-tickets splits spec #${st.spec} into tracer-bullet tickets with blocking edges. You approve the split.`);
  if ((await ask("Write the tickets?")) !== "y") return false;
  claude(["--resume", st.specSession ?? st.session],
    `/to-tickets #${st.spec}\n\n(sf) Follow docs/agents/issue-tracker.md: each ticket is a sub-issue of #${st.spec}, with native blocking edges and a "## Blocked by" section. When the tickets are published, tell me to type /exit to go back to sf.`);
  const list = tickets(st.spec, st.mode);
  if (!list.length) { console.log(c.r(`No tickets found under spec #${st.spec}.`)); return (await ask("Try again?")) === "y"; }
  await watch(st, { once: true });
  console.log(`\n${c.b("How should the factory build them?")}`);
  console.log("  [e] Explore each ticket first. One PR per ticket, and you merge each one. Every ticket gets the explore brake.");
  console.log("  [n] Night shift (agent:implement-spec). The factory builds every ticket into the spec/" + st.spec + " branch, then opens one PR for you.");
  console.log(c.d("      Faster, and you review once. Use it when the tickets came from a careful spec."));
  st.mode = (await ask("Build mode?", "En")) === "n" ? "spec" : "explore";
  st.phase = "build"; save(st);
  return true;
}

async function phaseBuild(st) {
  if (!(await factoryUp())) {
    const { url } = await factory();
    console.log(c.y(`The factory does not answer at ${url}.`));
    console.log(c.d("Set it up with sf-kit/init-host.sh and sf-kit/setup-wizard.sh. Without a public webhook URL, set GITHUB_POLL=1 in the factory env file in /etc/factory/factories."));
    if ((await ask("Continue anyway (labels wait until the factory runs)?", "yN")) !== "y") return false;
  }
  // The gate before any label: an agent that clones without the planning docs builds on guesses.
  if (!(await docsOnGitHub("Planning"))) { console.log(c.y("The factory starts when the docs are on GitHub. Run sf again then.")); return false; }
  const skip = new Set();
  if (st.mode === "spec" && !st.nightShiftStarted) {
    if ((await ask(`Start the night shift on spec #${st.spec} (label agent:implement-spec)?`)) !== "y") return false;
    if (act(`label spec #${st.spec}`, () => gh("issue", "edit", String(st.spec), "-R", repo(), "--add-label", "agent:implement-spec"))) { st.nightShiftStarted = true; save(st); }
  }
  for (;;) {
    const list = await watch(st, { skip });
    const own = specRows(list);
    if (st.spec && own.length && own.every((t) => t.status === "done")) { st.phase = "done"; save(st); return true; }
    let acted = false;

    const frontier = list.filter((t) => t.status === "frontier" && !skip.has(`${t.number}:frontier`));
    if (frontier.length) {
      console.log(`\n${c.b("Ready to start:")} ${frontier.map((t) => `#${t.number} ${t.title}`).join(" · ")}`);
      console.log(c.d("The factory explores each one first. Easy calls go on to implement and review. The rest come back to you."));
      if (frontier.some((t) => t.other)) console.log(c.d("ready-for-agent alone starts nothing. sf adds agent:explore, which starts the run."));
      const a = await ask(`Send ${frontier.length} ticket(s) to the factory with agent:explore? [y]es, [p]ick, [n]ot now, [q]uit`, "Ypnq");
      if (a === "q") return false;
      const ready = frontier.map((t) => t.number);
      const pick = a === "p" ? (await askText("Ticket numbers, separated by spaces?")).split(/[\s,]+/).map(toInt).filter((n) => ready.includes(n)) : a === "y" ? ready : [];
      for (const n of pick) act(`label #${n}`, () => gh("issue", "edit", String(n), "-R", repo(), "--add-label", "agent:explore"));
      // Sent or declined, sf asks about each frontier ticket once. GitHub may still show it unlabelled for a moment.
      for (const t of frontier) skip.add(`${t.number}:frontier`);
      acted = true;
    }

    for (const t of list.filter((t) => GATES.has(t.status) && !skip.has(`${t.number}:${t.status}`))) {
      console.log("");
      if (t.status === "pr-ready") {
        const body = t.pr.body ?? "";
        const danger = body.match(/##\s*Merge Danger\s*\n([\s\S]*?)(\n##\s|\n---|$)/i)?.[1].trim();
        console.log(`${c.b(`PR #${t.pr.number} is ready for you`)} (${t.specRow ? "spec" : "ticket"} #${t.number}): ${t.pr.title}\n  ${t.pr.url}`);
        if (danger) console.log(c.y(`  Merge Danger: ${danger.split("\n").slice(0, 4).join(" ").slice(0, 300)}`));
        const a = await ask("[o]pen in the browser, [m]erge (squash), [s]kip for now", "omS");
        if (a === "o") { tryShell("gh", ["pr", "view", String(t.pr.number), "-R", repo(), "--web"]); continue; }
        if (a === "m" && (await ask(`Squash-merge PR #${t.pr.number} into the default branch and delete its branch?`, "yN")) === "y")
          act(`merge PR #${t.pr.number}`, () => gh("pr", "merge", String(t.pr.number), "-R", repo(), "--squash", "--delete-branch"));
        else skip.add(`${t.number}:${t.status}`);
      } else if (t.status === "needs-you") {
        console.log(`${c.b(`#${t.number} needs you`)}: ${t.title}\n  ${t.url}`);
        console.log(c.d(labels(issue(t.number)).includes("needs-a-human") ? "  Explore found open questions. Its comment on the ticket lists them."
          : "  It has a factory label but no run. Implement it, or settle it in a session first."));
        const a = await ask("[g]rill it in a session, [p]rototype it first, [i]mplement anyway, [s]kip", "gpiS");
        if (a === "p") { act(`label #${t.number}`, () => gh("issue", "edit", String(t.number), "-R", repo(), "--remove-label", "needs-a-human", "--add-label", "agent:prototype")); acted = true; continue; }
        if (a === "g") {
          claude([], `/grill-with-docs Settle the open questions on issue #${t.number}. Read its comments first. Post the decisions as a comment on #${t.number}.\n\n(sf) Type /exit when done.`);
          if ((await ask(`Hand #${t.number} to the implementer now?`)) === "y") act(`label #${t.number}`, () => gh("issue", "edit", String(t.number), "-R", repo(), "--remove-label", "needs-a-human", "--add-label", "agent:implement"));
        } else if (a === "i") act(`label #${t.number}`, () => gh("issue", "edit", String(t.number), "-R", repo(), "--remove-label", "needs-a-human", "--add-label", "agent:implement"));
        else skip.add(`${t.number}:${t.status}`);
      } else if (t.status === "prototype-ready") {
        console.log(`${c.b(`#${t.number} has a prototype for you`)}: ${t.title}\n  ${t.url}`);
        console.log(c.d("  Its newest comment has screenshots. Reply on the issue with @factory and feedback to get the next version."));
        // In spec mode the night shift builds every ticket, so a separate implement run would build it twice.
        const nightShift = st.mode === "spec" && !t.other;
        const build = nightShift ? "[i] let the night shift build it (the prototype is the spec)" : "[i]mplement it now (the prototype is the spec)";
        const a = await ask(`[o]pen the issue, ${build}, [g]rill it, [s]kip`, "oigS");
        if (a === "o") { tryShell("gh", ["issue", "view", String(t.number), "-R", repo(), "--web"]); skip.add(`${t.number}:${t.status}`); }
        else if (a === "i") act(`label #${t.number}`, () => gh("issue", "edit", String(t.number), "-R", repo(), "--remove-label", "prototype",
          ...(nightShift ? [] : ["--add-label", "agent:implement"])));
        else if (a === "g") claude([], `/grill-with-docs Settle issue #${t.number}. Its prototype is on the prototype/issue-${t.number} branch, with screenshots in the comments. Post the decisions as a comment on #${t.number}.\n\n(sf) Type /exit when done.`);
        else skip.add(`${t.number}:${t.status}`);
      } else if (t.status === "failed") {
        // The run failed on the ticket (explore or implement) or on its PR (review). Retry where it failed.
        const onPr = t.pr && t.pr.labels.some((l) => l.name === "agent:blocked");
        const [kind, num] = onPr ? ["pr", t.pr.number] : ["issue", t.number];
        const last = JSON.parse(gh(kind, "view", String(num), "-R", repo(), "--json", "comments")).comments.filter((x) => x.body.includes("factory:status")).pop();
        console.log(`${c.r(`${t.prRow ? `PR #${num}` : onPr ? `PR #${num} (ticket #${t.number})` : `#${t.number}`} failed`)}: ${t.title}\n  ${(last?.body ?? "").replace(/<!--.*?-->/g, "").trim().slice(0, 300)}`);
        if (st.mode === "spec" && !onPr && !t.other) {
          // A night-shift ticket: unpark it, then resume the spec. The night shift starts again from the frontier.
          if ((await ask(`[r]etry: unpark #${t.number} and resume the night shift on spec #${st.spec}, [s]kip`, "rS")) === "r") {
            if (!t.specRow) act(`unpark #${t.number}`, () => gh("issue", "edit", String(t.number), "-R", repo(), "--remove-label", "agent:blocked"));
            act(`resume spec #${st.spec}`, () => gh("issue", "edit", String(st.spec), "-R", repo(), "--remove-label", "agent:blocked", "--add-label", "agent:implement-spec"));
          } else skip.add(`${t.number}:${t.status}`);
          acted = true; continue;
        }
        const label = onPr ? (/rebase failed/i.test(last?.body ?? "") ? "agent:rebase" : "agent:review") : /explore run failed/i.test(last?.body ?? "") ? "agent:explore"
          : /prototype run failed/i.test(last?.body ?? "") ? "agent:prototype" : "agent:implement";
        const a = await ask(`[r]etry with ${label}, [s]kip`, "rS");
        if (a === "r") act(`relabel ${kind} #${num}`, () => gh(kind, "edit", String(num), "-R", repo(), "--remove-label", "agent:blocked", "--add-label", label));
        else skip.add(`${t.number}:${t.status}`);
      }
      acted = true;
    }
    if (!acted && (await ask("Nothing needs you right now. [w]atch again or [q]uit?", "Wq")) === "q") return false;
  }
}

async function phaseDone(st) {
  console.log(c.g(c.b(`\nSpec #${st.spec} is built: every ticket is closed.`)));
  const spec = tryShell("gh", ["issue", "view", String(st.spec), "-R", repo(), "--json", "state", "--jq", ".state"])?.trim();
  if (spec === "OPEN" && (await ask(`Close spec #${st.spec} on GitHub?`)) === "y")
    act(`close spec #${st.spec}`, () => gh("issue", "close", String(st.spec), "-R", repo(), "--reason", "completed", "--comment", "Every ticket is closed. Closed by sf."));
  console.log("Suggested next steps from the course. Each one asks first.");
  if ((await ask("Run /retro on this work? It lists findings only, and you choose which to apply.")) === "y") retro();
  await architecture();
  if ((await ask("Start a lint ratchet run now?", "yN")) === "y") await sendEvent("ratchet.requested", "Ratchet run");
  st.phase = "finished"; save(st);
  return false;
}

async function architecture() {
  const a = await ask("Architecture review: [l]ocal session (report + grilling with you), [f]actory run (one ticket per candidate), [s]kip", "lfS");
  if (a === "l") claude([], "/improve-codebase-architecture");
  if (a === "f") await sendEvent("architecture.requested", "Architecture review");
}

const retro = () => claude([], "/retro Review the recent planning sessions and the factory's runs on this repo (issues, PRs, review comments). List findings only. Do not apply any fix. I choose which to accept.");

/** Every event name. The orchestrator's ev() builds the same name. */
const eventName = (factory, event) => `factory/${factory}/${event}`;

async function sendEvent(event, what) {
  // The event key sits in the shared env file, readable by the user who set up the host.
  const key = process.env.INNGEST_EVENT_KEY ?? envValue(`${ENV_DIR}/common.env`, "INNGEST_EVENT_KEY");
  const name = eventName((await factory()).name, event);
  if (!key) die("No INNGEST_EVENT_KEY. Set it in your env, or run sf on the factory host.");
  const r = await fetch(`${INNGEST}/e/${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, data: {} }) })
    .catch((e) => die(`Inngest at ${INNGEST} did not answer (${e.cause?.code ?? e.message}). Is the factory running?`));
  console.log(r.ok ? c.g(`${what} requested. Watch it in the Inngest dashboard.`) : c.r(`Inngest answered ${r.status}.`));
}

async function run(st) {
  if (!st || st.phase === "finished") return board(st);
  await preflight();
  const phases = { grill: phaseGrill, wayfinder: phaseWayfinder, spec: phaseSpec, tickets: phaseTickets, build: phaseBuild, done: phaseDone };
  while (phases[st.phase]) {
    // A step returns false to stop. It returns true to go on, with st.phase moved on or unchanged (run it again).
    if (!(await phases[st.phase](st))) break;
  }
  if (st.phase !== "finished") console.log(c.d(`\nStopped at step "${st.phase}". Run sf to continue.`));
}

// ── commands ─────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
/** Splits --recommended / -r from the idea words. */
const ideaArgs = (args) => ({ recommended: args.some((a) => a === "--recommended" || a === "-r"),
  idea: args.filter((a) => a !== "--recommended" && a !== "-r").join(" ").trim() });
/**
 * No idea in progress: the factory's other work in this repo. Issues filed or labelled on GitHub show here,
 * and sf offers the ready-for-agent ones to the factory, the same way it offers a spec's tickets.
 */
async function board(st) {
  if (st) console.log(`${c.g(`Done: spec #${st.spec} is built.`)} ${c.d(`(${st.idea})`)}`);
  else console.log(c.d("No idea in progress here."));
  console.log(`Next idea: ${c.b('sf idea "<what you want to build>"')}  ·  Other runs: ${c.b("sf retro")}, ${c.b("sf architecture")}, ${c.b("sf ratchet")}\n`);
  await preflight();
  const view = { mode: "explore" }; // no spec: only the other issues. Never saved.
  if (!tickets(null).length) { console.log(render(view, [], agents(), await runs())); return; }
  await phaseBuild(view);
}

async function startIdea(idea, recommended = false) {
  const old = load();
  if (old && old.phase !== "finished" && (await ask(`An idea is in progress here (step "${old.phase}"). Replace it?`, "yN")) !== "y") process.exit(0);
  const st = { idea, phase: "grill", session: randomUUID(), started: new Date().toISOString(), recommended };
  if (recommended) console.log(c.d("Recommended mode: the grilling answers its own questions and lists its decisions at the end."));
  save(st); await run(st);
}
const need = () => load() ?? noIdeaHere();
// A factory repo with no idea yet still has a board. Outside a factory repo, list the ideas elsewhere.
const isFactoryRepo = () => fs.existsSync(".sandcastle/agent-workflows");
switch (cmd) {
  case "new": { const a = ideaArgs(rest.slice(1)); await newProject(rest[0], a.idea || undefined, a.recommended); break; }
  case "idea": case "build": { const a = ideaArgs(rest); await startIdea(a.idea || die('Give the idea: sf idea [--recommended] "<what you want to build>"'), a.recommended); break; }
  case undefined: case "resume": await run(load() ?? (isFactoryRepo() ? null : noIdeaHere())); break;
  case "status": { const st = need(); if (!st.spec) { console.log(`Step "${st.phase}". No spec yet.`); break; } await watch(st, { once: true }); break; }
  case "watch": { const st = need(); if (!st.spec) die("No spec yet."); await watch(st); break; }
  case "logs": {
    const ags = agents() ?? die("No docker access on this machine.");
    // Both sides cleaned: the board shows a cleaned subject, herdr passes the raw one. An exact match wins.
    const q = clean(rest.join(" ")), names = (l) => l.map((x) => clean(x.subject)).join(", ");
    const exact = ags.filter((x) => clean(x.subject) === q), hits = exact.length ? exact : ags.filter((x) => clean(x.subject).includes(q));
    if (!hits.length) die(`No running agent matches "${q}". Running: ${names(ags) || "none"}`);
    if (!exact.length && hits.length > 1) die(`Several agents match "${q}": ${names(hits)}. Give the full subject.`);
    followActivity(hits[0].name); break;
  }
  case "retro": retro(); break;
  case "architecture": await architecture(); break;
  case "ratchet": await sendEvent("ratchet.requested", "Ratchet run"); break;
  case "rebase": await sendEvent("rebase.sweep", "Rebase sweep"); break;
  case "help": case "-h": case "--help":
  default: console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 17).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}
