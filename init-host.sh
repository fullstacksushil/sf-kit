#!/usr/bin/env bash
# Set up the self-hosted software factory services on this machine (a VPS or a laptop).
# Installs: Inngest + Postgres + Redis (Docker Compose), optional Phoenix traces, the run network
# with firewall rules, the runner image, and the orchestrator app as a systemd service.
# Safe to run again: it never overwrites secrets or existing firewall rules.
# Design and reasons: ../playbooks/04-infra-build-self-hosted.md, "Option B".
set -euo pipefail

KIT="$(cd "$(dirname "$0")" && pwd)"
OBS=none DRY=0 SYSTEMD=1
SUBNET=172.30.0.0/24
ETC=/etc/factory OPT=/opt/factory
ME="$(id -un)"

usage() {
  cat <<EOF
Usage: $0 [--observability none|phoenix|langfuse] [--no-systemd] [--dry-run]

  --observability  phoenix: run Arize Phoenix next to Inngest (one container).
                   langfuse: print the steps to self-host Langfuse (needs 4 cores, 16 GiB).
                   none (default): Inngest dashboard only.
  --no-systemd     Do not install the orchestrator service. Run it by hand instead.
  --dry-run        Print every command. Change nothing.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --observability) OBS="$2"; shift 2 ;;
    --no-systemd) SYSTEMD=0; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done
case "$OBS" in none|phoenix|langfuse) ;; *) echo "--observability must be none, phoenix or langfuse" >&2; exit 2 ;; esac

run() { if [ "$DRY" = 1 ]; then printf '+ %q' "$1"; shift; printf ' %q' "$@"; echo; else "$@"; fi; }
say() { printf '\n== %s\n' "$*"; }
# Write stdin to a root-owned path, readable only by $ME. Never overwrite.
write_secret() {
  local path="$1" body; body="$(cat)"
  if sudo test -e "$path" 2>/dev/null && [ "$DRY" = 0 ]; then echo "keep existing $path"; return; fi
  if [ "$DRY" = 1 ]; then echo "+ write $path (mode 600, owner $ME):"; sed -E 's/^([A-Z_]*(KEY|SECRET|PASSWORD)[A-Z_]*)=.+/\1=<generated>/' <<<"$body"; return; fi
  printf '%s\n' "$body" | sudo tee "$path" >/dev/null
  sudo chown "$ME" "$path"; sudo chmod 600 "$path"
}

say "Check tools"
for t in docker node npm openssl sudo; do command -v "$t" >/dev/null || { echo "Missing: $t" >&2; exit 1; }; done
docker compose version >/dev/null || { echo "Missing: docker compose plugin" >&2; exit 1; }
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' || { echo "Need Node 22 or later" >&2; exit 1; }
id -nG "$ME" | grep -qw docker || echo "Warning: $ME is not in the docker group. The orchestrator service needs it."

say "Secrets in $ETC"
run sudo mkdir -p "$ETC" "$OPT"
run sudo chown "$ME" "$OPT"
SIGNING_KEY="$(openssl rand -hex 32)" EVENT_KEY="$(openssl rand -hex 16)"
if [ "$DRY" = 0 ] && sudo test -e "$ETC/inngest.env"; then
  # Reuse the keys already on disk, so both files agree.
  SIGNING_KEY="$(sudo sed -n 's/^INNGEST_SIGNING_KEY=//p' "$ETC/inngest.env")"
  EVENT_KEY="$(sudo sed -n 's/^INNGEST_EVENT_KEY=//p' "$ETC/inngest.env")"
fi
write_secret "$ETC/inngest.env" <<EOF
INNGEST_SIGNING_KEY=$SIGNING_KEY
INNGEST_EVENT_KEY=$EVENT_KEY
POSTGRES_PASSWORD=$(openssl rand -hex 16)
EOF
OTEL_LINE="# OTEL_TRACES_ENDPOINT=http://phoenix:6006/v1/traces"
[ "$OBS" = phoenix ] && OTEL_LINE="OTEL_TRACES_ENDPOINT=http://phoenix:6006/v1/traces"
write_secret "$ETC/orchestrator.env" <<EOF
# Inngest (self-hosted). The keys match $ETC/inngest.env.
INNGEST_DEV=0
INNGEST_BASE_URL=http://127.0.0.1:8288
# The URL Inngest (a container) uses to call this app. The host firewall must allow it (next steps, 4).
INNGEST_SERVE_ORIGIN=http://host.docker.internal:3000
INNGEST_SIGNING_KEY=$SIGNING_KEY
INNGEST_EVENT_KEY=$EVENT_KEY
PORT=3000

# CHANGEME: the repo this factory works on, and its tokens.
GITHUB_REPO=owner/name
GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 20)
# Fine-grained PAT, this repo only: Contents, Pull requests, Issues = read/write.
FACTORY_PAT=
# From \`claude setup-token\`.
CLAUDE_CODE_OAUTH_TOKEN=

