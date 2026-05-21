import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseEtime,
  reapOrphanProcesses,
  reconcileInterruptedRuns,
  reconcileQueuedRuns,
} from './crash-recovery';
import { activeRunsDir, pidsDir, queueDir } from './paths';
import {
  getRun,
  listRunMarkers,
  runExists,
  saveRun,
  writeRunMarker,
  type RunMarker,
} from './run-store';
import type { ChildPidRecord } from './child-registry';
import type { PersistedQueuedRun } from './queue-store';
import type { QueuedRun, QueueRestoreTarget } from './trigger-queue';
import type { Workflow } from '../shared/workflow';

/* ─── parseEtime (pure) ──────────────────────────────────────────────────── */

describe('parseEtime', () => {
  it('parses MM:SS', () => {
    expect(parseEtime('05:23')).toBe(323_000);
  });
  it('parses HH:MM:SS', () => {
    expect(parseEtime('01:05:23')).toBe(3_923_000);
  });
  it('parses DD-HH:MM:SS', () => {
    expect(parseEtime('2-01:05:23')).toBe(176_723_000);
  });
  it('tolerates surrounding whitespace', () => {
    expect(parseEtime('  00:00  ')).toBe(0);
  });
  it('returns null for an unrecognized format', () => {
    expect(parseEtime('nope')).toBeNull();
    expect(parseEtime('')).toBeNull();
  });
});

/* ─── reaper + reconciler (real processes + filesystem) ──────────────────── */

