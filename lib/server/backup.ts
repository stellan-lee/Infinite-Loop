/*
 * Backup & restore for the Infinite Loop data directory.
 *
 * Every reliability feature in this codebase — crash recovery, the durable
 * trigger queue, the append-only audit log — protects against *process*
 * death. None protects against disk/volume loss or operator error: a dead
 * volume or a stray `rm` means total, unrecoverable loss of workflows, run
 * history, triggers, the queue, settings, and the audit log.
 *
 * This module closes that gap. `createBackup()` writes one `.tar.gz`
 * snapshot of `dataDir()`; `restoreBackup()` puts one back.
 *
 * Consistency model. Every store here writes via a temp file plus an atomic
 * `rename` (workflow-store, run-store, queue-store, settings-store). `tar`
 * reads each file in a single pass, so a snapshot taken from a *running*
 * server captures every file as a complete pre- or post-write version —
 * never a torn write. The one file appended in place is the audit log
 * (`audit/audit.jsonl`); a snapshot caught mid-append may hold a torn final
 * line, which the audit reader already tolerates (it trims and parses line by
 * line, skipping anything unparseable). In-flight `*.tmp` files are excluded.
 *
 * Out of scope. The transient, host-specific `pids/` and `active-runs/`
 * directories are excluded — see EXCLUDED_DIRS. Read-only deployment assets
 * bundled with the app (provider manifests, the workflow library, webhook
 * plugins) are not data and are not backed up; they ship with the image.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pkg from '../../package.json';
import { dataDir } from './paths';

/** Marker filename carried at the root of every backup archive. */
const MANIFEST_NAME = 'backup-manifest.json';

/** Identifies an archive as an Infinite Loop backup. */
const BACKUP_FORMAT = 'infinite-loop-backup';

/**
 * Archive layout version. Bump only on a breaking change to the on-disk
 * shape; restore refuses any version it does not recognize.
 */
const BACKUP_FORMAT_VERSION = 1;

/*
 * Transient, host-specific state that is deliberately NOT backed up:
 *  - pids/        one file per live child process. Restored onto another
 *                 host these PIDs name unrelated processes, and crash
 *                 recovery would try to kill them.
 *  - active-runs/ in-flight run markers, meaningful only to the process that
 *                 wrote them; reconciled to `failed` on the next boot.
 * Both directories are recreated automatically on boot.
 */
const EXCLUDED_DIRS = ['pids', 'active-runs'];

/** Prefix of the directory restore moves a non-empty data dir aside into. */
const PRE_RESTORE_PREFIX = '.pre-restore-';

/**
 * A half-written temp file from an in-flight atomic write — `<name>.tmp` from
 * workflow/run/queue/trigger stores, `<name>.tmp.<pid>.<ts>` from the settings
 * store. Excluded from backups: the committed file is always present too.
 */
function isTmpName(name: string): boolean {
  return /\.tmp(\.|$)/.test(name);
}

/*
 * Data-path overrides that may legitimately point OUTSIDE the data directory.
 * When one does, the backup cannot contain it; createBackup() records such a
 * path in `uncoveredPaths` so the operator knows to back it up separately.
 * INFLOOP_DATA_DIR itself is the backup root, not an override.
 */
const OVERRIDE_ENV_VARS = [
  'INFLOOP_WORKFLOWS_DIR',
  'INFLOOP_RUNS_DIR',
  'INFLOOP_TRIGGERS_DIR',
  'INFLOOP_CONNECTIONS_DIR',
];

export interface BackupManifest {
  /** Always `infinite-loop-backup`. */
  format: string;
  /** Archive layout version — see BACKUP_FORMAT_VERSION. */
  formatVersion: number;
  /** ISO-8601 instant the backup was taken. */
  createdAt: string;
  /** `package.json` version of the build that produced the backup. */
  appVersion: string;
  /** Host the backup was taken on — provenance only. */
  hostname: string;
  /** Absolute data directory the backup was taken from. */
  dataDir: string;
  /** Directory names deliberately excluded from the archive. */
  excludedDirs: string[];
  /**
   * Configured data paths that resolve OUTSIDE the data directory and so are
   * not contained in this archive. Empty for a default deployment; non-empty
   * only when an INFLOOP_*_DIR override points elsewhere. The operator must
   * back up and restore those separately.
   */
  uncoveredPaths: string[];
}

export interface CreateBackupOptions {
  /** Archive path to write. Default: a timestamped name in the cwd. */
  outPath?: string;
  /** Clock injection for tests. */
  now?: Date;
}

export interface CreateBackupResult {
  /** Absolute path of the archive written. */
  outPath: string;
  manifest: BackupManifest;
  /** Size of the archive on disk, in bytes. */
  bytes: number;
}

export interface RestoreBackupOptions {
  /** Path to a `.tar.gz` produced by createBackup(). */
  archivePath: string;
  /** Required to restore over a non-empty data directory. */
  force?: boolean;
  /** Clock injection for tests. */
  now?: Date;
}

