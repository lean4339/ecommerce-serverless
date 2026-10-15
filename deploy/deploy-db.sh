#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 1 || ! "$1" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]]; then
  echo 'Uso: deploy/deploy-db.sh usuario@servidor (acceso SSH y Docker Compose instalados)' >&2
  exit 2
fi
remote="$1"
ssh_options=(-o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new)
identity_file="${SSH_IDENTITY_FILE:-/home/leandro/.ssh/id_ed25519_vultr_lab}"
if [[ -f "$identity_file" ]]; then ssh_options+=(-i "$identity_file"); fi
project_dir="$(cd -- "$(dirname -- "$0")/.." && pwd)"
backup_file="$project_dir/backups/ecommerce-lab-migration.dump"
test -s "$backup_file"
ssh "${ssh_options[@]}" "$remote" 'command -v docker >/dev/null && docker compose version >/dev/null && mkdir -p /opt/ecommerce-db && chmod 700 /opt/ecommerce-db'
scp "${ssh_options[@]}" "$project_dir/deploy/compose.postgres.yaml" "$backup_file" "$remote:/opt/ecommerce-db/"
ssh "${ssh_options[@]}" "$remote" 'bash -s' <<'REMOTE'
set -euo pipefail
cd /opt/ecommerce-db
mkdir -p secrets
chmod 700 secrets
if [[ ! -s secrets/postgres_password ]]; then
  (umask 077; openssl rand -hex 32 > secrets/postgres_password)
fi
chmod 600 ecommerce-lab-migration.dump secrets/postgres_password
# Verifica el archivo antes de crear la instancia.
docker run --rm --mount type=bind,src=/opt/ecommerce-db/ecommerce-lab-migration.dump,dst=/backup.dump,readonly postgres:17 pg_restore --list /backup.dump >/dev/null
docker compose -f compose.postgres.yaml up -d --wait postgres </dev/null
existing="$(docker compose -f compose.postgres.yaml exec -T postgres psql -U lab -d ecommerce_lab -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public'" </dev/null)"
if [[ "$existing" != 0 ]]; then
  echo 'La base de destino ya contiene tablas; no se sobrescribe.' >&2
  exit 1
fi
docker compose -f compose.postgres.yaml exec -T postgres pg_restore -U lab -d ecommerce_lab --no-owner --no-acl --exit-on-error --single-transaction < ecommerce-lab-migration.dump
docker compose -f compose.postgres.yaml exec -T postgres psql -U lab -d ecommerce_lab -c 'ANALYZE; SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size; SELECT count(*) AS orders FROM orders; SELECT count(*) AS browsing_events FROM browsing_events;' </dev/null
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' ecommerce-remote-postgres-1
REMOTE
printf 'Base migrada. Conexión cifrada: ssh -N -L 15433:127.0.0.1:5433 %s\n' "$remote"
