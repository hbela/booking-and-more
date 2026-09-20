#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${RESTIC_REPOSITORY:?Set backup repository}"
: "${RESTIC_PASSWORD_FILE:?Set root-readable restic password file}"
: "${RESTORE_CONTAINER:?Set a separate, empty PostgreSQL 18 container}"
: "${RESTORE_DATABASE:?Set an empty rehearsal database name}"
: "${RESTORE_USER:?Set the rehearsal database owner}"
: "${SNAPSHOT_ID:?Select a specific snapshot from restic snapshots --tag bam-production}"
[[ "$RESTORE_DATABASE" == bam_rehearsal_* ]] || { echo "Rehearsal database must start with bam_rehearsal_"; exit 1; }
start=$(date +%s)
# Never use --clean or drop an existing database. An occupied target fails.
restic dump "$SNAPSHOT_ID" database.dump |
  docker exec -i "$RESTORE_CONTAINER" pg_restore --exit-on-error --no-owner --no-privileges -U "$RESTORE_USER" -d "$RESTORE_DATABASE"
elapsed=$(( $(date +%s) - start ))
echo "Restore completed in ${elapsed}s; application validation and key recovery are still required."
test "$elapsed" -lt 14400
