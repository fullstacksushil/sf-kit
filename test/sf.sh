#!/usr/bin/env bash
# Tests sf in a scratch repo. Fake gh, claude, docker on PATH. A local node server stands in for Inngest.
set -u
SF="$(cd "$(dirname "$0")/.." && pwd)/sf"
T=$(mktemp -d); trap 'kill $SRV 2>/dev/null; rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/env/factories" "$T/repo"
for b in gh claude; do printf '#!/bin/sh\nexit 0\n' > "$T/bin/$b"; done
cat > "$T/bin/docker" <<'D'
#!/bin/sh
echo "docker $*" >> "$T_LOG"
[ "$1" = ps ] && printf 'a1\towner/repo#1\t1m\nb1\tother/x#2\t1m\n'
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
export T_LOG="$T/docker.log" T_WIZ="$T/wiz.args" ENV_DIR="$T/env" SF_WIZARD="$T/bin/wiz" HOME="$T/home" XDG_STATE_HOME="$T/state"
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
exit $fail
