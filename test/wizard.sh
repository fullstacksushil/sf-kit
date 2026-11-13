#!/usr/bin/env bash
# Runs setup-wizard.sh with ENV_DIR in a temp dir, piped answers and fake system commands
# first on PATH. Nothing here reaches the real firewall, systemd, GitHub or /etc/factory.
set -uo pipefail
KIT=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
E="$T/etc"; F="$E/factories"; LOG="$T/calls.log"; OUT="$T/out"
mkdir -p "$T/bin" "$F"
printf 'INNGEST_EVENT_KEY=x\n' > "$E/common.env"

fake() { printf '#!/usr/bin/env bash\necho "%s $*" >> "%s"\n%s\n' "$1" "$LOG" "${2:-}" > "$T/bin/$1"; chmod +x "$T/bin/$1"; }
# A token reaches every repo when it starts with "good".
fake gh '[[ "$*" == *permissions* ]] && { [[ "${GH_TOKEN:-}" == good* ]] && echo true || echo false; }; exit 0'
fake systemctl '[[ "$1" == is-active ]] && exit 1; exit 0'
fake curl 'echo 200'
fake claude 'echo ok'
fake docker '[[ "$*" == "image inspect nope:1" ]] && exit 1; exit 0'
for c in sudo ufw npm xdg-open open wslview explorer.exe mise; do fake "$c"; done

fails=0
ok()  { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); sed 's/^/     | /' "$OUT" | tail -n 15; }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }
has() { grep -qF -- "$1" "$2"; }

# wiz ANSWERS ARGS... runs the wizard with one answer per line. Sets $rc.
wiz() { local answers="$1"; shift; : > "$LOG"
  printf '%s\n' "$answers" | env -u ENV_FILE PATH="$T/bin:$PATH" ENV_DIR="$E" ORCH_DIR="$KIT/orchestrator" \
    bash "$KIT/setup-wizard.sh" "$@" > "$OUT" 2>&1; rc=$?; }
val() { sed -n "s/^$1='\(.*\)'\$/\1/p" "$2" | tail -n1; }

# 1. First run: shared stages, proposed name with dash cleanup, port 3000, firewall range, start.
# Answers: banner, name (Enter), deps, setup, image, PAT, Claude token, test Claude (n), Langfuse (n), pause, port, ufw (y), start (y), polling (y).
wiz $'\n\n\n\n\ngood-a\nsk-ant-oat-x\nn\nn\n\n\ny\ny\ny' --repo 'acme/My__Cool.App'
A="$F/my-cool-app.env"
check "first run exits 0" test "$rc" = 0
check "proposes my-cool-app from acme/My__Cool.App" has '[my-cool-app]' "$OUT"
check "factory env file has the repo" test "$(val GITHUB_REPO "$A")" = acme/My__Cool.App
check "factory env file has the PAT" test "$(val FACTORY_PAT "$A")" = good-a
check "Claude token goes to common.env" test "$(val CLAUDE_CODE_OAUTH_TOKEN "$E/common.env")" = sk-ant-oat-x
check "Claude token stays out of the factory file" bash -c "test -f '$A' && ! grep -q CLAUDE_CODE_OAUTH_TOKEN '$A'"
check "factory env file gets a webhook secret" test -n "$(val GITHUB_WEBHOOK_SECRET "$A")"
check "first port is 3000" test "$(val PORT "$A")" = 3000
check "firewall allows the Docker subnet to 3000:3099" has 'ufw allow from 172.16.0.0/12 to any port 3000:3099 proto tcp' "$LOG"
check "firewall denies 3000:3099 to the rest" has 'ufw deny 3000:3099/tcp' "$LOG"
check "start enables the template unit" has 'systemctl enable factory-orchestrator@my-cool-app' "$LOG"
check "polling goes to the factory file" test "$(val GITHUB_POLL "$A")" = 1

# 2. Second run for the saved repo, in another case: edits that factory, asks no name, skips the shared stages.
secret_a=$(val GITHUB_WEBHOOK_SECRET "$A")
# Answers: banner, deps, setup, image, keep PAT, port, ufw, start, polling.
wiz $'\n\n\n\n\n\ny\ny\ny' --repo 'ACME/my__cool.app'
check "second run exits 0" test "$rc" = 0
check "second run edits the same factory" test "$(ls "$F")" = my-cool-app.env
check "second run asks no factory name" bash -c "! grep -q 'Factory name:' '$OUT'"
check "second run skips the Claude stage" bash -c "! grep -q 'Claude token' '$OUT'"
check "second run skips the trace stage" bash -c "! grep -q 'Agent traces' '$OUT'"
check "second run keeps the webhook secret" test "$(val GITHUB_WEBHOOK_SECRET "$A")" = "$secret_a"
check "second run keeps port 3000" test "$(val PORT "$A")" = 3000

# 3. A new repo next to saved factories: name cut to 21 with the end dash removed, port after the
# highest saved port, and an offer to reuse a token that reaches the repo.
printf "GITHUB_REPO='acme/old'\nPORT='3005'\nFACTORY_PAT='bad-x'\n" > "$F/old.env"
B="$F/abcdefghijklmnopqrst.env"
# Answers: banner, name, deps, setup, image, reuse token (y), port, ufw, start, polling.
wiz $'\n\n\n\n\ny\n\ny\ny\ny' --repo acme/abcdefghijklmnopqrst-uvw
check "third run exits 0" test "$rc" = 0
check "proposes abcdefghijklmnopqrst (cut to 21, end dash removed)" has '[abcdefghijklmnopqrst]' "$OUT"
check "port is the highest saved port plus 1" test "$(val PORT "$B")" = 3006
check "offers the token of my-cool-app with a warning" has 'one token reaches more than one repo' "$OUT"
check "reused token is saved for the new factory" test "$(val FACTORY_PAT "$B")" = good-a
check "new factory gets its own webhook secret" bash -c "s=\$(sed -n \"s/^GITHUB_WEBHOOK_SECRET='\\(.*\\)'/\\1/p\" '$B'); [[ -n \$s && \$s != '$secret_a' ]]"

