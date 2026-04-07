#!/bin/bash
# Usage: ./deploy.sh
# Rolling redeploy: destroys and recreates each app server one at a time
# via Terraform, then flushes Redis. Handles scale up/down.
# Run from the deploy/ directory (needs terraform state).
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

NAT_IP=$(terraform output -raw nat_ip)
REDIS_IP=$(terraform output -raw redis_private_ip)
CURRENT_COUNT=$(terraform output -json app_private_ips | jq length)
DESIRED_COUNT=$(grep -E '^\s*count\s*=' app.tf | head -1 | tr -cd '0-9')

SSH="ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -o BatchMode=yes"

app_ip() { echo "10.0.1.$(($1 + 11))"; }

wait_healthy() {
  local ip=$1
  echo "==> Waiting for $ip to become healthy..."
  for i in $(seq 1 60); do
    if $SSH -J root@"$NAT_IP" root@"$ip" \
      curl -sf --max-time 5 http://localhost:3000/ > /dev/null 2>&1; then
      echo "==> $ip healthy"
      return 0
    fi
    echo "    attempt $i/60..."
    sleep 10
  done
  echo "ERROR: $ip did not become healthy" >&2
  return 1
}

echo "==> Current: $CURRENT_COUNT servers, desired: $DESIRED_COUNT servers"

for i in $(seq 0 $((CURRENT_COUNT - 1))); do
  ip=$(app_ip "$i")
  echo "==> Replacing app server $((i + 1)) ($ip)"
  terraform apply -replace="hcloud_server.app[$i]" -auto-approve
  wait_healthy "$ip"
done

# Wait for any newly created servers from scale-up
for i in $(seq "$CURRENT_COUNT" $((DESIRED_COUNT - 1))); do
  wait_healthy "$(app_ip "$i")"
done

echo "==> Flushing Redis cache"
$SSH -J root@"$NAT_IP" root@"$REDIS_IP" redis-cli FLUSHALL

echo "==> Done"
