import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_INTERVAL_HOURS,
  DEFAULT_KEEP,
  pruneBackups,
  resolveScheduledBackupConfig,
  runScheduledBackup,
} from './scheduled-backup';

/*
 * runScheduledBackup() drives createBackup(), which reads INFLOOP_DATA_DIR.
 * Snapshot it once and restore after every test; clear it before each so a
 * leftover from a sibling test file cannot leak in. resolveScheduledBackupConfig
 * itself is pure over its argument and needs none of this.
 */
const savedDataDir = process.env.INFLOOP_DATA_DIR;
const temps: string[] = [];

beforeEach(() => {
  delete process.env.INFLOOP_DATA_DIR;
});

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (savedDataDir === undefined) delete process.env.INFLOOP_DATA_DIR;
  else process.env.INFLOOP_DATA_DIR = savedDataDir;
});

function freshDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `infloop-sched-${label}-`));
  temps.push(dir);
  return dir;
}

/** Minimal but durable data directory — enough for createBackup to archive. */
function seedData(dir: string): void {
  mkdirSync(path.join(dir, 'workflows'), { recursive: true });
  writeFileSync(path.join(dir, 'workflows', 'w1.json'), '{"id":"w1"}');
  writeFileSync(path.join(dir, 'settings.json'), '{"maxConcurrentRuns":4}');
}

/** Create an auto-named archive file; its content is irrelevant to pruning. */
function touchArchive(dir: string, stamp: string): string {
  const name = `infinite-loop-backup-${stamp}.tar.gz`;
  writeFileSync(path.join(dir, name), 'x');
  return name;
}

describe('resolveScheduledBackupConfig', () => {
  it('requires INFLOOP_BACKUP_DIR — there is no safe default', () => {
    const result = resolveScheduledBackupConfig({});
    expect(result.config).toBeUndefined();
    expect(result.errors.join('\n')).toMatch(/INFLOOP_BACKUP_DIR is required/);
  });

  it('rejects a backup dir nested inside the data dir', () => {
    const result = resolveScheduledBackupConfig({
      INFLOOP_DATA_DIR: '/srv/data',
      INFLOOP_BACKUP_DIR: '/srv/data/backups',
    });
    expect(result.config).toBeUndefined();
    expect(result.errors.join('\n')).toMatch(/inside the data\s+directory/);
  });

  it('rejects a backup dir equal to the data dir', () => {
    const result = resolveScheduledBackupConfig({
      INFLOOP_DATA_DIR: '/srv/data',
      INFLOOP_BACKUP_DIR: '/srv/data',
    });
    expect(result.config).toBeUndefined();
  });

  it('accepts a backup dir outside the data dir and applies defaults', () => {
    const result = resolveScheduledBackupConfig({
      INFLOOP_DATA_DIR: '/srv/data',
      INFLOOP_BACKUP_DIR: '/srv/backups',
    });
    expect(result.errors).toEqual([]);
    expect(result.config).toEqual({
      backupDir: '/srv/backups',
      intervalMs: DEFAULT_INTERVAL_HOURS * 60 * 60 * 1000,
      keep: DEFAULT_KEEP,
    });
  });

  it('parses interval and keep overrides', () => {
    const result = resolveScheduledBackupConfig({
      INFLOOP_DATA_DIR: '/srv/data',
      INFLOOP_BACKUP_DIR: '/srv/backups',
      INFLOOP_BACKUP_INTERVAL_HOURS: '0.5',
      INFLOOP_BACKUP_KEEP: '3',
    });
    expect(result.errors).toEqual([]);
    expect(result.config?.intervalMs).toBe(30 * 60 * 1000);
    expect(result.config?.keep).toBe(3);
  });

  it('treats an empty interval/keep as unset and applies the default', () => {
    const result = resolveScheduledBackupConfig({
      INFLOOP_DATA_DIR: '/srv/data',
      INFLOOP_BACKUP_DIR: '/srv/backups',
      INFLOOP_BACKUP_INTERVAL_HOURS: '',
      INFLOOP_BACKUP_KEEP: '',
    });
    expect(result.config?.intervalMs).toBe(
      DEFAULT_INTERVAL_HOURS * 60 * 60 * 1000,
    );
    expect(result.config?.keep).toBe(DEFAULT_KEEP);
  });

  it('rejects a non-positive or malformed interval', () => {
    for (const bad of ['0', '-1', 'abc', '12h', '1e3']) {
      const result = resolveScheduledBackupConfig({
        INFLOOP_DATA_DIR: '/srv/data',
        INFLOOP_BACKUP_DIR: '/srv/backups',
        INFLOOP_BACKUP_INTERVAL_HOURS: bad,
      });
      expect(result.config).toBeUndefined();
    }
  });

  it('rejects a non-positive, fractional or malformed keep', () => {
    for (const bad of ['0', '-2', '2.5', 'lots']) {
      const result = resolveScheduledBackupConfig({
        INFLOOP_DATA_DIR: '/srv/data',
        INFLOOP_BACKUP_DIR: '/srv/backups',
        INFLOOP_BACKUP_KEEP: bad,
      });
      expect(result.config).toBeUndefined();
    }
  });

  it('reports every misconfigured variable at once', () => {
    const result = resolveScheduledBackupConfig({
      INFLOOP_DATA_DIR: '/srv/data',
      INFLOOP_BACKUP_INTERVAL_HOURS: 'nope',
      INFLOOP_BACKUP_KEEP: '-1',
    });
    // missing backup dir + bad interval + bad keep.
    expect(result.errors).toHaveLength(3);
  });
});

