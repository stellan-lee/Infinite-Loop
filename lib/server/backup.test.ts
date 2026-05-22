import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertSafeEntries,
  createBackup,
  inspectBackup,
  isBackupArchiveName,
  restoreBackup,
} from './backup';

/*
 * Env vars these tests read or set. They are snapshot once and restored after
 * every test; the data-path overrides are also cleared before every test so a
 * leftover from a sibling test file cannot perturb `uncoveredPaths` counts.
 */
const TRACKED_ENV = [
  'INFLOOP_DATA_DIR',
  'INFLOOP_WORKFLOWS_DIR',
  'INFLOOP_RUNS_DIR',
  'INFLOOP_TRIGGERS_DIR',
  'INFLOOP_CONNECTIONS_DIR',
];
const savedEnv = new Map(TRACKED_ENV.map((k) => [k, process.env[k]]));

/* Temp dirs created by a test — cleaned up after it. */
const temps: string[] = [];

beforeEach(() => {
  for (const key of TRACKED_ENV) delete process.env[key];
});

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  for (const key of TRACKED_ENV) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function freshDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `infloop-bkup-${label}-`));
  temps.push(dir);
  return dir;
}

/** Write a representative data directory: durable state + transient + .tmp. */
function seedData(dir: string): void {
  mkdirSync(path.join(dir, 'workflows'), { recursive: true });
  writeFileSync(path.join(dir, 'workflows', 'w1.json'), '{"id":"w1"}');
  writeFileSync(path.join(dir, 'workflows', 'w2.json.tmp'), 'HALF-WRITTEN');
  mkdirSync(path.join(dir, 'runs', 'wf1'), { recursive: true });
  writeFileSync(path.join(dir, 'runs', 'wf1', 'r1.json'), '{"id":"r1"}');
  mkdirSync(path.join(dir, 'connections'), { recursive: true });
  writeFileSync(path.join(dir, 'connections', 'c1.json'), '{"id":"c1"}');
  mkdirSync(path.join(dir, 'queue'), { recursive: true });
  writeFileSync(path.join(dir, 'queue', 'q1.json'), '{"id":"q1"}');
  mkdirSync(path.join(dir, 'audit'), { recursive: true });
  writeFileSync(path.join(dir, 'audit', 'audit.jsonl'), '{"a":1}\n');
  writeFileSync(path.join(dir, 'settings.json'), '{"maxConcurrentRuns":4}');
  writeFileSync(path.join(dir, 'settings.json.tmp.5.99'), 'HALF-WRITTEN');
  mkdirSync(path.join(dir, 'pids'), { recursive: true });
  writeFileSync(path.join(dir, 'pids', '100.json'), '{"pid":100}');
  mkdirSync(path.join(dir, 'active-runs'), { recursive: true });
  writeFileSync(path.join(dir, 'active-runs', 'r1.json'), '{"runId":"r1"}');
}

