#!/usr/bin/env bash
# Make this machine a worker machine: it runs agent containers for a factory host, and holds no factory config.
# Sets up: a worker user that the factory host reaches over ssh, the run network with the factory firewall rules,
# and the runner image. Run it on the worker machine, as your own user. It calls sudo for the steps that need it.
# Safe to run again. docs/setup.md, "Worker machines", explains the setup.
set -euo pipefail

KIT="$(cd "$(dirname "$0")" && pwd)"
DRY=0 KEY="" WORKER=factory
SUBNET=172.30.0.0/24   # the same subnet as init-host.sh, so the firewall rules read the same on every machine
if [ "$(id -u)" = 0 ] && [ "${SUDO_USER:-root}" != root ]; then
  echo "Run init-worker.sh without sudo, as $SUDO_USER. The script calls sudo for the steps that need it." >&2; exit 1
fi

usage() {
  cat <<EOF
Usage: $0 --key "<public key of the factory host>" [--user <name>] [--dry-run]

  --key      The ssh public key of the orchestrator user on the factory host, one line.
             On the factory host: cat ~/.ssh/id_ed25519.pub
  --user     The worker user that the factory host logs in as. Default: factory.
  --dry-run  Print every command. Change nothing.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --key) KEY="${2:-}"; shift 2 ;;
    --user) WORKER="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done
die() { echo "$*" >&2; exit 1; }
[ -n "$KEY" ] || { usage >&2; die "Missing: --key"; }
# One key, with no options in front of it: the script adds its own `restrict`, and a key must not bring a command="...".
key_re='^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]+( [^[:cntrl:]]*)?$'
[[ "$KEY" != *$'\n'* && "$KEY" =~ $key_re ]] || die "--key is not an ssh public key on one line: ${KEY:0:40}..."
[[ "$WORKER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "--user is not a user name: $WORKER"

run() { if [ "$DRY" = 1 ]; then printf '+ %q' "$1"; shift; printf ' %q' "$@"; echo; else "$@"; fi; }
say() { printf '\n== %s\n' "$*"; }

say "Check this machine"
for t in docker sudo; do command -v "$t" >/dev/null || die "Missing: $t"; done
os="$(docker info -f '{{.OperatingSystem}}' 2>/dev/null)" || die "Docker does not answer. Start Docker, then run this again."
# Docker Desktop runs containers in its own VM, where the host's iptables rules do not apply.
[[ "$os" != *"Docker Desktop"* ]] || die "Docker Desktop runs containers in a VM, so the factory firewall cannot apply.
Run Docker in a Linux VM that you control (colima or OrbStack), then run this script inside that VM."
# sudo first, on its own: without it the chain check below cannot tell "no chain" from "no sudo".
sudo -v || die "sudo did not work. Run this script in a terminal where sudo can ask for your password."
sudo iptables -nL DOCKER-USER >/dev/null 2>&1 || die "No iptables chain DOCKER-USER. The factory firewall needs Docker's iptables rules on Linux.
On macOS, run Docker in a Linux VM (colima or OrbStack) and run this script inside it."

say "Worker user $WORKER"
id "$WORKER" >/dev/null 2>&1 || run sudo useradd --create-home --shell /bin/bash "$WORKER"
# The docker group gives full control of Docker on this machine. That is the access the factory host needs.
run sudo usermod -aG docker "$WORKER"
# restrict: no port forwarding, no agent forwarding, no terminal.
# check: DOCKER_HOST=ssh:// runs `docker system dial-stdio` over a plain ssh command, so it needs none of them. Not tested yet.
line="restrict $KEY"
home="$(getent passwd "$WORKER" | cut -d: -f6 || true)"; home="${home:-/home/$WORKER}"
if [ "$DRY" = 1 ]; then
  echo "+ add to $home/.ssh/authorized_keys (mode 600, owner $WORKER): $line"
elif ! sudo grep -qxF -- "$line" "$home/.ssh/authorized_keys" 2>/dev/null; then
  sudo install -d -m 700 -o "$WORKER" -g "$WORKER" "$home/.ssh"
  printf '%s\n' "$line" | sudo tee -a "$home/.ssh/authorized_keys" >/dev/null
  sudo chown "$WORKER:$WORKER" "$home/.ssh/authorized_keys"; sudo chmod 600 "$home/.ssh/authorized_keys"
fi

say "Run network $SUBNET with firewall rules"
if [ "$DRY" = 1 ] || ! docker network inspect factory-net >/dev/null 2>&1; then
  run docker network create factory-net --subnet "$SUBNET"
fi
if [ "$DRY" = 1 ]; then "$KIT/host/factory-firewall.sh" --dry-run "$SUBNET"; else sudo "$KIT/host/factory-firewall.sh" "$SUBNET"; fi
# The rules do not survive a reboot. The unit adds them again at each boot, after Docker made its chains.
run sudo install -m 755 "$KIT/host/factory-firewall.sh" /usr/local/sbin/factory-firewall.sh
run sudo install -m 644 "$KIT/host/factory-firewall.service" /etc/systemd/system/factory-firewall.service
run sudo systemctl daemon-reload
run sudo systemctl enable --now factory-firewall.service

say "Runner image factory-runner:latest"
run docker build -t factory-runner:latest -f "$KIT/host/runner.Dockerfile" "$KIT/host"

say "Next steps, on the factory host"
cat <<EOF
1. Check the connection as the orchestrator user:
   DOCKER_HOST=ssh://$WORKER@$(hostname) docker info
2. Add this machine to FACTORY_MACHINES in /etc/factory/common.env, with its slot count. For example:
   FACTORY_MACHINES="local=2 ssh://$WORKER@$(hostname)=2"
3. In the Tailscale access rules, let only the factory host reach port 22 on this machine.
4. Build the runner image here again each time host/runner.Dockerfile changes.
EOF
