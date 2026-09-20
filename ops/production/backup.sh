#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${POSTGRES_COMPOSE_PROJECT:?Set the production Coolify compose project identifier}"
: "${RESTIC_REPOSITORY:?Set encrypted off-host restic repository}"
: "${RESTIC_PASSWORD_FILE:?Set root-readable restic password file}"
: "${BACKUP_MONITOR_URL:?Set an external dead-man monitor URL with a 50-minute deadline}"
exec 9>/run/lock/bam-backup.lock
flock -n 9 || exit 1
# Resolve the running database after each deployment instead of retaining a
# container name that Coolify replaces. Refuse ambiguous or absent matches.
mapfile -t containers < <(docker ps --filter "label=com.docker.compose.project=$POSTGRES_COMPOSE_PROJECT" --filter 'label=com.docker.compose.service=postgres' --format '{{.ID}}')
[[ ${#containers[@]} -eq 1 ]] || { echo 'Expected exactly one running production PostgreSQL container'; exit 1; }
attempt="bam-pending-$(date +%s)-$$"
# The database password stays inside the existing container. No plaintext dump
# is persisted on the VPS. pipefail prevents a failed dump from looking healthy.
docker exec "${containers[0]}" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' |
  restic backup --stdin --stdin-filename database.dump --tag "$attempt"
# A failed producer can still leave a restic snapshot. Only a fully successful
# pipeline earns the recoverable tag; incomplete attempts never count for RPO.
restic tag --tag "$attempt" --set bam-production
restic forget --tag bam-production --keep-within 7d --keep-daily 30 --prune
curl --fail --silent --show-error --max-time 15 "$BACKUP_MONITOR_URL" >/dev/null
