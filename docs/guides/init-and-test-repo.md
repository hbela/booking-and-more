# Initialise and test the production backup repository

Part A, step 4 of the production backup setup: create the encrypted restic repository
in R2 and prove the bucket-scoped token can write, read **and delete** there before
anything depends on it. Decision and sizing: [tasklist §2](../production-deployment-tasklist.md).
Run on the Hetzner VPS as root. Restic is already installed there (0.16.4); check with
`restic version`.

Nothing here touches a database, Coolify, or the staging repository. The production
stack does not need to exist yet.

## Prerequisites

- Bucket `bam-production-backups` exists (R2, location hint EEUR, **no lifecycle rules** —
  restic decides what is deleted, and a storage rule removing old objects would remove
  packs that newer snapshots still reference).
- An **Account API token** from R2 → Manage API tokens, permission _Object Read & Write_,
  scoped to that bucket only. Its Access Key ID and Secret Access Key are in KeePassXC.
- Your Cloudflare account ID (R2 overview page). It is not secret.

## 1. Generate the repository password and save it first

```sh
openssl rand -hex 32
```

Copy the output into KeePassXC as **"bam production restic password"** and save the
vault **before continuing**. Without this password the backups cannot be decrypted, and
nobody, including Cloudflare, can recover it. Hex, not base64, per the
[phase 10 password rule](../phase-10-deployment-hetzner-coolify.md).

## 2. Write the credential files where the service will read them

These are the files `bam-backup@production.service` loads with `LoadCredential`
(same layout as staging's `/etc/bam/staging-*`). Write them once, here; do not keep a
second copy under `/root/.config`. `read -rs` keeps the values off the screen and out of
shell history; paste each value and press Enter.

```sh
install -d -m 700 /etc/bam
for name in production-restic.password production-r2-access-key production-r2-secret-key; do
  read -rsp "$name: " value; echo
  install -m 600 /dev/null "/etc/bam/$name"
  printf '%s\n' "$value" > "/etc/bam/$name"
done
unset value
ls -l /etc/bam/production-*
```

Expect three files, `-rw------- root root`, each non-empty. A zero-byte file means a
blank paste; rerun for that one.

## 3. Open a subshell scoped to the production repository

Staging's backups run on this host. Keep production's settings inside a subshell so they
cannot leak into a later command, then `exit` at the end.

```sh
bash
export RESTIC_REPOSITORY="s3:https://ACCOUNT_ID.r2.cloudflarestorage.com/bam-production-backups/booking-and-more"
export RESTIC_PASSWORD_FILE=/etc/bam/production-restic.password
export AWS_ACCESS_KEY_ID="$(cat /etc/bam/production-r2-access-key)"
export AWS_SECRET_ACCESS_KEY="$(cat /etc/bam/production-r2-secret-key)"
```

Replace `ACCOUNT_ID`. Keep the `/booking-and-more` suffix; it is the repository path that
`/etc/bam/production-backup.conf` will name in Part B.

## 4. Initialise

```sh
restic snapshots   # expected to fail: "repository does not exist" / "unable to open config file"
restic init        # created restic repository <id> at s3:...
```

If `restic snapshots` succeeds instead, a repository already exists at that path. Stop and
find out whose it is; never `init` over it.

An `Access Denied` here usually means the token is scoped to a different bucket, or the
access key and secret are swapped.

## 5. Write, read and compare

```sh
mkdir -p /tmp/bam-repo-test
echo "bam production repository test $(date -u +%FT%TZ)" > /tmp/bam-repo-test/test.txt
restic backup /tmp/bam-repo-test --tag bam-repo-test
restic snapshots

restic restore latest --tag bam-repo-test --target /tmp/bam-repo-restore
diff /tmp/bam-repo-test/test.txt /tmp/bam-repo-restore/tmp/bam-repo-test/test.txt && echo MATCH
```

The tag is deliberately not `bam-production`: only snapshots carrying that tag count
towards the backup-age gate and the retention policy.

## 6. Check integrity

```sh
restic check --read-data
```

The repository is a few KiB, so reading everything costs nothing. Expect
`no errors were found`.

## 7. Delete the test snapshot, which proves pruning will work

Retention runs `restic forget … --prune` every half hour, and that needs permission to
delete objects. Test it now rather than discovering it from a full bucket later.

```sh
restic snapshots --tag bam-repo-test   # note the snapshot ID
restic forget <ID> --prune
restic snapshots                       # expected: no snapshots
restic check
```

Name the snapshot by ID. `restic forget --tag bam-repo-test --prune` on its own removes
nothing (`no policy was specified, no snapshots will be removed`). A tag only narrows
which snapshots a keep policy such as `--keep-daily` is applied to, and there is no
policy here.

## 8. Clean up

```sh
rm -rf /tmp/bam-repo-test /tmp/bam-repo-restore
exit   # leave the subshell; the exported credentials go with it
```

In the R2 dashboard, `bam-production-backups/booking-and-more/` now holds `config`,
`keys/`, `data/`, `index/` and `snapshots/`, all of them encrypted.

## Record

Add the following to the tasklist §3 "Initialize the encrypted off-host backup repository"
item. Record the date and the repository ID that `restic init` printed, and that steps 5–7
passed. Never record the password or keys. The timer is **not** configured yet; that is
Part B, after the production stack exists.

## What comes next

The scheduled backup is the existing systemd timer and scripts in `ops/production/`,
not a Coolify scheduled task. It takes a custom-format `pg_dump` every 30 minutes and keeps
everything for 7 days plus 30 dailies. The backup monitor starts timing only when
`bam-production` is registered. See the [release runbook](../production-launch.md),
"Preparation and backups", and the [backup monitor](../backup-monitor.md).
