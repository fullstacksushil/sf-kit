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
http.createServer((q, r) => { let b = ""; q.on("data", (d) => b += d); q.on("end", () => { fs.appendFileSync(process.argv[2], `${q.url} ${b}\n`); r.end("ok"); }); }).listen(0, "127.0.0.1", function () { fs.writeFileSync(process.argv[3], String(this.address().port)); });
S
export T="$T" T_LOG="$T/docker.log" T_WIZ="$T/wiz.args" ENV_DIR="$T/env" SF_WIZARD="$T/bin/wiz" HOME="$T/home" XDG_STATE_HOME="$T/state"
node "$T/srv.mjs" "$T/events.log" "$T/port" & SRV=$!
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
exit $fail
