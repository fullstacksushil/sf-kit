#!/usr/bin/env bash
# Tests the herdr plugin with fake docker, herdr, fzf and sf. Never touches the live herdr.
set -u
P="$(cd "$(dirname "$0")/.." && pwd)/herdr-plugin"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
# docker ps prints $T/ps. A subject with an escape code, a tab-free newline is impossible in a label line.
cat > "$T/bin/docker" <<'D'
#!/bin/sh
[ "$1" = ps ] && cat "$T/ps"
exit 0
D
# herdr records its argv, one arg per line.
cat > "$T/bin/herdr" <<'D'
#!/bin/sh
for a in "$@"; do printf '%s\n' "$a"; done > "$T/herdr.args"
D
# fzf records its input and picks the line that contains $PICK.
cat > "$T/bin/fzf" <<'D'
#!/bin/sh
tee "$T/fzf.in" | grep -F -- "$PICK" | head -1
D
cat > "$T/bin/sf" <<'D'
#!/bin/sh
for a in "$@"; do printf '%s\n' "$a"; done > "$T/sf.args"
D
chmod +x "$T"/bin/*
export T PATH="$T/bin:$PATH" HERDR_BIN_PATH="$T/bin/herdr" HERDR_PLUGIN_ID=sf
ESC=$(printf '\033')
BIDI=$(printf '\330\234\342\200\256')  # U+061C and U+202E
printf 'agent-r7\towner/repo#7 add $(touch %s/pwned) "x"%s[31mred%s\towner/repo\t5 minutes ago\nagent-r2\tother/x#2 lint\tother/x\t1 hour ago\nagent-r9\tlonely\n' "$T" "$ESC" "$BIDI" > "$T/ps"

fail=0
ok() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
pick() { (cd "$P" && PICK="$1" node picker.mjs </dev/null >"$T/out" 2>&1); }

# picker list: subject, repo, age; control characters stripped
pick 'owner/repo#7'
ok "list: known agent" 'grep -q "owner/repo#7 add \$(touch $T/pwned) \"x\"red    owner/repo  5 minutes ago" "$T/fzf.in"'
ok "list: no escape char" '! grep -q "$ESC" "$T/fzf.in"'
ok "list: no bidi char" '! grep -qF "$BIDI" "$T/fzf.in" && ! grep -q $'"'"'\xd8\x9c'"'"' "$T/fzf.in"'
ok "list: a row with missing fields does not throw" 'grep -q "^2	lonely" "$T/fzf.in" && ! grep -q TypeError "$T/out"'
ok "clean: equal to the one in cli/sf.mjs" '[ "$(grep "^const clean = " "$P/picker.mjs")" = "$(grep "^const clean = " "$P/../cli/sf.mjs")" ]'
ok "list: no folder needed" 'grep -q "^1	other/x#2 lint  other/x  1 hour ago$" "$T/fzf.in"'
# the choice opens the follow pane with the container name in env, never through a shell
ok "choice: exact herdr command" 'diff <(printf "%s\n" plugin pane open --plugin sf --entrypoint follow --env SF_CONTAINER=agent-r7) "$T/herdr.args"'
ok "choice: no shell ran the subject" '[ ! -e "$T/pwned" ]'

# the follow pane runs sf logs --container "$SF_CONTAINER" from any folder
(cd / && SF_CONTAINER='agent-x $(touch '"$T"'/pwned2)' sh "$P/follow.sh" </dev/null >/dev/null 2>&1)
ok "follow: sf logs --container" 'diff <(printf "%s\n" logs --container "agent-x \$(touch $T/pwned2)") "$T/sf.args"'
ok "follow: name not run" '[ ! -e "$T/pwned2" ]'
rm -f "$T/herdr.args"; pick 'other/x#2'
ok "choice: another repo opens too" 'diff <(printf "%s\n" plugin pane open --plugin sf --entrypoint follow --env SF_CONTAINER=agent-r2) "$T/herdr.args"'


# no agents
: > "$T/ps"; rm -f "$T/herdr.args" "$T/fzf.in"; pick x
ok "none: says so" 'grep -q "No running factory agents" "$T/out"'
ok "none: no fzf, no herdr" '[ ! -e "$T/fzf.in" ] && [ ! -e "$T/herdr.args" ]'

# the action opens the picker popup
A=$(grep -A4 'id = "watch-agent"' "$P/herdr-plugin.toml" | sed -n 's/^command = //p')
ok "action: opens picker" '[ "$A" = '"'"'["sh", "-c", "exec \"$HERDR_BIN_PATH\" plugin pane open --plugin \"$HERDR_PLUGIN_ID\" --entrypoint picker"]'"'"' ]'
exit $fail