# 4. A proposal that fails the rule asks with no default. A name of another repo asks again.
# Answers: banner, name (Enter), name (my-cool-app), name (printer), deps, setup, image, two token offers (n, n),
# token, port (3001), ufw (n), start (n), polling.
P="$F/printer.env"
wiz $'\n\nmy-cool-app\nprinter\n\n\n\nn\nn\ngood-p\n3001\nn\nn\ny' --repo acme/3d-printer
check "fourth run exits 0" test "$rc" = 0
check "a proposal that fails the rule shows no default" bash -c "! grep -q '\\[3d-printer\\]' '$OUT'"
check "Enter with no default asks again" has 'Factory names match' "$OUT"
check "a name of another repo names that repo and asks again" has 'Factory my-cool-app already serves acme/My__Cool.App' "$OUT"
check "the other factory keeps its repo" test "$(val GITHUB_REPO "$A")" = acme/My__Cool.App
check "the factory gets the typed name" test "$(val GITHUB_REPO "$P")" = acme/3d-printer
check "the operator can change the port" test "$(val PORT "$P")" = 3001
check "the new factory gets a webhook secret" test -n "$(val GITHUB_WEBHOOK_SECRET "$P")"

# 5. --factory with a name of another repo stops.
wiz $'\n' --repo acme/new --factory old
check "--factory with a name of another repo exits non-zero" test "$rc" != 0
check "--factory with a name of another repo names that repo" has 'Factory old already serves acme/old' "$OUT"
check "--factory with a name of another repo leaves the file alone" test "$(val GITHUB_REPO "$F/old.env")" = acme/old

# 6. --factory with a free valid name skips the name question.
# Answers: banner, deps, setup, image, three token offers (n, n, n), token, port, ufw, start, polling.
wiz $'\n\n\n\nn\nn\nn\ngood-z\n\nn\nn\ny' --repo acme/zed --factory zz
check "--factory with a free name exits 0" test "$rc" = 0
check "--factory skips the name question" bash -c "! grep -q 'Factory name:' '$OUT'"
check "--factory names the env file" test "$(val GITHUB_REPO "$F/zz.env")" = acme/zed
check "--factory with a bad name stops" bash -c "printf '\\n' | env PATH='$T/bin:$PATH' ENV_DIR='$E' ORCH_DIR='$KIT/orchestrator' bash '$KIT/setup-wizard.sh' --repo acme/q --factory Bad_Name >/dev/null 2>&1; [ \$? != 0 ] && [ ! -e '$F/Bad_Name.env' ]"

# 8. The setup command and the runner image are optional. Enter writes no line. A typed value is saved,
# and Enter keeps it on the next run. An image that Docker does not have gets a warning with the build command.
check "Enter writes no RUN_SETUP line" bash -c "! grep -q '^RUN_SETUP=' '$A'"
check "Enter writes no RUNNER_IMAGE line" bash -c "! grep -q '^RUNNER_IMAGE=' '$A'"
# Answers: banner, deps, setup, image (bad, then nope:1), keep PAT, port, ufw, start, polling.
wiz $'\n\nnpm ci && make it\'s\nBad Image\nnope:1\n\n\nn\nn\ny' --repo acme/zed
check "run with a setup command and an image exits 0" test "$rc" = 0
check "the setup command is saved with its quote" test "$(bash -c ". '$F/zz.env'; printf %s \"\$RUN_SETUP\"")" = "npm ci && make it's"
check "a bad image name asks again" has 'Not an image name: Bad Image' "$OUT"
check "the runner image is saved" test "$(val RUNNER_IMAGE "$F/zz.env")" = nope:1
check "an image Docker does not have gets the build command" has 'docker build -t nope:1' "$OUT"
wiz $'\n\n\n\n\n\nn\nn\ny' --repo acme/zed
check "Enter keeps the saved runner image" test "$(val RUNNER_IMAGE "$F/zz.env")" = nope:1
sed -i 's/nope:1/have:1/' "$F/zz.env"
wiz $'\n\n\n\n\n\nn\nn\ny' --repo acme/zed
check "an image Docker has gets no warning" bash -c "! grep -q 'docker build -t' '$OUT'"

# 7. The wizard's name rule is the orchestrator's.
rule_sh=$(sed -n "s/^NAME_RULE='\(.*\)'.*/\1/p" "$KIT/setup-wizard.sh")
rule_ts=$(sed -n 's|^const FACTORY_NAME_RULE = /\(.*\)/;$|\1|p' "$KIT/orchestrator/src/inngest.ts")
check "NAME_RULE equals FACTORY_NAME_RULE in inngest.ts" test -n "$rule_sh" -a "$rule_sh" = "$rule_ts"
check "NAME_RULE comment names inngest.ts" bash -c "grep -q '^NAME_RULE=.*orchestrator/src/inngest.ts' '$KIT/setup-wizard.sh'"

(( fails )) && { echo "$fails failed"; exit 1; }
echo "all passed"
