#!/usr/bin/env bash
set -euo pipefail
umask 077
BACKUP_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
export BACKUP_STARTED_AT="$(date +%s)"
export BACKUP_RUN_ID="$(cat /proc/sys/kernel/random/uuid)"
stage=configuration
report() {
  if [[ -n "${BACKUP_MONITOR_ENDPOINT:-}" ]]; then
    timeout 15s python3 "$BACKUP_SCRIPT_DIR/backup-check-in.py" "$@" || echo 'Backup check-in failed or timed out' >&2
  fi
}
finish() {
  result=$?
  trap - EXIT
  if (( result != 0 )); then report failed "$stage"; fi
  exit "$result"
}
trap finish EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
report started
: "${POSTGRES_COMPOSE_PROJECT:?Set the production Coolify compose project identifier}"
: "${RESTIC_REPOSITORY:?Set encrypted off-host restic repository}"
: "${RESTIC_PASSWORD_FILE:?Set root-readable restic password file}"
BACKUP_TAG="${BACKUP_TAG:-bam-production}"
[[ "$BACKUP_TAG" =~ ^bam-[a-z0-9-]+$ ]] || { echo 'Invalid backup environment tag'; exit 1; }
stage=lock
exec 9>"/run/lock/${BACKUP_TAG}.lock"
flock -n 9 || exit 1
# Resolve the running database after each deployment instead of retaining a
# container name that Coolify replaces. Refuse ambiguous or absent matches.
stage=database
mapfile -t containers < <(docker ps --filter "label=com.docker.compose.project=$POSTGRES_COMPOSE_PROJECT" --filter 'label=com.docker.compose.service=postgres' --format '{{.ID}}')
[[ ${#containers[@]} -eq 1 ]] || { echo 'Expected exactly one running production PostgreSQL container'; exit 1; }
attempt="${BACKUP_TAG}-pending-$(date +%s)-$$"
# The database password stays inside the existing container. No plaintext dump
# is persisted on the VPS. pipefail prevents a failed dump from looking healthy.
stage=dump_upload
docker exec "${containers[0]}" sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' |
  restic backup --stdin --stdin-filename database.dump --tag "$attempt"
# A failed producer can still leave a restic snapshot. Only a fully successful
# pipeline earns the recoverable tag; incomplete attempts never count for RPO.
stage=promotion
restic tag --tag "$attempt" --set "$BACKUP_TAG"
stage=retention
restic forget --tag "$BACKUP_TAG" --keep-within 7d --keep-daily 30 --prune
report succeeded
# Optional legacy heartbeat retained during acceptance/rollback. Monitoring
# failure must not change the result of the successful backup pipeline.
if [[ -n "${BACKUP_MONITOR_URL:-}" ]]; then
  curl --fail --silent --max-time 10 "$BACKUP_MONITOR_URL" >/dev/null 2>&1 || echo 'Legacy backup check-in failed' >&2
fi