function archiveEntries(archive: string): string[] {
  return execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

describe('createBackup', () => {
  it('archives durable state and the manifest, excluding transient files', async () => {
    const data = freshDir('data');
    seedData(data);
    process.env.INFLOOP_DATA_DIR = data;
    const outPath = path.join(freshDir('out'), 'b.tar.gz');

    const result = await createBackup({ outPath });

    expect(result.outPath).toBe(outPath);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.manifest.format).toBe('infinite-loop-backup');
    expect(result.manifest.formatVersion).toBe(1);
    expect(result.manifest.dataDir).toBe(data);

    const entries = archiveEntries(outPath);
    expect(entries).toContain('backup-manifest.json');
    expect(entries).toContain('workflows/w1.json');
    expect(entries).toContain('runs/wf1/r1.json');
    expect(entries).toContain('settings.json');
    expect(entries).toContain('audit/audit.jsonl');

    // Transient, host-specific state and in-flight temp files are excluded.
    expect(entries.some((e) => e.startsWith('pids/'))).toBe(false);
    expect(entries.some((e) => e.startsWith('active-runs/'))).toBe(false);
    expect(entries.some((e) => e.includes('.tmp'))).toBe(false);
  });

  it('refuses to overwrite an existing archive', async () => {
    const data = freshDir('data');
    seedData(data);
    process.env.INFLOOP_DATA_DIR = data;
    const outPath = path.join(freshDir('out'), 'b.tar.gz');
    writeFileSync(outPath, 'pre-existing');

    await expect(createBackup({ outPath })).rejects.toThrow(
      /refusing to overwrite/,
    );
  });

  it('throws when the data directory holds nothing durable', async () => {
    const data = freshDir('data');
    mkdirSync(path.join(data, 'pids'), { recursive: true });
    process.env.INFLOOP_DATA_DIR = data;

    await expect(
      createBackup({ outPath: path.join(freshDir('out'), 'b.tar.gz') }),
    ).rejects.toThrow(/nothing to back up/);
  });

  it('records data paths configured outside the data directory', async () => {
    const data = freshDir('data');
    seedData(data);
    process.env.INFLOOP_DATA_DIR = data;
    const outsideRuns = freshDir('runs-elsewhere');
    process.env.INFLOOP_RUNS_DIR = outsideRuns;

    const result = await createBackup({
      outPath: path.join(freshDir('out'), 'b.tar.gz'),
    });

    expect(result.manifest.uncoveredPaths).toHaveLength(1);
    expect(result.manifest.uncoveredPaths[0]).toContain('INFLOOP_RUNS_DIR');
    expect(result.manifest.uncoveredPaths[0]).toContain(outsideRuns);
  });
});

describe('restoreBackup', () => {
  it('round-trips durable state into a fresh data directory', async () => {
    const source = freshDir('data');
    seedData(source);
    process.env.INFLOOP_DATA_DIR = source;
    const outPath = path.join(freshDir('out'), 'b.tar.gz');
    await createBackup({ outPath });

    const target = freshDir('restore-target');
    process.env.INFLOOP_DATA_DIR = target;
    const result = await restoreBackup({ archivePath: outPath });

    expect(result.dataDir).toBe(target);
    expect(result.movedAsideTo).toBeNull();
    expect(readFileSync(path.join(target, 'workflows', 'w1.json'), 'utf8')).toBe(
      '{"id":"w1"}',
    );
    expect(
      readFileSync(path.join(target, 'runs', 'wf1', 'r1.json'), 'utf8'),
    ).toBe('{"id":"r1"}');
    expect(readFileSync(path.join(target, 'settings.json'), 'utf8')).toBe(
      '{"maxConcurrentRuns":4}',
    );
    // Transient dirs were never archived, so they are absent after restore.
    expect(existsSync(path.join(target, 'pids'))).toBe(false);
    expect(existsSync(path.join(target, 'active-runs'))).toBe(false);
    expect(existsSync(path.join(target, 'workflows', 'w2.json.tmp'))).toBe(
      false,
    );
  });

  it('refuses a non-empty data directory without force', async () => {
    const source = freshDir('data');
    seedData(source);
    process.env.INFLOOP_DATA_DIR = source;
    const outPath = path.join(freshDir('out'), 'b.tar.gz');
    await createBackup({ outPath });

    // The data dir is still populated — restore must refuse.
    await expect(restoreBackup({ archivePath: outPath })).rejects.toThrow(
      /not empty/,
    );
  });

  it('moves existing contents aside when force is set', async () => {
    const data = freshDir('data');
    seedData(data);
    process.env.INFLOOP_DATA_DIR = data;
    const outPath = path.join(freshDir('out'), 'b.tar.gz');
    await createBackup({ outPath });
    writeFileSync(path.join(data, 'stray.txt'), 'operator file');

    const result = await restoreBackup({ archivePath: outPath, force: true });

    expect(result.movedAsideTo).not.toBeNull();
    const moved = result.movedAsideTo as string;
    expect(path.basename(moved).startsWith('.pre-restore-')).toBe(true);
    // The stray file is preserved in the move-aside dir, not in the root.
    expect(existsSync(path.join(moved, 'stray.txt'))).toBe(true);
    expect(existsSync(path.join(data, 'stray.txt'))).toBe(false);
    // The archive's durable state is back in place.
    expect(readFileSync(path.join(data, 'workflows', 'w1.json'), 'utf8')).toBe(
      '{"id":"w1"}',
    );
    expect(result.restoredItems).toContain('workflows');
    expect(result.restoredItems).not.toContain('backup-manifest.json');
  });

  it('restores when the archive lives inside the data directory', async () => {
    // The documented Docker restore copies the archive to <dataDir>/backup.tar.gz
    // before restoring. The move-aside must not strand the archive — regression
    // for the burn-in finding where `tar` failed with "Cannot open".
    const data = freshDir('data');
    seedData(data);
    process.env.INFLOOP_DATA_DIR = data;
    const outPath = path.join(freshDir('out'), 'b.tar.gz');
    await createBackup({ outPath });

    // Place the archive inside the data directory, as the Docker procedure does.
    const innerArchive = path.join(data, 'backup.tar.gz');
    copyFileSync(outPath, innerArchive);

    const result = await restoreBackup({ archivePath: innerArchive, force: true });

    expect(result.movedAsideTo).not.toBeNull();
    // Durable state is restored from the archive.
    expect(readFileSync(path.join(data, 'workflows', 'w1.json'), 'utf8')).toBe(
      '{"id":"w1"}',
    );
    // The archive was carried into the move-aside dir with the rest, not lost.
    expect(
      existsSync(path.join(result.movedAsideTo as string, 'backup.tar.gz')),
    ).toBe(true);
  });
});