# Throttle and project setup. Start with low slots.
FACTORY_SLOTS=2
RUN_MAX_MINUTES=45
RUN_SETUP="npm ci && npm run --if-present db:migrate && npm run --if-present db:seed"

# Agent traces over OTLP/HTTP. Phoenix: as below. Self-hosted Langfuse:
#   OTEL_TRACES_ENDPOINT=http://<langfuse-host>:3000/api/public/otel/v1/traces
#   OTEL_TRACES_HEADERS="Authorization=Basic <base64 of pk-lf-...:sk-lf-...>,x-langfuse-ingestion-version=4"
$OTEL_LINE
EOF

say "Run network $SUBNET with firewall rules"
if [ "$DRY" = 1 ] || ! docker network inspect factory-net >/dev/null 2>&1; then
  run docker network create factory-net --subnet "$SUBNET"
fi
# Run containers may reach the internet, each other and Phoenix. Not private networks, not this host.
rule() { if [ "$DRY" = 1 ] || ! sudo iptables -C "$@" 2>/dev/null; then run sudo iptables -I "$@"; fi; }
for cidr in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16; do
  rule DOCKER-USER -s "$SUBNET" -d "$cidr" -j DROP
done
rule DOCKER-USER -s "$SUBNET" -d "$SUBNET" -j ACCEPT
rule INPUT -s "$SUBNET" -j DROP
echo "These iptables rules do not survive a reboot. Save them with iptables-save or your distro's tool."

say "Inngest, Postgres, Redis${OBS:+ (observability: $OBS)}"
run cp "$KIT/host/compose.yaml" "$OPT/compose.yaml"
profile=(); [ "$OBS" = phoenix ] && profile=(--profile phoenix)
run docker compose -f "$OPT/compose.yaml" --env-file "$ETC/inngest.env" "${profile[@]}" up -d

say "Runner image factory-runner:latest"
run docker build -t factory-runner:latest -f "$KIT/host/runner.Dockerfile" "$KIT/host"

say "Orchestrator app in $OPT/orchestrator"
run mkdir -p "$OPT/orchestrator"
run cp -r "$KIT/orchestrator/src" "$KIT/orchestrator/package.json" "$KIT/orchestrator/tsconfig.json" "$OPT/orchestrator/"
[ -f "$KIT/orchestrator/package-lock.json" ] && run cp "$KIT/orchestrator/package-lock.json" "$OPT/orchestrator/"
run npm --prefix "$OPT/orchestrator" install --omit=dev --no-audit --no-fund

if [ "$SYSTEMD" = 1 ]; then
  say "systemd service factory-orchestrator"
  if [ "$DRY" = 1 ]; then
    echo "+ install $KIT/host/factory-orchestrator.service as /etc/systemd/system/factory-orchestrator.service (User=$ME)"
  else
    sed "s/__USER__/$ME/" "$KIT/host/factory-orchestrator.service" | sudo tee /etc/systemd/system/factory-orchestrator.service >/dev/null
  fi
  run sudo systemctl daemon-reload
  echo "Not started yet: setup-wizard.sh fills the tokens and starts it."
fi

if [ "$OBS" = langfuse ]; then
  say "Langfuse (manual)"
  cat <<'EOF'
Self-hosted Langfuse needs at least 4 cores and 16 GiB, and runs web, worker, Postgres,
ClickHouse, Redis and MinIO. Langfuse calls its Docker Compose setup local/testing only.
Use a separate VM if you can:
  git clone https://github.com/langfuse/langfuse.git && cd langfuse
  # change every "# CHANGEME" secret: NEXTAUTH_SECRET, SALT, ENCRYPTION_KEY (openssl rand -hex 32) ...
  docker compose up -d
Then create a project, copy its keys, and set OTEL_TRACES_ENDPOINT and OTEL_TRACES_HEADERS
in /etc/factory/orchestrator.env (examples are in that file).
Docs: https://langfuse.com/self-hosting/deployment/docker-compose
EOF
fi

say "Next steps"
cat <<EOF
1. Make /webhooks/* public: edit $KIT/host/Caddyfile, then install it in Caddy.
   Laptop: use a tunnel that forwards only /webhooks/* instead.
2. Run $KIT/setup-wizard.sh. It walks you through the rest and checks each value:
   the repo, the GitHub token, the Claude token, optional Langfuse keys, the firewall rule
   for port 3000, starting the orchestrator, and the GitHub webhook.
   Without the firewall rule, Inngest logs "dial tcp 172.17.0.1:3000: i/o timeout" and no run starts.
3. Dashboards: on this machine, open http://localhost:8288 (Inngest) and http://localhost:6006 (Phoenix).
   On a VPS, tunnel them first: ssh -L 8288:localhost:8288 -L 6006:localhost:6006 <you>@<vps-address>
4. Test: add agent:implement to a small issue. Then run the checks in playbooks/04, "Checks for Option B".
EOF
