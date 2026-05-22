/*
 * CLI / daemon: scheduled, retained backups of the Infinite Loop data dir.
 *
 *   bun scripts/scheduled-backup.ts            # daemon: back up every interval
 *   bun scripts/scheduled-backup.ts --once     # take one backup, then exit
 *
 * Without `--once` this runs forever: it takes a snapshot immediately on start
 * — so a fresh deployment has a backup at once, and a broken backup config is
 * surfaced now rather than an interval later — then repeats every
 * INFLOOP_BACKUP_INTERVAL_HOURS, pruning to INFLOOP_BACKUP_KEEP generations
 * after each one. It is the process behind the `backup` docker-compose
 * sidecar. `--once` is for a host-level cron / systemd timer instead.
 *
 * Configuration (see docs/backup-restore.md, .env.example):
 *   INFLOOP_BACKUP_DIR             required — where archives are written.
 *                                  Must resolve OUTSIDE INFLOOP_DATA_DIR.
 *   INFLOOP_BACKUP_INTERVAL_HOURS  hours between snapshots (default 24). A
 *                                  sub-second interval is unsupported: archive
 *                                  names carry whole-second precision, so two
 *                                  snapshots in one second collide on their
 *                                  name and the later tick fails (and, in the
 *                                  daemon, is logged and retried next interval).
 *   INFLOOP_BACKUP_KEEP            snapshot generations retained (default 7).
 *
 * Exit codes: 0 success / clean shutdown; 1 a backup failed (`--once` only);
 * 2 misconfiguration — fail fast, before any work, in either mode.
 *
 * The backup/restore logic lives in lib/server/backup.ts and the schedule
 * logic in lib/server/scheduled-backup.ts; this file is the thin CLI shell.
 * Full guide: docs/backup-restore.md.
 */

import {
  resolveScheduledBackupConfig,
  runScheduledBackup,
  type ScheduledBackupConfig,
  type ScheduledBackupResult,
} from '../lib/server/scheduled-backup';

const USAGE = 'Usage: bun scripts/scheduled-backup.ts [--once]';

/* One timestamped line per event. Docker captures stdout and stderr, so these
 * are the operator's window onto the sidecar — keep them greppable. */
function log(msg: string): void {
  console.log(`${new Date().toISOString()} [scheduled-backup] ${msg}`);
}
function logError(msg: string): void {
  console.error(`${new Date().toISOString()} [scheduled-backup] ${msg}`);
}

function parseArgs(argv: string[]): { once: boolean } {
  let once = false;
  for (const arg of argv) {
    if (arg === '--once') {
      once = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      console.error(`error: unknown argument: ${arg}`);
      console.error(USAGE);
      process.exit(2);
    }
  }
  return { once };
}

function summarize(result: ScheduledBackupResult): string {
  const mib = (result.backup.bytes / 1024 / 1024).toFixed(2);
  const pruned = result.prune.deleted.length;
  return (
    `backup written: ${result.backup.outPath} (${mib} MiB); ` +
    `${result.prune.kept.length} generation(s) retained` +
    (pruned > 0 ? `, ${pruned} old archive(s) pruned` : '')
  );
}

/** Run exactly one snapshot. Returns whether it succeeded; never throws — a
 *  failure is logged so a transient cause cannot kill the daemon loop. */
async function backupOnce(config: ScheduledBackupConfig): Promise<boolean> {
  try {
    const result = await runScheduledBackup(config);
    log(summarize(result));
    if (result.backup.manifest.uncoveredPaths.length > 0) {
      logError(
        'WARNING: these configured paths resolve OUTSIDE the data directory ' +
          'and are NOT in this backup — back them up separately: ' +
          result.backup.manifest.uncoveredPaths.join(', '),
      );
    }
    return true;
  } catch (err) {
    logError(`backup failed: ${(err as Error).message}`);
    return false;
  }
}

const { once } = parseArgs(process.argv.slice(2));

// Fail fast on a bad config — before any work, in both modes.
const resolved = resolveScheduledBackupConfig(process.env);
if (!resolved.config) {
  for (const error of resolved.errors) logError(`config error: ${error}`);
  process.exit(2);
}
const config = resolved.config;

if (once) {
  const ok = await backupOnce(config);
  process.exit(ok ? 0 : 1);
}

/* ── daemon mode ───────────────────────────────────────────────────────── */

const intervalHours = config.intervalMs / 1000 / 60 / 60;
log(
  `starting: backup dir ${config.backupDir}, ` +
    `every ${intervalHours}h, keeping ${config.keep} generation(s)`,
);

let stopping = false;
let wake: (() => void) | undefined;
let sleepTimer: ReturnType<typeof setTimeout> | undefined;

/* SIGTERM (docker stop) / SIGINT (Ctrl-C): stop after the current snapshot,
 * cutting any in-progress interval sleep short so shutdown is prompt. */
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  log(`received ${signal} — shutting down`);
  if (sleepTimer) clearTimeout(sleepTimer);
  wake?.();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

while (!stopping) {
  // A failed tick is logged and tolerated: a transient cause (a full disk, a
  // brief volume hiccup) must not kill the daemon — the next interval retries.
  // Misconfiguration is already excluded above, so a tick failure here is
  // operational, not fatal.
  await backupOnce(config);
  if (stopping) break;
  await new Promise<void>((resolve) => {
    wake = resolve;
    sleepTimer = setTimeout(resolve, config.intervalMs);
  });
}

log('stopped');
process.exit(0);
