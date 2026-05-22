# Backup & restore

Infinite Loop's reliability features — crash recovery, the durable trigger
queue, the append-only audit log — all protect against a *process* dying.
None of them protects against **disk or volume loss, or operator error**. A
dead volume or a stray `rm` takes your workflows, run history, triggers,
queued runs, settings, and the audit log with it.

Backups close that gap. This page is the procedure.

## What is backed up

Everything under the data directory (`INFLOOP_DATA_DIR` — `~/.infinite-loop`
by default, `/data` in the Docker image):

| Included | Excluded |
|---|---|
| `workflows/` — saved workflows | `pids/` — live child-process records |
| `runs/` — run history | `active-runs/` — in-flight run markers |
| `triggers/` — webhook triggers | `*.tmp` — half-written atomic-write files |
| `connections/` — connections | |
| `queue/` — queued-but-not-started runs | |
| `audit/` — the append-only audit log | |
| `settings.json` | |

`pids/` and `active-runs/` are transient, host-specific state — restoring a
PID file onto another host would make crash recovery try to kill an unrelated
process. Both are recreated automatically on the next boot.

Read-only assets shipped with the app — provider manifests, the workflow
library, webhook plugins — are part of the image, not data, and are not
backed up.

> **Custom storage paths.** If you point `INFLOOP_WORKFLOWS_DIR`,
> `INFLOOP_RUNS_DIR`, `INFLOOP_TRIGGERS_DIR`, or `INFLOOP_CONNECTIONS_DIR` at
> a location *outside* the data directory, that path is not in the archive.
> `backup` prints a warning and records it under `uncoveredPaths` in the
> manifest; you must back those paths up separately. The default deployment
> keeps everything under the data directory, so this does not apply.

## Consistency

A backup is safe to take **while the server is running**. Every store writes
via a temp file plus an atomic `rename`, and `tar` reads each file in a single
pass — so the snapshot captures every file as a complete pre- or post-write
version, never a torn write. The one exception is the audit log, appended in
place: a snapshot caught mid-append may hold a torn final line, which the
audit reader already tolerates (it skips unparseable lines).

## Creating a backup

```bash
bun run backup --out /path/to/infinite-loop-backup.tar.gz
```

Without `--out`, a timestamped `infinite-loop-backup-<UTC>.tar.gz` is written
to the current directory. The archive is a regular gzipped tarball with a
`backup-manifest.json` at its root.

In the Docker deployment, run it inside the container and write to a mounted
path (or copy the archive out afterwards):

```bash
# Write to the data volume, then copy the archive off the host.
docker compose exec infinite-loop bun run backup --out /data/backup.tar.gz
docker compose cp infinite-loop:/data/backup.tar.gz ./backup.tar.gz
docker compose exec infinite-loop rm /data/backup.tar.gz
```

Store the archive somewhere that does **not** share a failure domain with the
data volume — a different disk, host, or object store — and keep enough
generations to cover the window you need to recover. For an unattended
deployment, do not do this by hand: see [Automated backups](#automated-backups).

## Automated backups

`bun run backup` is a manual step. Relying on it alone means the recovery
point is only ever as fresh as the last time someone remembered to run it —
not a backup strategy for an unattended deployment.

The Docker deployment closes that gap with a **`backup` sidecar**. It is part
of `docker-compose.yml` and starts with the stack — no extra step:

```bash
docker compose up -d --build
```

The sidecar runs `scripts/scheduled-backup.ts`: it takes a snapshot
immediately on start, then every `INFLOOP_BACKUP_INTERVAL_HOURS`, and after
each one prunes the backup directory to `INFLOOP_BACKUP_KEEP` generations. The
archives land on their own volume — `infinite-loop-backups`, mounted at
`/backups` — separate from the data volume, so a deleted or corrupted data
volume does not take the backups with it. The data volume is mounted into the
sidecar **read-only**: it can only ever read what it backs up.

| Variable | Default | Meaning |
|---|---|---|
| `INFLOOP_BACKUP_DIR` | `/backups` (set by compose) | Directory archives are written to. Must resolve outside the data directory. |
| `INFLOOP_BACKUP_INTERVAL_HOURS` | `24` | Hours between snapshots. Must be positive. |
| `INFLOOP_BACKUP_KEEP` | `7` | Snapshot generations retained; older ones are pruned. Must be a positive integer. |

Set the two optional knobs in `.env`. Watch the sidecar — and catch a failing
backup — with:

```bash
docker compose logs -f backup
```

A failed snapshot is logged and the sidecar waits for the next interval, so
one transient failure (a full disk, say) does not stop later backups. A
*persistent* failure — or a dead sidecar — does surface on its own: the app
mounts the backup volume read-only and exposes the age of the newest archive
as `infloop_backup_last_success_timestamp_seconds` on `/api/metrics`, and the
shipped `InfiniteLoopBackupStale` alert fires once that archive is over 36
hours old (see [prometheus-alerts.yml](../deploy/prometheus-alerts.yml) and
the [runbook](runbook.md)). `docker compose logs -f backup` is still the
fastest way to see *why* a snapshot failed.

> **Still copy the archives off-host.** The sidecar removes the *manual* and
> *operator-error* failure modes, but `infinite-loop-backups` is a volume on
> the same host — it does not survive the host itself dying. For real disaster
> recovery, ship `/backups` to a different machine or an object store; a cron
> job running `docker compose cp` is enough.

### One-off and non-Docker use

The same script takes a single backup and exits when given `--once` — useful
for a host-level `cron` job or systemd timer when you are not running the
Docker stack:

```bash
INFLOOP_BACKUP_DIR=/var/backups/infinite-loop \
  bun scripts/scheduled-backup.ts --once
```

`INFLOOP_BACKUP_DIR` is required — there is no safe default, since a backup
beside the data it protects is worthless — and must resolve outside the data
directory; the script refuses to start otherwise.

## Inspecting an archive

```bash
bun run restore /path/to/backup.tar.gz --inspect
```

Prints the manifest — when the backup was taken, on which host, the app
version, and any `uncoveredPaths` — without touching any data.

## Restoring

**Stop the server before restoring.** Restoring under a live server races its
writers and corrupts the result.

```bash
# Restore into an empty data directory.
bun run restore /path/to/backup.tar.gz
```

If the data directory is **not empty**, `restore` refuses unless you pass
`--force`. With `--force`, the current contents are first moved aside into a
`.pre-restore-<timestamp>` directory inside the data dir — **not deleted** —
so a mistaken restore is reversible:

```bash
bun run restore /path/to/backup.tar.gz --force
```

Then restart the server. Once you have verified the restore, delete the
`.pre-restore-*` directory to reclaim space.

### Restoring in Docker

```bash
docker compose down                       # stop the server
docker compose cp ./backup.tar.gz infinite-loop:/data/backup.tar.gz
docker compose run --rm infinite-loop \
  bun run restore /data/backup.tar.gz --force
docker compose up -d                      # restart
```

`docker compose run --rm` starts a one-off container with the same data
volume mounted but without starting the server, so the restore runs against a
quiescent data directory.

## Requirements

`tar` and `gzip` must be on `PATH`. Both are present in the Docker image and
on a standard Linux or macOS host.
