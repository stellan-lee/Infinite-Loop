import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupLastSuccessTimestamp } from './backup-health';

// Stash whatever the test process started with so each case can set the
// backup-dir state it needs and afterEach restores it — the suite must stay
// hermetic against a developer's ambient INFLOOP_BACKUP_DIR.
const savedBackupDir = process.env.INFLOOP_BACKUP_DIR;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'infinite-loop-backup-health-'));
});

afterEach(() => {
  if (savedBackupDir === undefined) delete process.env.INFLOOP_BACKUP_DIR;
  else process.env.INFLOOP_BACKUP_DIR = savedBackupDir;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

/** Write a file into the backup dir and stamp it with a known mtime. */
function writeArchive(name: string, mtime: Date): void {
  const p = join(dir, name);
  writeFileSync(p, 'archive');
  utimesSync(p, mtime, mtime);
}

/** The whole-second epoch the probe is expected to report for `mtime`. */
function epochSeconds(mtime: Date): number {
  return Math.floor(mtime.getTime() / 1000);
}

describe('backupLastSuccessTimestamp', () => {
  it('returns null when INFLOOP_BACKUP_DIR is unset — backups not configured', async () => {
    delete process.env.INFLOOP_BACKUP_DIR;
    // null tells the metrics layer to emit no gauge at all, so
    // InfiniteLoopBackupStale never fires on a deployment that never opted in.
    expect(await backupLastSuccessTimestamp()).toBeNull();
  });

  it('returns 0 when configured but the directory does not exist', async () => {
    process.env.INFLOOP_BACKUP_DIR = join(dir, 'does-not-exist');
    expect(await backupLastSuccessTimestamp()).toBe(0);
  });

  it('returns 0 when configured but the directory holds no recognized archive', async () => {
    process.env.INFLOOP_BACKUP_DIR = dir;
    // Neither file is an auto-named backup archive, so neither counts — 0 is
    // the "configured but never succeeded" signal.
    writeFileSync(join(dir, 'notes.txt'), 'x');
    writeFileSync(join(dir, 'backup.tar.gz'), 'x'); // wrong name shape
    expect(await backupLastSuccessTimestamp()).toBe(0);
  });

  it('returns the newest archive mtime, in whole seconds', async () => {
    process.env.INFLOOP_BACKUP_DIR = dir;
    const mtime = new Date('2026-05-20T12:00:00.000Z');
    writeArchive('infinite-loop-backup-20260520-120000.tar.gz', mtime);
    expect(await backupLastSuccessTimestamp()).toBe(epochSeconds(mtime));
  });

  it('picks the chronologically-newest archive by name, not by mtime', async () => {
    process.env.INFLOOP_BACKUP_DIR = dir;
    // The older-named archive carries a deliberately *newer* mtime. The probe
    // must still select the newest archive by name — the lexical-sort ==
    // chronological-sort contract pruneBackups also relies on.
    const newestByName = new Date('2026-05-22T09:00:00.000Z');
    writeArchive(
      'infinite-loop-backup-20260101-000000.tar.gz',
      new Date('2030-01-01T00:00:00.000Z'),
    );
    writeArchive('infinite-loop-backup-20260522-090000.tar.gz', newestByName);
    expect(await backupLastSuccessTimestamp()).toBe(epochSeconds(newestByName));
  });

  it('ignores non-archive files when archives are present', async () => {
    process.env.INFLOOP_BACKUP_DIR = dir;
    const archiveMtime = new Date('2026-05-21T08:00:00.000Z');
    writeArchive('infinite-loop-backup-20260521-080000.tar.gz', archiveMtime);
    // A stray file with a far-future mtime must not be mistaken for a backup.
    const stray = join(dir, 'README');
    const future = new Date('2031-01-01T00:00:00.000Z');
    writeFileSync(stray, 'x');
    utimesSync(stray, future, future);
    expect(await backupLastSuccessTimestamp()).toBe(epochSeconds(archiveMtime));
  });
});
