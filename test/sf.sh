#!/usr/bin/env bash
# Tests sf in a scratch repo. Fake gh, claude, docker on PATH. A local node server stands in for Inngest.
set -u
SF="$(cd "$(dirname "$0")/.." && pwd)/sf"
T=$(mktemp -d); trap 'kill $SRV 2>/dev/null; rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/env/factories" "$T/repo"
printf '#!/bin/sh\nexit 0\n' > "$T/bin/claude"
printf '#!/bin/sh\necho "[]"\n' > "$T/bin/gh"
# docker ps lists the agents in $T/ps. docker logs prints $T/logs/<container>.
cat > "$T/bin/docker" <<'D'
#!/bin/sh
echo "docker $*" >> "$T_LOG"
[ "$1" = ps ] && cat "$T/ps"
if [ "$1" = logs ]; then for a; do n=$a; done; cat "$T/logs/$n"; fi
exit 0
D
cat > "$T/bin/wiz" <<'W'
#!/bin/sh
echo "$*" > "$T_WIZ"
printf 'GITHUB_REPO=%s\nPORT=3005\n' "$2" > "$ENV_DIR/factories/newf.env"
W
chmod +x "$T"/bin/*
cat > "$T/srv.mjs" <<'S'
import http from "node:http"; import fs from "node:fs";
// /v0/gql answers from $T/gql/apps, $T/gql/runs and $T/gql/run-<id>. A missing file is a GraphQL error, as Inngest gives for an unknown run.
const gql = (b) => { const j = JSON.parse(b), qs = j.query, k = /^\{\s*apps/.test(qs) ? "apps" : /runs\(/.test(qs) ? "runs" : `run-${j.variables?.id}`;
  try { return fs.readFileSync(`${process.argv[4]}/gql/${k}`, "utf8"); } catch { return '{"errors":[{"message":"no rows"}],"data":null}'; } };
http.createServer((q, r) => { let b = ""; q.on("data", (d) => b += d); q.on("end", () => { fs.appendFileSync(process.argv[2], `${q.url} ${b}\n`); r.end(q.url === "/v0/gql" ? gql(b) : "ok"); }); }).listen(0, "127.0.0.1", function () { fs.writeFileSync(process.argv[3], String(this.address().port)); });
S
export T="$T" T_LOG="$T/docker.log" T_WIZ="$T/wiz.args" ENV_DIR="$T/env" SF_WIZARD="$T/bin/wiz" HOME="$T/home" XDG_STATE_HOME="$T/state"
node "$T/srv.mjs" "$T/events.log" "$T/port" "$T" & SRV=$!
while [ ! -s "$T/port" ]; do sleep 0.05; done
export INNGEST_BASE_URL="http://127.0.0.1:$(cat "$T/port")" PATH="$T/bin:$PATH"
printf "INNGEST_EVENT_KEY='k123'\n" > "$T/env/common.env"
printf 'GITHUB_REPO=Owner/Repo\nPORT=3007\n' > "$T/env/factories/repo-a.env"
printf 'GITHUB_REPO=other/x\nPORT=3001\n' > "$T/env/factories/xx.env"
cd "$T/repo" && git init -q && git remote add origin git@github.com:owner/repo.git

fail=0
ok() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }

# match by origin (case-insensitive): event name carries the factory name, key from the shared file
out=$("$SF" ratchet 2>&1 </dev/null)
ok "match: event name" 'grep -q "^/e/k123 .*\"name\":\"factory/repo-a/ratchet.requested\"" "$T/events.log"'
"$SF" rebase >/dev/null 2>&1 </dev/null
ok "rebase event name" 'grep -q "factory/repo-a/rebase.sweep" "$T/events.log"'

# agent list filters on factory.repo
"$SF" logs zzz >/dev/null 2>&1 </dev/null
ok "docker ps filters on factory.repo" 'grep -q "label=factory.repo=owner/repo" "$T/docker.log"'
git remote set-url origin git@github.com:Owner/Repo.git; : > "$T/docker.log"
"$SF" logs zzz >/dev/null 2>&1 </dev/null
ok "docker ps filter lowercases the origin" 'grep -q "label=factory.repo=owner/repo" "$T/docker.log"'
git remote set-url origin git@github.com:owner/repo.git

# override
: > "$T/events.log"
SF_ORCHESTRATOR_URL=http://127.0.0.1:1 SF_FACTORY=zed "$SF" ratchet >/dev/null 2>&1 </dev/null
ok "override: SF_FACTORY names the event" 'grep -q "factory/zed/ratchet.requested" "$T/events.log"'
out=$(SF_ORCHESTRATOR_URL=http://127.0.0.1:1 "$SF" ratchet 2>&1 </dev/null); rc=$?
ok "override without SF_FACTORY stops" '[ $rc -ne 0 ] && grep -q SF_FACTORY <<<"$out"'

# no match, answer no: prints full command, wizard not run
git remote set-url origin git@github.com:owner/new.git
rm -f "$T_WIZ"
out=$(echo n | "$SF" ratchet 2>&1); rc=$?
ok "no match, no: stops" '[ $rc -ne 0 ]'
ok "no match, no: offer text" 'grep -q "No factory serves owner/new. Set one up now?" <<<"$out"'
ok "no match, no: prints wizard command" 'grep -qF "$SF_WIZARD --repo owner/new" <<<"$out"'
ok "no match, no: wizard not run" '[ ! -e "$T_WIZ" ]'

# no match, answer yes: wizard runs, sf continues with the new factory
: > "$T/events.log"
out=$(echo y | "$SF" ratchet 2>&1); rc=$?
ok "no match, yes: wizard args" '[ "$(cat "$T_WIZ")" = "--repo owner/new" ]'
ok "no match, yes: event for new factory" 'grep -q "factory/newf/ratchet.requested" "$T/events.log"'

# wizard writes nothing: sf stops
rm -f "$T/env/factories/newf.env"; git remote set-url origin git@github.com:owner/none.git
printf '#!/bin/sh\nexit 0\n' > "$T/bin/wiz"
out=$(echo y | "$SF" ratchet 2>&1); rc=$?
ok "wizard leaves no match: stops" '[ $rc -ne 0 ]'

# a factory file without PORT: stop and name the file
printf 'GITHUB_REPO=owner/noport\n' > "$T/env/factories/np.env"; git remote set-url origin git@github.com:owner/noport.git
out=$("$SF" ratchet 2>&1 </dev/null); rc=$?
ok "no PORT: stops, names the file" '[ $rc -ne 0 ] && grep -qF "$T/env/factories/np.env" <<<"$out" && grep -q PORT <<<"$out" && ! grep -q undefined <<<"$out"'
rm "$T/env/factories/np.env"; git remote set-url origin git@github.com:owner/repo.git

# one helper builds every event name in sf
raw=$(grep -n "[\"'\`]factory/" "$(dirname "$SF")/cli/sf.mjs")
ok "one event-name helper" '[ "$(wc -l <<<"$raw")" = 1 ] && grep -q "const eventName = " <<<"$raw"'

# help and sf new do not look for a factory
out=$("$SF" help 2>&1 </dev/null); rc=$?
ok "help needs no factory" '[ $rc -eq 0 ]'
ok "sf new prints wizard command with --repo" 'grep -q -- "--repo" <<<"$(grep -n "setup-wizard.sh --repo" "$(dirname "$SF")/cli/sf.mjs")"'
# agent activity: canned docker logs, one container for each case
mkdir -p "$T/logs" "$T/repo/.sandcastle/agent-workflows" "$T/repo/.claude/skills/grill-with-docs"
printf 'a1\towner/repo#1\t1m\na2\towner/repo#2\t3m\na3\towner/repo#3\t2m\na4\towner/repo#4\t9m\na5\towner/repo#5\t1m\n' > "$T/ps"
printf 'a6\towner/repo#6\t1m\na7\towner/repo#7\t1m\na8\towner/repo#8\t1m\na9\towner/repo#9\t1m\n' >> "$T/ps"
printf 'a11\towner/repo#11\t1m\n' >> "$T/ps"
printf 's1\towner/repo#s1\t1m\ns2\towner/repo#s2\t1m\ns3\towner/repo#s3\t1m\n' >> "$T/ps"
now5=$(date -u -d '-5 sec' +%Y-%m-%dT%H:%M:%SZ)
pre() { printf '{"sf":1,"t":"2026-11-13T15:25:0%sZ","ev":"PreToolUse","tool":"%s","in":"%s"}\n' "$1" "$2" "$3"; }
post() { printf '{"sf":1,"t":"2026-11-13T15:25:0%sZ","ev":"PostToolUse","tool":"%s","ms":%s}\n' "$1" "$2" "$3"; }
{ pre 1 Read 'src/a.ts'; post 2 Read 120
  printf '{"sf":1,"t":"%s","ev":"PreToolUse","tool":"Bash","in":"npm test"}\n' "$now5"; } > "$T/logs/a1"
{ pre 1 Grep 'first-call'; post 1 Grep 10; pre 2 Edit 'b.ts'; post 2 Edit 300
  pre 3 Bash 'npm run check'; post 5 Bash 2105; pre 6 Write 'c.ts'; post 6 Write 40
  printf '{"sf":1,"t":"2026-11-13T15:25:07Z","ev":"Stop"}\n'; } > "$T/logs/a2"
{ echo 'Sandcastle: starting'; pre 1 Write 'notes.md'; echo '{"type":"assistant","tool":"Edit","ev":"PreToolUse"}'
  echo 'Bash(sleep 2)'; echo '{"ev":"PreToolUse","tool":"Fake","in":"x"}'; post 2 Write 55
  for i in 1 2 3 4 5; do echo "Sandcastle closing line $i"; done; } > "$T/logs/a3"
printf 'old 1\nold 2\nold 3\nold 4\nold 5\x1b]0;title\x07\nold 6\n' > "$T/logs/a4"
# Lines with a call id (the hook since review item 2). Old lines above have none and pair by tool.
prei() { printf '{"sf":1,"t":"2026-11-13T15:25:0%sZ","ev":"PreToolUse","id":"%s","tool":"%s","in":"%s"}\n' "$@"; }
endi() { printf '{"sf":1,"t":"2026-11-13T15:25:0%sZ","ev":"%s","id":"%s","tool":"%s","ms":%s}\n' "$@"; }
{ prei 1 i1 Read slow.ts; prei 1 i2 Read fast.ts; endi 2 PostToolUse i2 Read 50; endi 3 PostToolUse i1 Read 900; } > "$T/logs/a6"
{ prei 1 h1 Bash hang; prei 2 h2 Bash 'echo b'; endi 3 PostToolUse h2 Bash 30; prei 4 h3 Bash 'echo c'; endi 5 PostToolUse h3 Bash 40; } > "$T/logs/a7"
{ cat "$T/logs/a7"; printf '{"sf":1,"t":"2026-11-13T15:25:06Z","ev":"Stop"}\n'; } > "$T/logs/a8"
{ prei 1 f1 Bash fails; endi 2 PostToolUseFailure f1 Bash 20; prei 3 f2 Bash rm; printf '{"sf":1,"t":"2026-11-13T15:25:04Z","ev":"PermissionDenied","id":"f2","tool":"Bash"}\n'; } > "$T/logs/a9"
# Sandcastle 0.14 log lines from a live agent (qf, 2026-11-13). The hook lines in the L1 format.
cat > "$T/logs/s1" <<'FIX'
│
◇  Bash(cat /tmp/ticket.md; ls; cat CODING_STANDARDS.md 2>/dev/null | head -200)
{"sf":1,"t":"2026-11-13T22:50:37Z","ev":"PreToolUse","id":"toolu_1","tool":"Bash","in":"cat /tmp/ticket.md; ls; cat CODING_STANDARDS.md 2>/dev/null | head -200"}
{"sf":1,"t":"2026-11-13T22:50:37Z","ev":"PostToolUse","id":"toolu_1","tool":"Bash","ms":89}
│
│  Do the rename, then add a regression test guarding against case-only collisions.
│
◇  Bash(echo no hook line follows)
│
FIX
cat > "$T/logs/s2" <<'FIX'
│
◇  Bash(cd /work/repo && cat > src/lib/case-collisions.ts <<'EOF'
│  // Paths that differ only in letter case collide on macOS and Windows: one file hides the other,
│  // so imports resolve to the wrong module there while Linux builds pass.
│  export function caseCollisions(paths: readonly string[]): string[][] {
│    const groups = new Map<string, string[]>()
│    for (const p of paths) {
│      const key = p.toLowerCase()
│      groups.set(key, [...(groups.get(key) ?? []), p])
│    }
│    return [...groups.values()].filter((g) => g.length > 1)
│  }
│  EOF
│  cat > src/lib/case-collisions.test.ts <<'EOF'
│  import assert from 'node:assert/strict'
│  import { execFileSync } from 'node:child_process'
│  import { test } from 'node:test'
│  import { caseCollisions } from './case-collisions.ts'
│
│  test('paths that differ only in case collide', () => {
│    assert.deepEqual(caseCollisions(['a/Logic.tsx', 'a/logic.tsx', 'a/logic.ts', 'b/Logic.tsx']), [['a/Logic.tsx', 'a/logic.tsx']])
│  })
│
│  test('a different extension or folder is no collision', () => {
│    assert.deepEqual(caseCollisions(['a/Logic.tsx', 'a/logic-helpers.ts', 'b/logic.ts']), [])
│  })
│
│  test('no tracked files collide on a case-insensitive filesystem', () => {
│    const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
│    assert.deepEqual(caseCollisions(tracked), [])
│  })
│  EOF
│  node --test src/lib/case-collisions.test.ts src/components/shell/designer/logic-helpers.test.ts 2>&1 | tail -9)
{"sf":1,"t":"2026-11-13T22:50:55Z","ev":"PreToolUse","id":"toolu_2","tool":"Bash","in":"cd /work/repo && cat > src/lib/case-collisions.ts <<'EOF'\n// Paths that differ o"}
{"sf":1,"t":"2026-11-13T22:50:55Z","ev":"PostToolUse","id":"toolu_2","tool":"Bash","ms":186}
│
│  The original bug was `Logic.tsx` vs `logic.ts` — different extensions — so a plain path comparison would miss it. The check must compare import specifiers (extension stripped).
│
FIX
# A plain `claude -p` agent: its text and the hook lines, no Sandcastle block.
{ prei 1 p1 Read src/a.ts; endi 2 PostToolUse p1 Read 12; echo 'Done. Bash(npm test) passed.'; echo '│  not a Sandcastle block'; } > "$T/logs/s3"
pre 1 Bash 'npm test \\\n    \t&& npm run lint' > "$T/logs/a11"  # a multi-line command, as the hook writes it since L1
printf '{"sf":1,"t":"2026-11-13T15:25:01Z","ev":"PreToolUse","tool":"Bash\\u001b[31m","in":"\\u001b]0;pwned\\u0007\\u001b[31mrm -rf /\\u001b[0m\\r\\nnext"}\n' > "$T/logs/a5"

board=$(cd "$T/repo" && "$SF" 2>&1 </dev/null | sed 's/\x1b\[[0-9;]*m//g')
raw=$(cd "$T/repo" && "$SF" 2>&1 </dev/null)
agent() { awk -v s="owner/repo#$1 " 'index($0,"▶ " s){on=1;next} /▶ owner\/repo#/{on=0} on' <<<"$board"; }
ok "board reads a bounded tail" 'grep -q "docker logs --tail 200 a1" "$T/docker.log"'
ok "running tool: current action with its time" 'agent 1 | grep -Eq "Bash +npm test · [0-9.]+s"'
ok "running tool: finished action with duration" 'agent 1 | grep -Eq "Read +src/a.ts · 120ms"'
ok "finished run: finishing after Stop" 'agent 2 | grep -q finishing'
ok "finished run: last 3 finished actions" '[ "$(agent 2 | grep -cE "Write|Bash|Edit|Grep")" = 3 ] && agent 2 | grep -q "2.1s" && ! agent 2 | grep -q first-call'
ok "noise: activity lines only" 'agent 3 | grep -Eq "Write +notes.md" && ! agent 3 | grep -Eq "Fake|Sandcastle|sleep"'
ok "no activity: last 4 raw lines" 'agent 4 | grep -q "old 6" && agent 4 | grep -q "old 3" && ! agent 4 | grep -q "old 2"'
ok "ids: parallel calls of one tool finish out of order" 'agent 6 | grep -Eq "done Read +slow.ts · 900ms" && agent 6 | grep -Eq "done Read +fast.ts · 50ms" && ! agent 6 | grep -q "now"'
ok "ids: a call that never finishes, later calls of its tool" 'agent 7 | grep -Eq "now  Bash +hang" && agent 7 | grep -Eq "Bash +echo b · 30ms" && agent 7 | grep -Eq "Bash +echo c · 40ms"'
ok "ids: Stop closes the open call" 'agent 8 | grep -q finishing && ! agent 8 | grep -q "now"'
ok "ids: a failed and a denied call are closed" 'agent 9 | grep -Eq "fail Bash +fails · 20ms" && agent 9 | grep -Eq "fail Bash +rm · denied" && ! agent 9 | grep -q "now"'
ok "multi-line input on one line" 'agent 11 | grep -Eq "Bash +npm test \\\\ && npm run lint · "'
ok "escapes: text shown" 'agent 5 | grep -q "rm -rf /"'
ok "escapes: stripped" '! grep -q $'"'"'\x07'"'"' <<<"$raw" && ! grep -qF $'"'"'\x1b]'"'"' <<<"$raw" && ! grep -qF $'"'"'\x1b[31m'"'"' <<<"$raw"'
: > "$T/docker.log"
lg=$(cd "$T/repo" && "$SF" logs "repo#3" 2>&1 </dev/null)
ok "logs: follows" 'grep -q "docker logs -f .* a3" "$T/docker.log"'
ok "logs: mixed log, every line in order" '[ "$(wc -l <<<"$lg")" = 11 ] && grep -Eq "Write +notes.md" <<<"$lg" && grep -q "55ms" <<<"$lg" && grep -qF "Bash(sleep 2)" <<<"$lg" && grep -q "closing line 5" <<<"$lg" && grep -qF "\"tool\":\"Fake\"" <<<"$lg" && [ "$(head -1 <<<"$lg")" = "Sandcastle: starting" ]'
lg=$(cd "$T/repo" && "$SF" logs "repo#4" 2>&1 </dev/null)
ok "logs: no activity line, raw lines cleaned" '[ "$(wc -l <<<"$lg")" = 6 ] && grep -q "old 1" <<<"$lg" && grep -q "old 6" <<<"$lg" && ! grep -q $'"'"'[\x07\x1b]'"'"' <<<"$lg"'
lg=$(cd "$T/repo" && "$SF" logs "repo#5" 2>&1 </dev/null)
lg=$(sed 's/\x1b\[[0-9;]*m//g' <<<"$lg")  # drop sf's own colours
ok "logs: escapes stripped" 'grep -q "rm -rf /" <<<"$lg" && ! grep -q $'"'"'[\x07\x1b\r]'"'"' <<<"$lg"'
# L2: a Sandcastle Bash block followed by its hook line shows only the hook line. Everything else stays.
lg=$(cd "$T/repo" && "$SF" logs "repo#s1" 2>&1 </dev/null | sed 's/\x1b\[[0-9;]*m//g')
ok "sandcastle: one-line Bash block dropped, hook line kept" '! grep -qF "◇  Bash(cat /tmp/ticket.md" <<<"$lg" && [ "$(grep -cE "▶ Bash +cat /tmp/ticket.md; ls;" <<<"$lg")" = 1 ] && grep -qE "✓ Bash +89ms" <<<"$lg"'
ok "sandcastle: agent text kept" 'grep -qxF "│  Do the rename, then add a regression test guarding against case-only collisions." <<<"$lg" && [ "$(grep -cx "│" <<<"$lg")" = 4 ]'
ok "sandcastle: a block with no hook line after it is kept" 'grep -qxF "◇  Bash(echo no hook line follows)" <<<"$lg" && [ "$(wc -l <<<"$lg")" = 8 ]'
lg=$(cd "$T/repo" && "$SF" logs "repo#s2" 2>&1 </dev/null | sed 's/\x1b\[[0-9;]*m//g')
ok "sandcastle: heredoc block dropped" '! grep -qE "Bash\(cd /work/repo|│  // Paths|│  EOF|tail -9\)" <<<"$lg" && grep -qE "▶ Bash +cd /work/repo && cat > src/lib/case-collisions.ts <<.EOF. // Paths" <<<"$lg" && grep -q "186ms" <<<"$lg"'
ok "sandcastle: heredoc, agent text kept" 'grep -qF "│  The original bug was" <<<"$lg" && [ "$(wc -l <<<"$lg")" = 6 ]'
lg=$(cd "$T/repo" && "$SF" logs "repo#s3" 2>&1 </dev/null | sed 's/\x1b\[[0-9;]*m//g')
ok "plain claude -p log unchanged" '[ "$(wc -l <<<"$lg")" = 4 ] && grep -qE "▶ Read +src/a.ts" <<<"$lg" && grep -qE "✓ Read +12ms" <<<"$lg" && [ "$(sed -n 3,4p <<<"$lg")" = "Done. Bash(npm test) passed.
│  not a Sandcastle block" ]'
# subjects: exact match wins, a partial match only when it is the one match. Subject text is cleaned and shell-safe.
cp "$T/ps" "$T/ps.keep"
BAD="x'\$(touch $T/pwned)\"y$(printf '\033[31m\330\234') z"
printf 'b12\timplement #12\t1m\nb1\timplement #1\t1m\na10\t%s\t1m\n' "$BAD" > "$T/ps"; : > "$T/logs/b1"; : > "$T/logs/b12"; : > "$T/logs/a10"
follows() { : > "$T/docker.log"; (cd "$T/repo" && "$SF" logs "$1" >"$T/lg.out" 2>&1 </dev/null); echo $? > "$T/rc"; grep -o "docker logs -f --tail 200 .*" "$T/docker.log"; }
ok "match: exact subject wins" '[ "$(follows "implement #1")" = "docker logs -f --tail 200 b1" ]'
ok "match: one partial match" '[ "$(follows "#12")" = "docker logs -f --tail 200 b12" ]'
ok "match: several partial matches, listed, stop" '[ -z "$(follows implement)" ] && [ "$(cat "$T/rc")" != 0 ] && grep -q "implement #12, implement #1\." "$T/lg.out"'
ok "match: raw subject with escapes (the herdr path)" '[ "$(follows "$BAD")" = "docker logs -f --tail 200 a10" ]'
board=$(cd "$T/repo" && "$SF" 2>&1 </dev/null); hl=$(sed 's/\x1b\[[0-9;]*m//g' <<<"$board" | grep -F "sf logs " | grep -F "pwned")
ok "subject: cleaned on the board" '! grep -q $'"'"'\x1b\[31m'"'"' <<<"$board" && ! grep -q $'"'"'\xd8\x9c'"'"' <<<"$board" && grep -qF "▶ x'"'"'" <<<"$hl"'
hint=${hl##*sf logs }
ok "subject: hint is safe to paste" 'eval "set -- $hint" && [ "$#" = 1 ] && [ ! -e "$T/pwned" ] && [ "$(follows "$1")" = "docker logs -f --tail 200 a10" ] && [ ! -e "$T/pwned" ]'
ok "clean: bidi characters written as \\u escapes" '! LC_ALL=C.UTF-8 grep -qP "[\x{061c}\x{200e}\x{200f}\x{202a}-\x{202e}\x{2066}-\x{2069}]" "$(dirname "$SF")/cli/sf.mjs"'
mv "$T/ps.keep" "$T/ps"
# herdr hint: fake herdr first on PATH. A fake PATH without the real herdr covers "no herdr".
mkdir -p "$T/h" "$T/nobin"
for b in node git sh env dirname readlink; do ln -sf "$(command -v $b)" "$T/nobin/$b"; done
for b in claude gh docker; do ln -sf "$T/bin/$b" "$T/nobin/$b"; done
fakeherdr() { printf '#!/bin/sh\n%s\n' "$1" > "$T/h/herdr"; chmod +x "$T/h/herdr"; }
hint() { (cd "$T/repo" && PATH="$1" "$SF" 2>&1 </dev/null | sed 's/\x1b\[[0-9;]*m//g'); }
kit=$(cd "$(dirname "$SF")" && pwd)
fakeherdr 'printf "1 plugin installed:\n- drovr (drovr) enabled [github:x/y]\n"'
ok "herdr hint: not linked, exact command" 'hint "$T/h:$PATH" | grep -qxF "herdr plugin link $kit/herdr-plugin" || hint "$T/h:$PATH" | grep -qF "herdr plugin link $kit/herdr-plugin"'
ok "herdr hint: after the agent section" '[ "$(hint "$T/h:$PATH" | tail -1 | grep -c "herdr plugin link")" = 1 ]'
fakeherdr 'printf "2 plugins installed:\n- drovr (drovr) enabled [github:x/y]\n- sf (sf) enabled [local:/x]\n"'
ok "herdr hint: linked, no line" 'hint "$T/h:$PATH" | grep -q "^Agents" && ! hint "$T/h:$PATH" | grep -q "herdr plugin"'
fakeherdr 'echo boom >&2; exit 1'
ok "herdr hint: herdr fails, no line" 'hint "$T/h:$PATH" | grep -q "^Agents" && ! hint "$T/h:$PATH" | grep -q "herdr plugin"'
fakeherdr 'sleep 5'
ok "herdr hint: a hung herdr does not stall the board" 's=$(date +%s); out=$(hint "$T/h:$PATH"); [ $(( $(date +%s) - s )) -lt 4 ] && grep -q "^Agents" <<<"$out" && ! grep -q "herdr plugin" <<<"$out"'
ok "herdr hint: no herdr, no line" 'hint "$T/nobin" | grep -q "^Agents" && ! hint "$T/nobin" | grep -q "herdr plugin"'
fakeherdr 'printf "1 plugin installed:\n- drovr (drovr) enabled [github:x/y]\n"'
: > "$T/h/count"; printf '#!/bin/sh\necho x >> "%s/h/count"\necho "- drovr (drovr) enabled"\n' "$T" > "$T/h/herdr"
ok "herdr hint: checked once per process" '[ "$(cd "$T/repo" && PATH="$T/h:$PATH" "$SF" >/dev/null 2>&1 </dev/null; wc -l < "$T/h/count")" = 1 ]'
# runs from Inngest: canned GraphQL answers. The app of factory repo-a is u-a.
mkdir -p "$T/gql"; : > "$T/ps"
ago() { date -u -d "-$1" +%Y-%m-%dT%H:%M:%SZ; }
echo '{"data":{"apps":[{"id":"u-x","externalID":"software-factory-other"},{"id":"u-a","externalID":"software-factory-repo-a"}]}}' > "$T/gql/apps"
rn() { printf '{"node":{"id":"%s","status":"%s","startedAt":%s,"function":{"name":"%s"}}}' "$@"; }
printf '{"data":{"runs":{"edges":[%s,%s,%s,%s]}}}' "$(rn R1 RUNNING "\"$(ago '12 min')\"" implement-ticket)" "$(rn R2 QUEUED null review-pr)" \
  "$(rn R3 RUNNING "\"$(ago '5 min')\"" rebase-pr)" "$(rn R4 RUNNING "\"$(ago '2 sec')\"" github-poll)" > "$T/gql/runs"
trig() { printf '"t":{"payloads":["{\\"name\\":\\"factory/repo-a/x\\",\\"data\\":{%s},\\"ts\\":1}"]}' "$1"; }
# check: assumed shape. An unfinished step span (status RUNNING, endedAt null) was not seen on 2026-11-13: the live trace lists a step only after it ends.
printf '{"data":{"run":{"trace":{"status":"RUNNING","childrenSpans":[{"name":"executor.nonstep","status":"RUNNING","stepOp":null,"attempts":0,"startedAt":"%s","endedAt":null},{"name":"prepare","status":"COMPLETED","stepOp":"RUN","attempts":0,"startedAt":"%s","endedAt":"%s","duration":540000},{"name":"implement","status":"RUNNING","stepOp":"RUN","attempts":2,"startedAt":"%s","endedAt":null}]}},%s}}' \
  "$(ago '12 min')" "$(ago '12 min')" "$(ago '3 min')" "$(ago '3 min')" "$(trig '\"issueNumber\":12')" > "$T/gql/run-R1"
printf '{"data":{"run":{"trace":{"status":"RUNNING","childrenSpans":[{"name":"fetch\\u001b]0;pwned\\u0007","status":"COMPLETED","stepOp":"RUN","attempts":0,"startedAt":"%s","endedAt":"%s"},{"name":"Execution","status":"RUNNING","stepOp":null,"attempts":0,"startedAt":"%s","endedAt":null}]}},%s}}' \
  "$(ago '5 min')" "$(ago '4 min')" "$(ago '4 min')" "$(trig '\"prNumber\":34')" > "$T/gql/run-R3"
: > "$T/events.log"
raw=$(cd "$T/repo" && "$SF" 2>&1 </dev/null); board=$(sed 's/\x1b\[[0-9;]*m//g' <<<"$raw")
run() { grep -E "^  . $1 " <<<"$board"; }
ok "runs: a run in a step with its attempt" 'run implement-ticket | grep -Eq "#12 .*step implement · 3m0[0-9]s · attempt 2 · run 12m0[0-9]s"'
ok "runs: a queued run with no trace" 'run review-pr | grep -q "queued" && ! run review-pr | grep -q "#"'
ok "runs: PR number, the last finished step and the time since it ended" 'run rebase-pr | grep -Eq "PR #34 .*last step fetch +ended 4m0[0-9]s ago · run 5m0[0-9]s" && ! run rebase-pr | grep -q attempt'
ok "runs: github-poll left out" '! grep -q github-poll <<<"$board"'
ok "runs: block before the agents" 'grep -n "^Runs\|^Agents" <<<"$board" | head -1 | grep -q Runs'
ok "runs: Inngest text cleaned" '! grep -qF $'"'"'\x1b]'"'"' <<<"$raw" && ! grep -q $'"'"'\x07'"'"' <<<"$raw"'
ok "runs: one request per run at most" '[ "$(grep -c "runID" "$T/events.log")" = 3 ]'
ok "runs: ids go as GraphQL variables" 'grep -q "\"app\":\"u-a\"" "$T/events.log" && grep -q "\"id\":\"R1\"" "$T/events.log" && node -e '"'"'for (const l of require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter((x) => x.startsWith("/v0/gql "))) if (/u-a|R1|R3/.test(JSON.parse(l.slice(8)).query)) process.exit(1)'"'"' "$T/events.log"'
echo '{"data":{"runs":{"edges":[]}}}' > "$T/gql/runs"
ok "runs: none, one line" '[ "$(cd "$T/repo" && "$SF" 2>&1 </dev/null | grep -c "^.*Runs")" = 1 ] && cd "$T/repo" && "$SF" 2>&1 </dev/null | grep -q "Runs: none"'
ok "runs: Inngest down, one line, board goes on" '(cd "$T/repo" && INNGEST_BASE_URL=http://127.0.0.1:1 "$SF" 2>&1 </dev/null) | grep -q "Runs: Inngest at http://127.0.0.1:1 does not answer" && (cd "$T/repo" && INNGEST_BASE_URL=http://127.0.0.1:1 "$SF" 2>&1 </dev/null) | grep -q "^.*Agents"'
echo '{"data":{"apps":[{"id":"u-x","externalID":"software-factory-other"}]}}' > "$T/gql/apps"
ok "runs: app not found, one line" '(cd "$T/repo" && "$SF" 2>&1 </dev/null) | grep -q "Runs: Inngest has no app software-factory-repo-a"'
ok "runs: remote factory without an Inngest URL, no block" '! (cd "$T/repo" && env -u INNGEST_BASE_URL SF_ORCHESTRATOR_URL=http://127.0.0.1:1 SF_FACTORY=repo-a "$SF" 2>&1 </dev/null) | grep -q "Runs"'
ok "runs: remote factory with an Inngest URL, block shown" '(cd "$T/repo" && SF_ORCHESTRATOR_URL=http://127.0.0.1:1 SF_FACTORY=repo-a "$SF" 2>&1 </dev/null) | grep -q "Runs: Inngest has no app software-factory-repo-a"'
git remote set-url origin git@github.com:owner/nofactory.git
out=$(cd "$T/repo" && "$SF" 2>&1 </dev/null); rc=$?
ok "runs: no factory, one line, no undefined" '[ $rc -eq 0 ] && grep -q "Runs: no factory found for this repo" <<<"$out" && ! grep -q undefined <<<"$out" && grep -q "Agents" <<<"$out"'
printf 'GITHUB_REPO=owner/noport\n' > "$T/env/factories/np.env"; git remote set-url origin git@github.com:owner/noport.git
out=$(cd "$T/repo" && "$SF" 2>&1 </dev/null); rc=$?
ok "runs: factory file without PORT does not stop the board" '[ $rc -eq 0 ] && grep -q "Runs: Inngest has no app software-factory-np" <<<"$out" && grep -q "Agents" <<<"$out"'
exit $fail