export interface RestoreBackupResult {
  /** Absolute data directory restored into. */
  dataDir: string;
  manifest: BackupManifest;
  /** Where prior data-dir contents were moved, or null if it was empty. */
  movedAsideTo: string | null;
  /** Top-level entries written into the data directory by the restore. */
  restoredItems: string[];
}

/** `YYYYMMDD-HHMMSS` in UTC — used for archive and move-aside names. */
function formatStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Top-level entries of a directory; an empty list if it does not exist. */
async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** True when `child` is `parent` itself or nested anywhere beneath it. */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Run `tar` with the given argv and resolve with its stdout. Rejects with a
 * clear message when `tar` is missing or exits non-zero — the CLI surfaces
 * that message verbatim.
 */
function runTar(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      reject(
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error(
              '`tar` was not found on PATH — it is required for backup and restore',
            )
          : new Error(`failed to run tar: ${err.message}`),
      );
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(
          new Error(
            `tar exited with code ${code}: ${stderr.trim() || '(no output)'}`,
          ),
        );
      }
    });
  });
}

/** Configured data paths that resolve outside `root` and so cannot be backed up. */
function uncoveredOverridePaths(root: string): string[] {
  const out: string[] = [];
  for (const name of OVERRIDE_ENV_VARS) {
    const value = process.env[name];
    if (!value) continue;
    const resolved = path.resolve(value);
    if (!isInside(root, resolved)) out.push(`${name}=${resolved}`);
  }
  return out;
}

/**
 * Reject archive members that could escape the extraction directory. `tar`
 * itself strips leading `/` and skips `..` members, but failing fast with a
 * clear error — before extracting anything — is the safer contract.
 */
export function assertSafeEntries(entries: string[]): void {
  for (const entry of entries) {
    if (entry.startsWith('/') || /^[A-Za-z]:[\\/]/.test(entry)) {
      throw new Error(`unsafe absolute path in archive: ${entry}`);
    }
    if (entry.split(/[\\/]/).includes('..')) {
      throw new Error(`unsafe parent-directory reference in archive: ${entry}`);
    }
  }
}

/** Throw unless `m` is a manifest this build can restore. */
function validateManifest(m: Partial<BackupManifest>): asserts m is BackupManifest {
  if (m.format !== BACKUP_FORMAT) {
    throw new Error(
      `not an Infinite Loop backup (unexpected format ${JSON.stringify(m.format)})`,
    );
  }
  if (m.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(
      `unsupported backup format version ${m.formatVersion} — ` +
        `this build understands version ${BACKUP_FORMAT_VERSION}`,
    );
  }
}

/** Extract and parse just the manifest from an archive. */
async function extractManifest(archivePath: string): Promise<BackupManifest> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'infloop-restore-'));
  try {
    await runTar(['-x', '-z', '-f', archivePath, '-C', tmp, MANIFEST_NAME]);
    let parsed: Partial<BackupManifest>;
    try {
      parsed = JSON.parse(
        await fs.readFile(path.join(tmp, MANIFEST_NAME), 'utf8'),
      ) as Partial<BackupManifest>;
    } catch {
      throw new Error(`${MANIFEST_NAME} in archive is not valid JSON`);
    }
    validateManifest(parsed);
    return parsed;
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Read and validate a backup archive without extracting it. Returns the
 * manifest and the full member listing.
 */
export async function inspectBackup(archivePath: string): Promise<{
  manifest: BackupManifest;
  entries: string[];
}> {
  const resolved = path.resolve(archivePath);
  if (!(await pathExists(resolved))) {
    throw new Error(`backup archive not found: ${resolved}`);
  }

  let listing: string;
  try {
    listing = await runTar(['-t', '-z', '-f', resolved]);
  } catch (err) {
    throw new Error(
      `not a readable .tar.gz archive: ${resolved} (${(err as Error).message})`,
    );
  }
  const entries = listing
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  assertSafeEntries(entries);
  if (
    !entries.some((e) => e === MANIFEST_NAME || e === `./${MANIFEST_NAME}`)
  ) {
    throw new Error(
      `archive has no ${MANIFEST_NAME} — not an Infinite Loop backup: ${resolved}`,
    );
  }

  const manifest = await extractManifest(resolved);
  return { manifest, entries };
}

/**
 * Write a consistency-safe `.tar.gz` snapshot of the data directory. The
 * archive carries a `backup-manifest.json` at its root plus one entry per
 * non-transient top-level item of the data dir.
 */
export async function createBackup(
  opts: CreateBackupOptions = {},
): Promise<CreateBackupResult> {
  const root = path.resolve(dataDir());

  // Explicitly list what to archive rather than relying on tar's --exclude
  // directory semantics: the data dir's top-level entries minus the
  // transient directories and any in-flight temp file. Clear, and portable
  // across GNU tar and bsdtar. (--exclude below still strips temp files
  // nested inside the archived subdirectories.)
  //
  // The data directory is created and managed entirely by this app — the
  // stores only ever write regular files and plain directories — so entries
  // are assumed to be regular files and directories, not symlinks.
  const included = (await listDir(root))
    .filter((entry) => !EXCLUDED_DIRS.includes(entry) && !isTmpName(entry))
    .sort();
  if (included.length === 0) {
    throw new Error(
      `nothing to back up — data directory is empty or holds only ` +
        `transient state: ${root}`,
    );
  }

  const now = opts.now ?? new Date();
  const outPath = path.resolve(
    opts.outPath ?? `infinite-loop-backup-${formatStamp(now)}.tar.gz`,
  );
  if (await pathExists(outPath)) {
    throw new Error(`refusing to overwrite an existing file: ${outPath}`);
  }
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: now.toISOString(),
    appVersion: pkg.version,
    hostname: os.hostname(),
    dataDir: root,
    excludedDirs: [...EXCLUDED_DIRS],
    uncoveredPaths: uncoveredOverridePaths(root),
  };

  // Stage the manifest outside the data dir so the snapshot never mutates
  // what it is snapshotting.
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'infloop-backup-'));
  try {
    await fs.writeFile(
      path.join(staging, MANIFEST_NAME),
      JSON.stringify(manifest, null, 2) + '\n',
      'utf8',
    );
    await runTar([
      '-c',
      '-z',
      '-f',
      outPath,
      // Skip half-written temp files from any in-flight atomic write, and the
      // audit log's cross-process lock — both are transient and host-local.
      '--exclude',
      '*.tmp',
      '--exclude',
      '*.tmp.*',
      '--exclude',
      '*.lock',
      '-C',
      staging,
      MANIFEST_NAME,
      '-C',
      root,
      ...included,
    ]);
  } catch (err) {
    // Never leave a half-written archive behind.
    await fs.rm(outPath, { force: true });
    throw err;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }

  const { size } = await fs.stat(outPath);
  return { outPath, manifest, bytes: size };
}