describe('pruneBackups', () => {
  it('returns an empty result for a non-existent directory', async () => {
    const result = await pruneBackups(
      path.join(freshDir('out'), 'does-not-exist'),
      5,
    );
    expect(result).toEqual({ deleted: [], kept: [] });
  });

  it('keeps everything when at or under the limit', async () => {
    const dir = freshDir('out');
    touchArchive(dir, '20260101-000000');
    touchArchive(dir, '20260102-000000');

    const result = await pruneBackups(dir, 5);

    expect(result.deleted).toEqual([]);
    expect(result.kept).toHaveLength(2);
  });

  it('deletes the oldest archives beyond the limit', async () => {
    const dir = freshDir('out');
    const a = touchArchive(dir, '20260101-000000');
    const b = touchArchive(dir, '20260102-000000');
    const c = touchArchive(dir, '20260103-000000');
    const d = touchArchive(dir, '20260104-000000');

    const result = await pruneBackups(dir, 2);

    expect(result.deleted).toEqual([a, b]);
    expect(result.kept).toEqual([c, d]);
    expect(existsSync(path.join(dir, a))).toBe(false);
    expect(existsSync(path.join(dir, b))).toBe(false);
    expect(existsSync(path.join(dir, c))).toBe(true);
    expect(existsSync(path.join(dir, d))).toBe(true);
  });

  it('never touches files that are not auto-named archives', async () => {
    const dir = freshDir('out');
    touchArchive(dir, '20260101-000000');
    touchArchive(dir, '20260102-000000');
    touchArchive(dir, '20260103-000000');
    // An operator's hand-named archive, and an unrelated file.
    writeFileSync(path.join(dir, 'manual-backup.tar.gz'), 'keep me');
    writeFileSync(path.join(dir, 'notes.txt'), 'keep me too');

    const result = await pruneBackups(dir, 1);

    expect(result.deleted).toHaveLength(2);
    expect(existsSync(path.join(dir, 'manual-backup.tar.gz'))).toBe(true);
    expect(existsSync(path.join(dir, 'notes.txt'))).toBe(true);
  });
});

describe('runScheduledBackup', () => {
  it('writes a snapshot into the backup dir, then prunes to keep', async () => {
    const data = freshDir('data');
    seedData(data);
    process.env.INFLOOP_DATA_DIR = data;
    const backupDir = freshDir('backups');
    const config = { backupDir, intervalMs: 60 * 60 * 1000, keep: 2 };

    // Three runs at distinct injected times; keep=2 must leave the newest 2.
    const first = await runScheduledBackup(
      config,
      new Date('2026-05-22T01:00:00Z'),
    );
    expect(existsSync(first.backup.outPath)).toBe(true);
    expect(path.dirname(first.backup.outPath)).toBe(backupDir);
    expect(first.prune.deleted).toEqual([]);

    await runScheduledBackup(config, new Date('2026-05-22T02:00:00Z'));
    const third = await runScheduledBackup(
      config,
      new Date('2026-05-22T03:00:00Z'),
    );

    const archives = readdirSync(backupDir).filter((n) =>
      n.startsWith('infinite-loop-backup-'),
    );
    expect(archives).toHaveLength(2);
    // The just-written snapshot is among the retained generations.
    expect(third.prune.kept).toHaveLength(2);
    expect(third.prune.deleted).toHaveLength(1);
    expect(existsSync(third.backup.outPath)).toBe(true);
  });
});
