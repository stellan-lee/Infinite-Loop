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
data volume — a different disk, host, or object store. Automate it on a
schedule (cron, a systemd timer) and keep enough generations to cover the
window you need to recover.

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
