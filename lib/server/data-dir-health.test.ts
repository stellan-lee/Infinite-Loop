import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataDirWritable } from './data-dir-health';

let tmpDir: string;
const savedDataDir = process.env.INFLOOP_DATA_DIR;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'infinite-loop-datadir-'));
  process.env.INFLOOP_DATA_DIR = tmpDir;
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.INFLOOP_DATA_DIR;
  else process.env.INFLOOP_DATA_DIR = savedDataDir;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe('dataDirWritable', () => {
  it('returns true and leaves no probe file behind when the dir is writable', async () => {
    expect(await dataDirWritable()).toBe(true);
    // The probe file must be removed — a leaked probe per scrape would slowly
    // litter the data directory.
    const leaked = readdirSync(tmpDir).filter((n) =>
      n.startsWith('.health-probe'),
    );
    expect(leaked).toEqual([]);
  });

  it('returns false instead of throwing when the dir cannot be created', async () => {
    // A data dir nested under a regular file makes the probe's mkdir fail.
    const blocker = join(tmpDir, 'blocker');
    writeFileSync(blocker, 'x');
    process.env.INFLOOP_DATA_DIR = join(blocker, 'nested');
    expect(await dataDirWritable()).toBe(false);
  });
});
