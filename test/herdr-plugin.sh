#!/usr/bin/env bash
# Tests the herdr plugin with fake docker, herdr, fzf, sf and git-free project folders. Never touches the live herdr.
set -u
P="$(cd "$(dirname "$0")/.." && pwd)/herdr-plugin"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/state/sf" "$T/proj"
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
{ pwd; for a in "$@"; do printf '%s\n' "$a"; done; } > "$T/sf.args"
D
chmod +x "$T"/bin/*
git -C "$T/proj" init -q && git -C "$T/proj" remote add origin git@github.com:Owner/Repo.git
printf '["%s", "%s/gone"]\n' "$T/proj" "$T" > "$T/state/sf/projects.json"
export T XDG_STATE_HOME="$T/state" PATH="$T/bin:$PATH" HERDR_BIN_PATH="$T/bin/herdr" HERDR_PLUGIN_ID=sf
ESC=$(printf '\033')
printf 'owner/repo#7 add $(touch %s/pwned) "x"%s[31mred\towner/repo\t5 minutes ago\nother/x#2 lint\tother/x\t1 hour ago\n' "$T" "$ESC" > "$T/ps"

fail=0
ok() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
pick() { (cd "$P" && PICK="$1" node picker.mjs </dev/null >"$T/out" 2>&1); }

# picker list: subject, repo, age; control characters stripped; unknown folder said in the list
pick 'owner/repo#7'
ok "list: known agent" 'grep -q "owner/repo#7 add \$(touch $T/pwned) \"x\"\[31mred  owner/repo  5 minutes ago" "$T/fzf.in"'
ok "list: no escape char" '! grep -q "$ESC" "$T/fzf.in"'
ok "list: unknown folder" 'grep -q "other/x#2 lint  other/x  1 hour ago  (no folder known)" "$T/fzf.in"'
# the choice opens the follow pane with the raw subject in env, never through a shell
ok "choice: exact herdr command" 'diff <(printf "%s\n" plugin pane open --plugin sf --entrypoint follow --env "SF_DIR=$T/proj" --env "SF_SUBJECT=owner/repo#7 add \$(touch $T/pwned) \"x\"${ESC}[31mred") "$T/herdr.args"'
ok "choice: no shell ran the subject" '[ ! -e "$T/pwned" ]'

# the follow pane runs sf logs "<subject>" in the project folder
(cd "$P" && SF_DIR="$T/proj" SF_SUBJECT='a "b" $(touch '"$T"'/pwned2)' sh follow.sh </dev/null >/dev/null 2>&1)
ok "follow: sf logs in the folder" 'diff <(printf "%s\n" "$T/proj" logs "a \"b\" \$(touch $T/pwned2)") "$T/sf.args"'
ok "follow: subject not run" '[ ! -e "$T/pwned2" ]'

# unknown folder: the choice says so and opens nothing
rm -f "$T/herdr.args"; pick 'other/x#2'
ok "unknown: says so" 'grep -q "No folder known for other/x" "$T/out"'
ok "unknown: no herdr call" '[ ! -e "$T/herdr.args" ]'

# no agents
: > "$T/ps"; rm -f "$T/herdr.args" "$T/fzf.in"; pick x
ok "none: says so" 'grep -q "No running factory agents" "$T/out"'
ok "none: no fzf, no herdr" '[ ! -e "$T/fzf.in" ] && [ ! -e "$T/herdr.args" ]'

# the action opens the picker popup
A=$(grep -A4 'id = "watch-agent"' "$P/herdr-plugin.toml" | sed -n 's/^command = //p')
ok "action: opens picker" '[ "$A" = '"'"'["sh", "-c", "exec \"$HERDR_BIN_PATH\" plugin pane open --plugin \"$HERDR_PLUGIN_ID\" --entrypoint picker"]'"'"' ]'
exit $fail
