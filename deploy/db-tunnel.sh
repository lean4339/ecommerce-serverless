#!/usr/bin/env bash
set -euo pipefail
remote="${REMOTE_SSH_HOST:-root@45.76.177.4}"
identity="${SSH_IDENTITY_FILE:-/home/leandro/.ssh/id_ed25519_vultr_lab}"
gateway="$(docker network inspect ecommerce-lab_default --format '{{(index .IPAM.Config 0).Gateway}}')"
exec /usr/bin/ssh -N -i "$identity" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=20 -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -L "$gateway:15433:127.0.0.1:5433" "$remote"
