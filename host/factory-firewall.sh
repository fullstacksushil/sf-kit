#!/usr/bin/env bash
# Firewall rules for the run network. Run containers may reach the internet, each other and Phoenix.
# Not private networks, not this host. Safe to run again: it adds only the rules that are missing.
# init-host.sh runs it once. factory-firewall.service runs it at each boot, after Docker made its chains.
#   factory-firewall.sh [--dry-run] [subnet]      Default subnet: the one of the Docker network factory-net.
set -euo pipefail
DRY=0; [ "${1:-}" = --dry-run ] && { DRY=1; shift; }
SUBNET="${1:-$(docker network inspect factory-net -f '{{(index .IPAM.Config 0).Subnet}}')}"
rule() { if [ "$DRY" = 1 ]; then echo "+ iptables -I $*"; elif ! iptables -C "$@" 2>/dev/null; then iptables -I "$@"; fi; }
# 169.254.0.0/16 holds the cloud metadata address. 100.64.0.0/10 is carrier-grade NAT, also the range Tailscale gives its machines.
for cidr in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
  rule DOCKER-USER -s "$SUBNET" -d "$cidr" -j DROP
done
rule DOCKER-USER -s "$SUBNET" -d "$SUBNET" -j ACCEPT
rule INPUT -s "$SUBNET" -j DROP
# Inserted above the DROP: replies to connections the host opened (your browser to Phoenix on 6006) pass.
# Agents still cannot open a connection to the host.
rule INPUT -s "$SUBNET" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