describe('archive validation', () => {
  it('rejects an archive without a manifest', async () => {
    const staging = freshDir('staging');
    mkdirSync(path.join(staging, 'workflows'), { recursive: true });
    writeFileSync(path.join(staging, 'workflows', 'w.json'), '{}');
    const archive = path.join(freshDir('out'), 'bad.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', staging, 'workflows']);

    await expect(inspectBackup(archive)).rejects.toThrow(
      /no backup-manifest\.json/,
    );
  });

  it('rejects an unsupported manifest format version', async () => {
    const staging = freshDir('staging');
    writeFileSync(
      path.join(staging, 'backup-manifest.json'),
      JSON.stringify({ format: 'infinite-loop-backup', formatVersion: 99 }),
    );
    const archive = path.join(freshDir('out'), 'bad.tar.gz');
    execFileSync('tar', [
      '-czf',
      archive,
      '-C',
      staging,
      'backup-manifest.json',
    ]);

    await expect(inspectBackup(archive)).rejects.toThrow(
      /unsupported backup format version 99/,
    );
  });

  it('rejects an archive whose manifest is not an Infinite Loop backup', async () => {
    const staging = freshDir('staging');
    writeFileSync(
      path.join(staging, 'backup-manifest.json'),
      JSON.stringify({ format: 'something-else', formatVersion: 1 }),
    );
    const archive = path.join(freshDir('out'), 'bad.tar.gz');
    execFileSync('tar', [
      '-czf',
      archive,
      '-C',
      staging,
      'backup-manifest.json',
    ]);

    await expect(inspectBackup(archive)).rejects.toThrow(
      /not an Infinite Loop backup/,
    );
  });

  it('rejects a file that is not a readable archive', async () => {
    const notArchive = path.join(freshDir('out'), 'plain.txt');
    writeFileSync(notArchive, 'this is not a tarball');

    await expect(inspectBackup(notArchive)).rejects.toThrow(
      /not a readable \.tar\.gz archive/,
    );
  });

  it('rejects a missing archive', async () => {
    await expect(
      inspectBackup(path.join(freshDir('out'), 'absent.tar.gz')),
    ).rejects.toThrow(/not found/);
  });
});

