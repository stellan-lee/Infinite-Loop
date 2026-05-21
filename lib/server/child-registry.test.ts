import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  activeChildCount,
  clearChildPidFiles,
  killAllChildren,
  listChildPidRecords,
  registerChild,
  removeChildPidFile,
  unregisterChild,
} from './child-registry';

describe('child-registry', () => {
  const originalKill = process.kill.bind(process);
  const originalDataDir = process.env.INFLOOP_DATA_DIR;
  let tmp: string;

  beforeAll(() => {
    // Isolate the on-disk PID files into a temp dir — registerChild now
    // mirrors every pid to `<INFLOOP_DATA_DIR>/pids/`.
    tmp = mkdtempSync(path.join(tmpdir(), 'infloop-child-registry-'));
    process.env.INFLOOP_DATA_DIR = tmp;
  });

  afterAll(() => {
    if (originalDataDir === undefined) delete process.env.INFLOOP_DATA_DIR;
    else process.env.INFLOOP_DATA_DIR = originalDataDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Drain — the registry is module-global. Use a generous range; sentinels
    // here are never real pids so process.kill is mocked below.
    for (let pid = 1; pid <= 100; pid++) unregisterChild(pid);
  });

  afterEach(() => {
    (process as { kill: typeof process.kill }).kill = originalKill;
  });

  it('register/unregister is idempotent and reflected in activeChildCount', () => {
    expect(activeChildCount()).toBe(0);
    registerChild(11);
    registerChild(11); // duplicate
    registerChild(12);
    expect(activeChildCount()).toBe(2);
    unregisterChild(11);
    unregisterChild(11); // already gone
    expect(activeChildCount()).toBe(1);
    unregisterChild(12);
    expect(activeChildCount()).toBe(0);
  });

  it('mirrors registered pids to disk and removes them on unregister', () => {
    registerChild(11, { bin: '/usr/local/bin/claude' });
    registerChild(12);

    const records = listChildPidRecords();
    const rec11 = records.find((r) => r.pid === 11);
    expect(rec11).toBeDefined();
    expect(rec11!.serverPid).toBe(process.pid);
    expect(rec11!.bin).toBe('/usr/local/bin/claude');
    expect(typeof rec11!.spawnedAt).toBe('number');
    expect(records.some((r) => r.pid === 12)).toBe(true);

    unregisterChild(11);
    expect(listChildPidRecords().some((r) => r.pid === 11)).toBe(false);
    expect(listChildPidRecords().some((r) => r.pid === 12)).toBe(true);
  });

  it('clearChildPidFiles removes every tracked pid file', () => {
    registerChild(21);
    registerChild(22);
    expect(listChildPidRecords().length).toBeGreaterThanOrEqual(2);

    clearChildPidFiles();
    const pids = listChildPidRecords().map((r) => r.pid);
    expect(pids).not.toContain(21);
    expect(pids).not.toContain(22);
  });

  it('removeChildPidFile is a no-op for an unknown pid', () => {
    expect(() => removeChildPidFile(99999)).not.toThrow();
  });

  it('killAllChildren signals each pgrp with a negative pid', () => {
    const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const fakeKill = mock(
      (pid: number, signal?: string | number): true => {
        calls.push({ pid, signal: signal as NodeJS.Signals });
        return true;
      },
    );
    (process as { kill: typeof process.kill }).kill =
      fakeKill as unknown as typeof process.kill;

    registerChild(21);
    registerChild(22);
    killAllChildren('SIGTERM');

    const pgrpHits = calls
      .filter((c) => c.pid < 0)
      .map((c) => c.pid)
      .sort((a, b) => a - b);
    expect(pgrpHits).toEqual([-22, -21]);
    expect(calls.every((c) => c.signal === 'SIGTERM')).toBe(true);
  });

  it('killAllChildren falls back to bare pid if pgrp kill throws', () => {
    const calls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const fakeKill = mock(
      (pid: number, signal?: string | number): true => {
        if (pid < 0) {
          const err = new Error('no such process group') as NodeJS.ErrnoException;
          err.code = 'ESRCH';
          throw err;
        }
        calls.push({ pid, signal: signal as NodeJS.Signals });
        return true;
      },
    );
    (process as { kill: typeof process.kill }).kill =
      fakeKill as unknown as typeof process.kill;

    registerChild(31);
    killAllChildren('SIGKILL');

    expect(calls).toEqual([{ pid: 31, signal: 'SIGKILL' }]);
  });

  it('swallows errors when both pgrp and bare kill throw (child already exited)', () => {
    const fakeKill = mock((): true => {
      throw new Error('boom');
    });
    (process as { kill: typeof process.kill }).kill =
      fakeKill as unknown as typeof process.kill;

    registerChild(41);
    expect(() => killAllChildren('SIGTERM')).not.toThrow();
  });
});