/**
 * Restore the data directory from a backup archive. The server must be
 * stopped first. When the data dir is non-empty, `force` is required and its
 * current contents are moved aside into a `.pre-restore-<timestamp>`
 * directory (never deleted) before the archive is extracted.
 */
export async function restoreBackup(
  opts: RestoreBackupOptions,
): Promise<RestoreBackupResult> {
  // inspectBackup validates the archive — safe members, present manifest,
  // supported format version — before anything on disk is touched.
  const { manifest } = await inspectBackup(opts.archivePath);
  const archivePath = path.resolve(opts.archivePath);
  const root = path.resolve(dataDir());

  const existing = (await listDir(root)).filter(
    (entry) => !entry.startsWith(PRE_RESTORE_PREFIX),
  );

  let movedAsideTo: string | null = null;
  if (existing.length > 0) {
    if (!opts.force) {
      throw new Error(
        `data directory is not empty: ${root}\n` +
          `Restoring would replace its contents. Stop the server, then ` +
          `re-run with --force to proceed — the current contents are moved ` +
          `aside into a ${PRE_RESTORE_PREFIX}* directory, not deleted.`,
      );
    }
    const now = opts.now ?? new Date();
    movedAsideTo = path.join(root, `${PRE_RESTORE_PREFIX}${formatStamp(now)}`);
    if (await pathExists(movedAsideTo)) {
      throw new Error(
        `move-aside directory already exists: ${movedAsideTo} — ` +
          `retry in a moment or remove it first`,
      );
    }
    await fs.mkdir(movedAsideTo, { recursive: true });
    for (const name of existing) {
      await fs.rename(
        path.join(root, name),
        path.join(movedAsideTo, name),
      );
    }
  }

  // When the archive lives inside the data directory — exactly what the
  // documented Docker restore does (`docker compose cp ./backup.tar.gz
  // infinite-loop:/data/backup.tar.gz`) — the move-aside above relocated the
  // archive itself into `movedAsideTo`. Extract from its new location so
  // `tar` can still read it; otherwise the documented procedure fails with
  // "Cannot open" (caught by the production burn-in).
  let effectiveArchive = archivePath;
  if (movedAsideTo && isInside(root, archivePath)) {
    effectiveArchive = path.join(movedAsideTo, path.relative(root, archivePath));
  }

  // Extract over the data dir. After a move-aside the dir holds only the new
  // `.pre-restore-*` directory, so this overlays nothing; with an empty data
  // dir it is a clean write. (It does not delete files the archive omits — a
  // non-empty restore always goes through the move-aside path above.)
  await fs.mkdir(root, { recursive: true });
  await runTar(['-x', '-z', '-f', effectiveArchive, '-C', root]);

  // The manifest extracts into the data dir as a provenance record; the
  // store scans ignore it. `.pre-restore-*` is excluded from the count.
  const restoredItems = (await listDir(root)).filter(
    (entry) =>
      entry !== MANIFEST_NAME && !entry.startsWith(PRE_RESTORE_PREFIX),
  );

  return { dataDir: root, manifest, movedAsideTo, restoredItems };
}
