#!/usr/bin/env bash
# Asserts what init-worker.sh --dry-run prints, and what it refuses. Touches nothing: fake docker, sudo and
# iptables come first on PATH. The fake sudo runs its command, so the fakes answer for root too.
KIT="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
printf '#!/bin/sh\nexec "$@"\n' >"$T/sudo"
printf '#!/bin/sh\n[ "$1 $2" = "info -f" ] && { echo "${FAKE_OS:-Ubuntu 24.04 LTS}"; exit 0; }\nexit 1\n' >"$T/docker"
printf '#!/bin/sh\n[ -n "$FAKE_NO_CHAIN" ] && exit 1\nexit 0\n' >"$T/iptables"
chmod +x "$T"/*
KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOk factory@ec2"
FAIL=0
has() { grep -qF -- "$1" <<<"$OUT" || { echo "FAIL: missing: $1"; FAIL=1; }; }
hasnt() { grep -qF -- "$1" <<<"$OUT" && { echo "FAIL: unexpected: $1"; FAIL=1; }; true; }
run() { PATH="$T:$PATH" "$KIT/init-worker.sh" "$@" 2>&1; }

OUT="$(run --key "$KEY" --dry-run)" || { echo "FAIL: exit $?"; echo "$OUT"; exit 1; }
has "useradd --create-home --shell /bin/bash factory"
has "usermod -aG docker factory"
has "restrict $KEY"
has "docker network create factory-net --subnet 172.30.0.0/24"
has "iptables -I DOCKER-USER -s 172.30.0.0/24 -d 100.64.0.0/10 -j DROP"
has "iptables -I INPUT -s 172.30.0.0/24 -j DROP"
has "systemctl enable --now factory-firewall.service"
has "docker build -t factory-runner:latest"
has "ssh://factory@"
hasnt "CLAUDE_CODE_OAUTH_TOKEN"
hasnt "+ sudo mkdir -p /etc/factory"

OUT="$(run --key "$KEY" --user agentbox --dry-run)"
has "useradd --create-home --shell /bin/bash agentbox"
has "ssh://agentbox@"

# Refusals: each exits non-zero and says why.
refuse() { local why="$1"; shift; OUT="$("$@" 2>&1)" && { echo "FAIL: accepted: $why"; FAIL=1; return; }; grep -qF -- "$why" <<<"$OUT" || { echo "FAIL: no reason \"$why\" in: $OUT"; FAIL=1; }; }
refuse "--key" run --dry-run
refuse "not an ssh public key" run --key "ssh-ed25519 AAAA x"$'\n'"ssh-rsa BBBB y" --dry-run
refuse "not an ssh public key" run --key 'command="id" ssh-ed25519 AAAA' --dry-run
refuse "not a user name" run --key "$KEY" --user 'x;id' --dry-run
refuse "Docker Desktop" env FAKE_OS="Docker Desktop" PATH="$T:$PATH" "$KIT/init-worker.sh" --key "$KEY" --dry-run
refuse "colima" env FAKE_OS="Docker Desktop" PATH="$T:$PATH" "$KIT/init-worker.sh" --key "$KEY" --dry-run
refuse "DOCKER-USER" env FAKE_NO_CHAIN=1 PATH="$T:$PATH" "$KIT/init-worker.sh" --key "$KEY" --dry-run

[ "$FAIL" = 0 ] && echo "init-worker.sh dry run: ok"
exit "$FAIL"
