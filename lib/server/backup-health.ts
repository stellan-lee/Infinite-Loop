/*
 * Backup-freshness probe — the source of the
 * `infloop_backup_last_success_timestamp_seconds` metric.
 *
 * The scheduled-backup sidecar (scripts/scheduled-backup.ts, the `backup`
 * service in docker-compose.yml) writes retained `.tar.gz` snapshots of the
 * data directory on an interval. Nothing watched whether it was still doing
 * so: a sidecar that crash-loops on a bad config, or whose every snapshot
 * fails, leaves the recovery point silently rotting — invisible until a
 * restore is needed and the newest archive is days old.
 *
 * This probe closes that gap. It reads the backup directory and reports when
 * the most recent archive landed, so `/api/metrics` can expose it and
 * `InfiniteLoopBackupStale` can alert on it. It mirrors data-dir-health.ts:
 * a filesystem probe, run live at each scrape, that never throws — every
 * failure collapses to a value the caller renders, never a 500.
 *
 * Freshness is taken from the archive's mtime, not its filename timestamp.
 * The two differ only by the snapshot's write duration, and mtime answers the
 * question that matters — when the archive finished being written to this
 * disk — without re-parsing the `YYYYMMDD-HHMMSS` name format that backup.ts
 * is the sole authority on. Archive *recognition* still goes through that
 * authority via `isBackupArchiveName`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isBackupArchiveName } from './backup';

/**
 * Unix timestamp (whole seconds) of the most recent backup archive, or:
 *
 *  - `null` — `INFLOOP_BACKUP_DIR` is unset: backups are not configured for
 *    this deployment. The caller emits no metric, so `InfiniteLoopBackupStale`
 *    never fires on a deployment that never opted into automated backups.
 *  - `0` — backups *are* configured but no archive could be found (the
 *    directory is missing, unreadable, or holds no recognized archive). This
 *    is deliberately a real, emitted value: it is the only signal that a
 *    configured backup mechanism has never once succeeded — a sidecar that
 *    crash-looped from first boot, or a misdirected `INFLOOP_BACKUP_DIR`.
 *    `time() - 0` is enormous, so the staleness alert fires after its `for:`
 *    grace window. The runbook explains the `0`/1970 reading.
 *
 * Never throws: an unset `INFLOOP_BACKUP_DIR` returns `null`, and every
 * actual failure path resolves to `0` — matching the "any failure is a
 * not-ready signal" contract of `dataDirWritable()`.
 */
export async function backupLastSuccessTimestamp(): Promise<number | null> {
  const configured = (process.env.INFLOOP_BACKUP_DIR ?? '').trim();
  if (configured === '') return null;
  const dir = path.resolve(configured);

  try {
    const archives = (await fs.readdir(dir)).filter(isBackupArchiveName);
    if (archives.length === 0) return 0;

    // Archive names embed a fixed-width `YYYYMMDD-HHMMSS` stamp, so a
    // lexicographic sort is a chronological one — the same property
    // `pruneBackups` relies on. The last name is the newest snapshot.
    const newest = archives.sort()[archives.length - 1];
    const { mtimeMs } = await fs.stat(path.join(dir, newest));
    return Math.floor(mtimeMs / 1000);
  } catch {
    // Missing/unreadable directory, or a readdir→stat race with the sidecar's
    // own prune or failed-snapshot cleanup. Either way: no fresh archive.
    return 0;
  }
}