describe('assertSafeEntries', () => {
  it('accepts ordinary relative members', () => {
    expect(() =>
      assertSafeEntries([
        'backup-manifest.json',
        'workflows/',
        'workflows/w1.json',
        'runs/wf1/r1.json',
      ]),
    ).not.toThrow();
  });

  it('rejects an absolute path', () => {
    expect(() => assertSafeEntries(['/etc/passwd'])).toThrow(/absolute path/);
  });

  it('rejects a parent-directory escape', () => {
    expect(() => assertSafeEntries(['../../etc/cron.d/evil'])).toThrow(
      /parent-directory/,
    );
  });
});

describe('archive contents', () => {
  it('contains exactly the non-transient top-level entries plus the manifest', async () => {
    const data = freshDir('data');
    seedData(data);
    process.env.INFLOOP_DATA_DIR = data;
    const outPath = path.join(freshDir('out'), 'b.tar.gz');
    await createBackup({ outPath });

    const target = freshDir('restore-target');
    process.env.INFLOOP_DATA_DIR = target;
    await restoreBackup({ archivePath: outPath });

    const topLevel = readdirSync(target).sort();
    expect(topLevel).toEqual(
      [
        'audit',
        'backup-manifest.json',
        'connections',
        'queue',
        'runs',
        'settings.json',
        'workflows',
      ].sort(),
    );
  });
});

describe('createBackup outDir', () => {
  it('writes the default timestamped name into outDir', async () => {
    const data = freshDir('data');
    seedData(data);
    process.env.INFLOOP_DATA_DIR = data;
    const outDir = freshDir('out');

    const result = await createBackup({
      outDir,
      now: new Date('2026-05-22T13:45:09Z'),
    });

    expect(result.outPath).toBe(
      path.join(outDir, 'infinite-loop-backup-20260522-134509.tar.gz'),
    );
    expect(existsSync(result.outPath)).toBe(true);
    // The generated name is one isBackupArchiveName recognizes.
    expect(isBackupArchiveName(path.basename(result.outPath))).toBe(true);
  });

  it('creates outDir when it does not exist', async () => {
    const data = freshDir('data');
    seedData(data);
    process.env.INFLOOP_DATA_DIR = data;
    const outDir = path.join(freshDir('out'), 'nested', 'backups');

    const result = await createBackup({ outDir });

    expect(existsSync(result.outPath)).toBe(true);
    expect(path.dirname(result.outPath)).toBe(outDir);
  });

  it('lets an explicit outPath win over outDir', async () => {
    const data = freshDir('data');
    seedData(data);
    process.env.INFLOOP_DATA_DIR = data;
    const outDir = freshDir('out');
    const explicit = path.join(freshDir('explicit'), 'chosen.tar.gz');

    const result = await createBackup({ outDir, outPath: explicit });

    expect(result.outPath).toBe(explicit);
  });
});

describe('isBackupArchiveName', () => {
  it('accepts a name createBackup auto-generates', () => {
    expect(
      isBackupArchiveName('infinite-loop-backup-20260522-134509.tar.gz'),
    ).toBe(true);
  });

  it('rejects names createBackup never generates', () => {
    for (const name of [
      'backup.tar.gz',
      'infinite-loop-backup.tar.gz',
      'my-infinite-loop-backup-20260522-134509.tar.gz',
      'infinite-loop-backup-20260522-134509.tar.gz.tmp',
      'infinite-loop-backup-2026-05-22.tar.gz',
      'infinite-loop-backup-20260522.tar.gz',
      'backup-manifest.json',
      '',
    ]) {
      expect(isBackupArchiveName(name)).toBe(false);
    }
  });
});
