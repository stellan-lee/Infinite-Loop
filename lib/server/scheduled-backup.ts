/*
 * Scheduled, retained backups of the data directory.
 *
 * `createBackup()` (backup.ts) takes one snapshot; `bun run backup` is a
 * manual invocation of it. Relying on that alone means the recovery point is
 * only ever as fresh as the last time an operator remembered to run it — for
 * an unattended orchestrator that is not a backup strategy.
 *
 * This module is the automation layer. `runScheduledBackup()` writes one
 * snapshot into a dedicated backup directory and then prunes that directory to
 * a fixed number of generations; the daemon in `scripts/scheduled-backup.ts`
 * calls it on an interval. The logic lives here, split out from the script, so
 * it is unit-testable — the script is a thin loop around these functions.
 *
 * Why the backup directory must live OUTSIDE the data directory:
 *  - Failure domain. An archive written next to the data it protects shares
 *    that data's fate — a deleted or corrupted volume takes both.
 *  - Unbounded growth. `createBackup()` archives every top-level entry of the
 *    data dir, so a backup dir nested inside it would fold every prior archive
 *    into each new one.
 * `resolveScheduledBackupConfig()` rejects that configuration outright.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createBackup,
  isBackupArchiveName,
  isInside,
  type CreateBackupResult,
} from './backup';

/** Hours between snapshots when `INFLOOP_BACKUP_INTERVAL_HOURS` is unset. */
export const DEFAULT_INTERVAL_HOURS = 24;
/** Snapshot generations retained when `INFLOOP_BACKUP_KEEP` is unset. */
export const DEFAULT_KEEP = 7;

/** Accepts a plain decimal number with an optional fractional part — no sign,
 *  no exponent, no trailing garbage. Mirrors config-validation.ts's strictness. */
const NUMBER_RE = /^\d+(?:\.\d+)?$/;
/** Accepts a plain non-negative decimal integer. */
const INTEGER_RE = /^\d+$/;

export interface ScheduledBackupConfig {
  /** Absolute directory snapshots are written to and pruned within. */
  backupDir: string;
  /** Milliseconds between snapshots in daemon mode. */
  intervalMs: number;
  /** Number of most-recent snapshot generations to retain. */
  keep: number;
}

export interface ResolvedScheduledBackupConfig {
  /** The parsed config — present only when `errors` is empty. */
  config?: ScheduledBackupConfig;
  /** One human-readable message per misconfigured variable. */
  errors: string[];
}

/** Resolve the data directory from `env` — mirrors paths.ts `dataDir()` but
 *  reads only the passed map, keeping `resolveScheduledBackupConfig` pure. */
function resolveDataDir(env: Record<string, string | undefined>): string {
  return path.resolve(
    env.INFLOOP_DATA_DIR || path.join(os.homedir(), '.infinite-loop'),
  );
}

/**
 * Parse the scheduled-backup configuration from `env`. Pure — reads only the
 * passed map, never `process.env`, and never exits the process; the script
 * owns the fail-fast decision. Returns one error string per misconfigured
 * variable, or a populated `config` when every variable is sound.
 *
 * Three states per variable, only one an error:
 *  - unset / empty   → the documented default applies (`INFLOOP_BACKUP_DIR`
 *                      excepted: it is required, there is no safe default).
 *  - a valid value   → used.
 *  - a malformed value → an error; the caller refuses to start.
 */
export function resolveScheduledBackupConfig(
  env: Record<string, string | undefined>,
): ResolvedScheduledBackupConfig {
  const errors: string[] = [];

  // --- backup directory: required, must be outside the data directory ----
  let backupDir = '';
  const rawDir = (env.INFLOOP_BACKUP_DIR ?? '').trim();
  if (rawDir === '') {
    errors.push(
      'INFLOOP_BACKUP_DIR is required — set it to a directory OUTSIDE the ' +
        'data directory (ideally on a different disk or host). There is no ' +
        'safe default: a backup beside the data it protects is worthless.',
    );
  } else {
    backupDir = path.resolve(rawDir);
    const dataRoot = resolveDataDir(env);
    if (isInside(dataRoot, backupDir)) {
      errors.push(
        `INFLOOP_BACKUP_DIR (${backupDir}) resolves inside the data ` +
          `directory (${dataRoot}). It must be a separate location: a nested ` +
          `backup dir shares the data's failure domain and would be folded ` +
          `into every subsequent archive, growing without bound.`,
      );
    }
  }

  // --- interval: optional, a positive number of hours --------------------
  let intervalHours = DEFAULT_INTERVAL_HOURS;
  const rawInterval = (env.INFLOOP_BACKUP_INTERVAL_HOURS ?? '').trim();
  if (rawInterval !== '') {
    if (!NUMBER_RE.test(rawInterval) || Number(rawInterval) <= 0) {
      errors.push(
        `INFLOOP_BACKUP_INTERVAL_HOURS is set to "${rawInterval}" — expected ` +
          'a positive number of hours between snapshots.',
      );
    } else {
      intervalHours = Number(rawInterval);
    }
  }

  // --- keep: optional, a positive integer number of generations ----------
  let keep = DEFAULT_KEEP;
  const rawKeep = (env.INFLOOP_BACKUP_KEEP ?? '').trim();
  if (rawKeep !== '') {
    if (!INTEGER_RE.test(rawKeep) || Number(rawKeep) < 1) {
      errors.push(
        `INFLOOP_BACKUP_KEEP is set to "${rawKeep}" — expected a positive ` +
          'integer number of snapshot generations to retain (at least 1).',
      );
    } else {
      keep = Number(rawKeep);
    }
  }

  if (errors.length > 0) return { errors };
  return {
    errors: [],
    config: { backupDir, intervalMs: intervalHours * 60 * 60 * 1000, keep },
  };
}

export interface PruneResult {
  /** Archive filenames deleted, oldest-first. */
  deleted: string[];
  /** Archive filenames retained, oldest-first. */
  kept: string[];
}

/**
 * Delete the oldest auto-named snapshots in `dir` until at most `keep` remain.
 *
 * Only files matching `isBackupArchiveName` are ever considered or deleted —
 * an operator's hand-named `--out` archive, or any unrelated file sharing the
 * directory, is left untouched. The timestamped archive names sort
 * lexicographically into chronological order, so the lexicographic sort *is*
 * the age order. A missing directory is treated as empty (nothing to prune).
 */
export async function pruneBackups(
  dir: string,
  keep: number,
): Promise<PruneResult> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { deleted: [], kept: [] };
    }
    throw err;
  }

  const archives = entries.filter(isBackupArchiveName).sort();
  if (archives.length <= keep) return { deleted: [], kept: archives };

  const cut = archives.length - keep;
  const deleted = archives.slice(0, cut);
  const kept = archives.slice(cut);
  for (const name of deleted) {
    await fs.rm(path.join(dir, name), { force: true });
  }
  return { deleted, kept };
}

export interface ScheduledBackupResult {
  /** The snapshot just written. */
  backup: CreateBackupResult;
  /** Retention-prune outcome over the backup directory. */
  prune: PruneResult;
}

/**
 * Take one snapshot into `config.backupDir`, then prune the directory to
 * `config.keep` generations. Pruning runs *after* the new snapshot is written,
 * so the freshly-created archive is counted among the retained generations.
 */
export async function runScheduledBackup(
  config: ScheduledBackupConfig,
  now?: Date,
): Promise<ScheduledBackupResult> {
  const backup = await createBackup({ outDir: config.backupDir, now });
  const prune = await pruneBackups(config.backupDir, config.keep);
  return { backup, prune };
}