describe('crash-recovery', () => {
  const originalDataDir = process.env.INFLOOP_DATA_DIR;
  const originalRunsDir = process.env.INFLOOP_RUNS_DIR;
  let tmp: string;
  const children: ChildProcess[] = [];

  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'infloop-crash-recovery-'));
    process.env.INFLOOP_DATA_DIR = tmp;
    // Let runsDir() fall through to `<dataDir>/runs` inside the temp dir.
    delete process.env.INFLOOP_RUNS_DIR;
  });

  afterAll(() => {
    if (originalDataDir === undefined) delete process.env.INFLOOP_DATA_DIR;
    else process.env.INFLOOP_DATA_DIR = originalDataDir;
    if (originalRunsDir !== undefined) process.env.INFLOOP_RUNS_DIR = originalRunsDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const sub of ['pids', 'active-runs', 'runs', 'queue']) {
      rmSync(path.join(tmp, sub), { recursive: true, force: true });
    }
  });

  afterEach(() => {
    for (const c of children) {
      if (c.pid && c.exitCode === null && c.signalCode === null) {
        try {
          process.kill(-c.pid, 'SIGKILL');
        } catch {
          try {
            process.kill(c.pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      }
    }
    children.length = 0;
  });

  /** Spawn a long-lived detached child standing in for an orphaned CLI. */
  function spawnSleep(): ChildProcess {
    const c = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    c.unref();
    children.push(c);
    return c;
  }

  function writePidRecord(rec: ChildPidRecord): void {
    mkdirSync(pidsDir(), { recursive: true });
    writeFileSync(path.join(pidsDir(), `${rec.pid}.json`), JSON.stringify(rec));
  }

  function pidFileExists(pid: number): boolean {
    return existsSync(path.join(pidsDir(), `${pid}.json`));
  }

  function marker(over: Partial<RunMarker>): RunMarker {
    return {
      runId: 'run',
      workflowId: 'wf',
      workflowName: 'WF',
      startedAt: Date.now(),
      serverPid: process.pid,
      ...over,
    };
  }

  describe('reapOrphanProcesses', () => {
    it('kills a live orphan whose owning server is gone', async () => {
      const child = spawnSleep();
      const pid = child.pid!;
      // serverPid === our pid: the reaper reads this as a predecessor that
      // happened to reuse our pid — i.e. a genuine orphan to reap.
      writePidRecord({ pid, serverPid: process.pid, bin: 'sleep', spawnedAt: Date.now() });

      reapOrphanProcesses();

      const [, signal] = await once(child, 'exit');
      expect(signal).toBe('SIGKILL');
      expect(pidFileExists(pid)).toBe(false);
    });

    it('skips an orphan still owned by a live second instance', () => {
      const otherServer = spawnSleep(); // stands in for a co-running server
      const child = spawnSleep();
      writePidRecord({
        pid: child.pid!,
        serverPid: otherServer.pid!,
        bin: 'sleep',
        spawnedAt: Date.now(),
      });

      reapOrphanProcesses();

      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      // Not ours to touch — the record is left in place.
      expect(pidFileExists(child.pid!)).toBe(true);
    });

    it('does not kill a recycled PID that started long after spawnedAt', () => {
      const child = spawnSleep();
      writePidRecord({
        pid: child.pid!,
        serverPid: process.pid,
        bin: 'sleep',
        // Recorded an hour ago; the live process only just started.
        spawnedAt: Date.now() - 3_600_000,
      });

      reapOrphanProcesses();

      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      // The stale record is still cleaned up even though nothing was killed.
      expect(pidFileExists(child.pid!)).toBe(false);
    });

    it('cleans up a PID record whose process no longer exists', async () => {
      const child = spawnSleep();
      const pid = child.pid!;
      process.kill(pid, 'SIGKILL');
      await once(child, 'exit'); // ensure the OS has reaped it before we probe
      writePidRecord({
        pid,
        serverPid: process.pid,
        bin: 'sleep',
        spawnedAt: Date.now(),
      });

      expect(() => reapOrphanProcesses()).not.toThrow();
      expect(pidFileExists(pid)).toBe(false);
    });

    it('is a no-op when there are no PID records', () => {
      expect(() => reapOrphanProcesses()).not.toThrow();
    });
  });

  describe('reconcileInterruptedRuns', () => {
    it('turns a leftover marker into a failed run record', async () => {
      writeRunMarker(
        marker({ runId: 'run-1', workflowId: 'wf-1', workflowName: 'WF One' }),
      );

      await reconcileInterruptedRuns();

      const rec = await getRun('wf-1', 'run-1');
      expect(rec.status).toBe('failed');
      expect(rec.errorMessage).toContain('interrupted');
      expect(await listRunMarkers()).toHaveLength(0);
    });

    it('leaves a marker owned by a live second instance untouched', async () => {
      const otherServer = spawnSleep();
      writeRunMarker(
        marker({
          runId: 'run-2',
          workflowId: 'wf-2',
          serverPid: otherServer.pid!,
        }),
      );

      await reconcileInterruptedRuns();

      expect(await listRunMarkers()).toHaveLength(1);
      expect(await runExists('wf-2', 'run-2')).toBe(false);
    });

    it('drops a stale marker without clobbering an already-settled run', async () => {
      await saveRun({
        runId: 'run-3',
        workflowId: 'wf-3',
        workflowName: 'WF Three',
        status: 'succeeded',
        startedAt: 1,
        finishedAt: 2,
        durationMs: 1,
        scope: {},
        events: [],
      });
      writeRunMarker(
        marker({ runId: 'run-3', workflowId: 'wf-3', workflowName: 'WF Three' }),
      );

      await reconcileInterruptedRuns();

      expect(await listRunMarkers()).toHaveLength(0);
      const rec = await getRun('wf-3', 'run-3');
      expect(rec.status).toBe('succeeded'); // not overwritten
    });

    it('is a no-op when there are no markers', async () => {
      await reconcileInterruptedRuns();
      expect(await listRunMarkers()).toHaveLength(0);
    });
  });

  describe('reconcileQueuedRuns', () => {
    function fakeWorkflow(id: string): Workflow {
      return {
        id,
        name: id,
        version: 1,
        createdAt: 0,
        updatedAt: 0,
        nodes: [{ id: 's', type: 'start', position: { x: 0, y: 0 }, config: {} }],
        edges: [],
      };
    }

    function persisted(over: Partial<PersistedQueuedRun>): PersistedQueuedRun {
      return {
        queueId: 'q-1',
        workflow: fakeWorkflow('wf'),
        resolvedInputs: {},
        triggerId: 'trigger-0123456789abcdef',
        receivedAt: 1,
        serverPid: process.pid,
        ...over,
      };
    }

    function writeQueueFile(rec: PersistedQueuedRun): void {
      mkdirSync(queueDir(), { recursive: true });
      writeFileSync(
        path.join(queueDir(), `${rec.queueId}.json`),
        JSON.stringify(rec),
      );
    }

    /** A QueueRestoreTarget that records what it was asked to restore/drain. */
    function fakeQueue() {
      const restored: QueuedRun[][] = [];
      let drainCount = 0;
      const target: QueueRestoreTarget = {
        restore: (items) => { restored.push(items); },
        drain: async () => { drainCount += 1; },
      };
      return { target, restored, drainCount: () => drainCount };
    }

    it('re-enqueues a persisted queued run and kicks the drain', () => {
      writeQueueFile(persisted({ queueId: 'q-restore-1' }));
      const q = fakeQueue();

      reconcileQueuedRuns(q.target);

      expect(q.restored).toHaveLength(1);
      expect(q.restored[0].map((i) => i.queueId)).toEqual(['q-restore-1']);
      expect(q.drainCount()).toBe(1);
    });

    it('skips a queued run still owned by a live second instance', () => {
      const otherServer = spawnSleep();
      writeQueueFile(
        persisted({ queueId: 'q-other', serverPid: otherServer.pid! }),
      );
      const q = fakeQueue();

      reconcileQueuedRuns(q.target);

      expect(q.restored).toHaveLength(0);
      expect(q.drainCount()).toBe(0);
      // Left in place for the owning instance to drain.
      expect(existsSync(path.join(queueDir(), 'q-other.json'))).toBe(true);
    });

    it('re-enqueues a queued run whose owning server is gone', async () => {
      const dead = spawnSleep();
      const deadPid = dead.pid!;
      process.kill(deadPid, 'SIGKILL');
      await once(dead, 'exit');
      writeQueueFile(persisted({ queueId: 'q-dead', serverPid: deadPid }));
      const q = fakeQueue();

      reconcileQueuedRuns(q.target);

      expect(q.restored[0]?.map((i) => i.queueId)).toEqual(['q-dead']);
    });

    it('is a no-op when there are no persisted queued runs', () => {
      const q = fakeQueue();
      reconcileQueuedRuns(q.target);
      expect(q.restored).toHaveLength(0);
      expect(q.drainCount()).toBe(0);
    });
  });
});
