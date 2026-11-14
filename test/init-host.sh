#!/usr/bin/env bash
# Asserts what init-host.sh --dry-run prints. Touches nothing: fake docker and sudo come first on PATH.
KIT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
for f in docker sudo systemctl ufw; do printf '#!/bin/sh\nexit 1\n' >"$T/$f"; chmod +x "$T/$f"; done
printf '#!/bin/sh\n[ "$1 $2" = "compose version" ] && exit 0\nexit 1\n' >"$T/docker"
FAIL=0
has() { grep -qF -- "$1" <<<"$OUT" || { echo "FAIL: missing: $1"; FAIL=1; }; }
hasnt() { grep -qF -- "$1" <<<"$OUT" && { echo "FAIL: unexpected: $1"; FAIL=1; }; true; }
OUT="$(PATH="$T:$PATH" "$KIT/init-host.sh" --dry-run --observability phoenix 2>&1)" || { echo "FAIL: exit $?"; echo "$OUT"; exit 1; }
ME="$(id -un)"
has "write /etc/factory/common.env (mode 600, owner $ME)"
has "INNGEST_BASE_URL=http://127.0.0.1:8288"
has "CLAUDE_CODE_OAUTH_TOKEN="
has "FACTORY_SLOTS=2"
has "OTEL_TRACES_ENDPOINT=http://phoenix:6006/v1/traces"
has "mkdir -p /etc/factory/factories"
has "chown $ME /etc/factory/factories"
has "factory-orchestrator@.service"
has "setup-wizard.sh"
for v in GITHUB_WEBHOOK_SECRET GITHUB_REPO INNGEST_SERVE_ORIGIN FACTORY_PAT orchestrator.env; do hasnt "$v"; done
# the template unit file
U="$KIT/host/factory-orchestrator@.service"
[ -f "$U" ] || { echo "FAIL: no $U"; FAIL=1; }
[ ! -e "$KIT/host/factory-orchestrator.service" ] || { echo "FAIL: old unit file remains"; FAIL=1; }
u() { grep -qF -- "$1" "$U" || { echo "FAIL: unit lacks: $1"; FAIL=1; }; }
u "EnvironmentFile=/etc/factory/common.env"
u "EnvironmentFile=/etc/factory/factories/%i.env"
u "FACTORY_NAME=%i"
u "ExecStartPost=/usr/bin/env curl -f"
u "--retry-connrefused"
u "--retry-all-errors"
u "--max-time"
grep -q '^ExecStartPost=-' "$U" && { echo "FAIL: ExecStartPost has - prefix"; FAIL=1; }
grep -q -- '--sdk-url' "$KIT/host/compose.yaml" && { echo "FAIL: compose has --sdk-url"; FAIL=1; }
# No flock on the host: stop with a message, also in --dry-run. The PATH copy has every tool but flock.
mkdir "$T/noflock"; IFS=: read -ra dirs <<<"$T:$PATH"
for d in "${dirs[@]}"; do for f in "$d"/*; do b="${f##*/}"; [ "$b" = flock ] || [ -e "$T/noflock/$b" ] || ln -s "$f" "$T/noflock/$b" 2>/dev/null; done; done
OUT="$(PATH="$T/noflock" "$KIT/init-host.sh" --dry-run 2>&1)" && { echo "FAIL: ran without flock"; FAIL=1; }
has "Missing: flock"
# Run with sudo by an operator: stop, also in --dry-run. A fake id reports root.
mkdir "$T/asroot"; printf '#!/bin/sh\ncase "$1" in -u) echo 0;; *) echo root;; esac\n' >"$T/asroot/id"; chmod +x "$T/asroot/id"
OUT="$(PATH="$T/asroot:$PATH" SUDO_USER=operator "$KIT/init-host.sh" --dry-run 2>&1)" && { echo "FAIL: ran with sudo"; FAIL=1; }
has "without sudo, as operator"
# A root login without sudo is allowed.
PATH="$T/asroot:$PATH" SUDO_USER= "$KIT/init-host.sh" --dry-run >/dev/null 2>&1 || { echo "FAIL: root login refused"; FAIL=1; }
[ "$FAIL" = 0 ] && echo "init-host test: ok"; exit "$FAIL"
