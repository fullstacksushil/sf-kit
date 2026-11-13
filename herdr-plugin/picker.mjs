#!/usr/bin/env node
// Popup picker: lists the running factory agents (subject, repo, age), then opens the follow pane for the choice.
// Agent text is untrusted: it is cleaned for display and passed on only as argv or env, never through a shell.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });
// Must stay equal to clean() in cli/sf.mjs (test/herdr-plugin.sh compares them). The plugin cannot import from cli/.
const clean = (s) => String(s ?? "").replace(/\x1b(\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)?)/g, "").replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ");
const wait = (msg) => { process.stdout.write(`${msg}\n[enter] `); try { fs.readSync(0, Buffer.alloc(64)); } catch {} process.exit(0); };

// Same registry as sf (cli/sf.mjs): every folder where an idea started. Map each folder to its origin repo.
const registry = `${process.env.XDG_STATE_HOME ?? `${process.env.HOME}/.local/state`}/sf/projects.json`;
let dirs = []; try { dirs = JSON.parse(fs.readFileSync(registry, "utf8")); } catch {}
const folder = new Map();
for (const d of dirs) {
  const m = run("git", ["-C", d, "remote", "get-url", "origin"]).stdout?.trim().match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/);
  if (m && !folder.has(m[1].toLowerCase())) folder.set(m[1].toLowerCase(), d);
}

const ps = run("docker", ["ps", "--filter", "label=factory.subject", "--format", '{{.Label "factory.subject"}}\t{{.Label "factory.repo"}}\t{{.RunningFor}}']);
if (ps.status !== 0) wait(`docker ps failed: ${clean(ps.stderr ?? "")}`);
const agents = ps.stdout.split("\n").filter(Boolean).map((l) => {
  const [subject, repo, age] = l.split("\t");
  return { subject, repo, age, dir: folder.get(String(repo).toLowerCase()) }; // a missing field: no folder, shown empty
});
if (!agents.length) wait("No running factory agents.");

// Field 1 is the index, hidden from view. fzf prints the chosen line.
const lines = agents.map((a, i) => `${i}\t${clean(a.subject)}  ${clean(a.repo)}  ${clean(a.age)}${a.dir ? "" : "  (no folder known)"}`);
const fzf = run("fzf", ["--delimiter", "\t", "--with-nth", "2..", "--prompt", "agent> "], { input: lines.join("\n") + "\n", stdio: ["pipe", "pipe", "inherit"] });
const a = agents[Number(fzf.stdout.split("\t")[0])];
if (fzf.status !== 0 || !a) process.exit(0);
if (!a.dir) wait(`No folder known for ${clean(a.repo)}. Run sf once in its folder, then pick again.`);

// check: a pane opened from a popup lands in the current workspace. The docs do not say.
const open = run(process.env.HERDR_BIN_PATH || "herdr", ["plugin", "pane", "open", "--plugin", process.env.HERDR_PLUGIN_ID || "sf", "--entrypoint", "follow", "--env", `SF_DIR=${a.dir}`, "--env", `SF_SUBJECT=${a.subject}`]);
if (open.status !== 0) wait(`Could not open the pane: ${clean(open.stderr ?? "")}`);
