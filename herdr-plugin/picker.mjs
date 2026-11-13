#!/usr/bin/env node
// Popup picker: lists the running factory agents (subject, repo, age), then opens the follow pane for the choice.
// The pane follows the container by name (sf logs --container), so no project folder is needed.
// Agent text is untrusted: it is cleaned for display and passed on only as argv or env, never through a shell.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
// Must stay equal to clean() in cli/sf.mjs (test/herdr-plugin.sh compares them). The plugin cannot import from cli/.
const clean = (s) => String(s ?? "").replace(/\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)?)/g, "").replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ");
const wait = (msg) => { process.stdout.write(`${msg}\n[enter] `); try { fs.readSync(0, Buffer.alloc(64)); } catch {} process.exit(0); };

const ps = run("docker", ["ps", "--filter", "label=factory.subject", "--format", '{{.Names}}\t{{.Label "factory.subject"}}\t{{.Label "factory.repo"}}\t{{.RunningFor}}']);
if (ps.status !== 0) wait(`docker ps failed: ${clean(ps.stderr ?? "")}`);
const agents = ps.stdout.split("\n").filter(Boolean).map((l) => {
  const [name, subject, repo, age] = l.split("\t");
  return { name, subject, repo, age }; // a missing field is shown empty
});
if (!agents.length) wait("No running factory agents.");

// Field 1 is the index, hidden from view. fzf prints the chosen line.
const lines = agents.map((a, i) => `${i}\t${clean(a.subject)}  ${clean(a.repo)}  ${clean(a.age)}`);
const fzf = run("fzf", ["--delimiter", "\t", "--with-nth", "2..", "--prompt", "agent> "], { input: lines.join("\n") + "\n", stdio: ["pipe", "pipe", "inherit"] });
const a = agents[Number(fzf.stdout.split("\t")[0])];
if (fzf.status !== 0 || !a) process.exit(0);

// check: a pane opened from a popup lands in the current workspace. The docs do not say.
const open = run(process.env.HERDR_BIN_PATH || "herdr", ["plugin", "pane", "open", "--plugin", process.env.HERDR_PLUGIN_ID || "sf", "--entrypoint", "follow", "--env", `SF_CONTAINER=${a.name}`]);
if (open.status !== 0) wait(`Could not open the pane: ${clean(open.stderr ?? "")}`);
