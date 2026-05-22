/*
 * Load + failure-injection harness.
 *
 * The reliability mechanisms — the slot pool's bounded admission, the trigger
 * queue's cap, boot-time crash recovery — are cold-path code: each exists for
 * a rare bad case, and a bug in one is only hit precisely when it is least
 * affordable. The unit suites cover each in isolation; this file drives them
 * at the scale and under the failure conditions they exist to survive, and
 * asserts the properties that make them trustworthy:
 *
 *   1. concurrency  — a burst of runs far exceeding slot-pool capacity all
 *      settle, with the pool holding in-flight work at the cap throughout and
 *      every run accounted for (no leaked controller, no stuck slot, no
 *      orphaned crash-recovery marker).
 *
 *   2. queue flood  — a trigger flood far past the queue cap admits exactly
 *      `maxQueue` runs and rejects the rest loud and typed; every admitted
 *      run still drains and starts, in FIFO order — the cap sheds new
 *      arrivals, it never loses accepted work.
 *
 *   3. crash recovery — a whole crash's worth of on-disk artifacts (run
 *      markers, persisted queued runs, orphaned process groups) is reconciled
 *      in one boot pass: every orphan reaped, every marker turned into a
 *      `failed` history record AND folded into the failure metric, every
 *      queued run re-enqueued.
 *
 * The aggregate event-buffer ceiling — the fourth reliability mechanism, the
 * OOM guard — is proven under 20-way concurrency by run-controller-buffer.ts;
 * that load proof is deliberately not duplicated here.
 *
 * A real OS-level `kill -9` of a running server under concurrent load lives
 * in tests/e2e/crash-recovery.e2e.ts. This file drives the boot-recovery
 * functions directly against staged artifacts: deterministic, fast, and able
 * to assert the batch interaction that the single-run e2e cannot.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { promises as fs } from 'node:fs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { WorkflowEngine } from './workflow-engine';
import { TriggerQueue } from './trigger-queue';
import type { QueuedRun, QueueRestoreTarget } from './trigger-queue';
import {
  reapOrphanProcesses,
  reconcileInterruptedRuns,
  reconcileQueuedRuns,
} from './crash-recovery';
import { listRunMarkers, runExists, writeRunMarker } from './run-store';
import { metrics, type GaugeSnapshot } from './metrics';
import { eventBus } from './event-bus';
import { flushAudit } from './audit-log';
import { pidsDir, queueDir } from './paths';
import type { ChildPidRecord } from './child-registry';
import type { PersistedQueuedRun } from './queue-store';
import type {
  EdgeHandle,
  NodeExecutor,
  NodeExecutorContext,
  Workflow,
} from '../shared/workflow';

const homeDir = process.env.HOME ?? os.homedir();

/* ─── shared fixtures ────────────────────────────────────────────────────── */

/** A minimal start → agent → end workflow whose agent works in `agentCwd`. */
function makeWorkflow(id: string, agentCwd: string): Workflow {
  return {
    id,
    name: id,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      { id: 'start-1', type: 'start', position: { x: 0, y: 0 }, config: {} },
      {
        id: 'agent-1',
        type: 'agent',
        position: { x: 0, y: 0 },
        config: { cwd: agentCwd, prompt: 'noop', providerId: 'mock-cli' },
      },
      {
        id: 'end-1',
        type: 'end',
        position: { x: 0, y: 0 },
        config: { outcome: 'succeeded' },
      },
    ],
    edges: [
      { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'agent-1' },
      { id: 'e2', source: 'agent-1', sourceHandle: 'next', target: 'end-1' },
    ],
  };
}

/** A single-node workflow — enough for the trigger queue and queue-store,
 *  which only ever read the id. Mirrors trigger-queue.test.ts's fixture. */
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

/**
 * A mock CLI-agent executor: it takes the run's directory lock (so the run
 * consumes a slot-pool slot, exactly as the real agent executor does), then
 * parks until the test hand-releases it — letting the test hold many runs
 * live at once and observe slot-pool ordering. Mirrors the helper in
 * concurrent-runs-integration.test.ts.
 */
function makeParkingAgent(): {
  exec: NodeExecutor;
  /** Resolve the parked agent for run `runId`. */
  release: (runId: string) => void;
  /** Resolves with the runId of the next agent to acquire its lock. */
  waitForAcquire: () => Promise<string>;
  /** Count of agents currently in their parked section. */
  inFlight: () => number;
} {
  const releases = new Map<string, () => void>();
  const inFlightRunIds = new Set<string>();
  let acquireWaiterResolve: ((runId: string) => void) | null = null;
  const acquireWaitQueue: string[] = [];

  const exec: NodeExecutor = {
    async execute(ctx: NodeExecutorContext) {
      const cfg = ctx.config as { cwd: string };
      // The real agent executor takes ctx.acquireDirLock around the spawn;
      // mirror that so the slot pool + lock manager are genuinely exercised.
      const release = await ctx.acquireDirLock!({
        path: cfg.cwd,
        signal: ctx.signal,
      });
      inFlightRunIds.add(ctx.runId!);
      if (acquireWaiterResolve) {
        const resolve = acquireWaiterResolve;
        acquireWaiterResolve = null;
        resolve(ctx.runId!);
      } else {
        acquireWaitQueue.push(ctx.runId!);
      }
      try {
        await new Promise<void>((resolve) =>
          releases.set(ctx.runId!, resolve),
        );
        return { outputs: { exitCode: 0 }, branch: 'next' as EdgeHandle };
      } finally {
        release();
        inFlightRunIds.delete(ctx.runId!);
      }
    },
  };

  return {
    exec,
    release(runId) {
      const r = releases.get(runId);
      if (r) {
        releases.delete(runId);
        r();
      }
    },
    waitForAcquire(): Promise<string> {
      const queued = acquireWaitQueue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve) => {
        acquireWaiterResolve = resolve;
      });
    },
    inFlight: () => inFlightRunIds.size,
  };
}

/** Poll `pred` until it holds, or throw once `timeoutMs` elapses. Used to
 *  wait out a fire-and-forget settle path deterministically. */
async function waitUntil(
  pred: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
}

/* ─── 1. concurrency — a burst far past slot-pool capacity ───────────────── */

describe('load + failure injection — concurrent burst through the engine', () => {
  const originalDataDir = process.env.INFLOOP_DATA_DIR;
  const originalRunsDir = process.env.INFLOOP_RUNS_DIR;
  let dataDir: string;
  let tempCwds: string[] = [];

  beforeAll(() => {
    // Isolate run markers + history into a temp data dir so the burst leaves
    // nothing behind in the developer's real data dir.
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'infloop-load-engine-'));
    process.env.INFLOOP_DATA_DIR = dataDir;
    delete process.env.INFLOOP_RUNS_DIR; // runsDir() → <dataDir>/runs
  });

  afterAll(async () => {
    // Drain buffered audit writes into the temp dir before it is removed.
    await flushAudit();
    rmSync(dataDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.INFLOOP_DATA_DIR;
    else process.env.INFLOOP_DATA_DIR = originalDataDir;
    if (originalRunsDir !== undefined) {
      process.env.INFLOOP_RUNS_DIR = originalRunsDir;
    }
  });

  beforeEach(() => {
    eventBus.clear();
    tempCwds = [];
  });

  afterEach(async () => {
    for (const d of tempCwds) {
      await fs.rm(d, { recursive: true, force: true });
    }
  });

  test('a 24-run burst all settles, the slot pool holding in-flight work at capacity', async () => {
    const N = 24;
    const CAPACITY = 4;

    // Each run's agent works in its own disjoint directory, so the lock
    // manager never serializes two runs on the same lock — the *slot pool* is
    // the sole gate, and it must hold concurrency at CAPACITY.
    for (let i = 0; i < N; i++) {
      tempCwds.push(await fs.mkdtemp(path.join(homeDir, 'inflp-load-')));
    }

    const agent = makeParkingAgent();
    const eng = new WorkflowEngine(
      {
        start: { execute: async () => ({ outputs: {}, branch: 'next' }) },
        agent: agent.exec,
        end: { execute: async () => ({ outputs: {}, branch: 'next' }) },
      },
      async () => {
        throw new Error('no subworkflows in this test');
      },
      { maxConcurrentRuns: CAPACITY },
    );

    const finishedStatuses: string[] = [];
    const unsub = eventBus.subscribe((e) => {
      if (e.type === 'run_finished') finishedStatuses.push(e.status);
    });

    // Kick off all N runs at once.
    const completions = tempCwds.map((cwd, i) =>
      eng.start(makeWorkflow(`load-wf-${i}`, cwd)),
    );

    // Only CAPACITY runs may hold a slot; the slot pool parks the rest in its
    // FIFO wait queue. Wait for the first CAPACITY agents to acquire.
    const acquired: string[] = [];
    for (let i = 0; i < CAPACITY; i++) {
      acquired.push(await agent.waitForAcquire());
    }

    expect(agent.inFlight()).toBe(CAPACITY);
    expect(eng.slotPool.size()).toBe(CAPACITY);
    // Every run is alive at once — parked, running, or waiting for a slot.
    expect(eng.list()).toHaveLength(N);
    // The overflow runs reach the slot pool's wait queue only after walking
    // start → agent and calling acquireDirLock — several awaits behind the
    // four that won slots. Wait for that to settle, then assert the pool
    // parked exactly the overflow.
    await waitUntil(() => eng.slotPool.waiterCount() === N - CAPACITY);
    expect(eng.slotPool.waiterCount()).toBe(N - CAPACITY);

    // Release runs one at a time. Each settle frees exactly one slot, which
    // promotes exactly one waiter — so in-flight work never exceeds CAPACITY.
    for (let i = 0; i < N; i++) {
      agent.release(acquired[i]);
      if (acquired.length < N) acquired.push(await agent.waitForAcquire());
      expect(agent.inFlight()).toBeLessThanOrEqual(CAPACITY);
      expect(eng.slotPool.size()).toBeLessThanOrEqual(CAPACITY);
    }

    await Promise.all(completions);
    unsub();

    // No lost runs: every run reached a terminal state and succeeded.
    expect(finishedStatuses).toHaveLength(N);
    expect(finishedStatuses.filter((s) => s !== 'succeeded')).toEqual([]);

    // Accurate accounting: the engine registry and slot pool are clean — no
    // leaked controller, no stuck slot, no parked waiter.
    expect(eng.list()).toHaveLength(0);
    expect(eng.slotPool.size()).toBe(0);
    expect(eng.slotPool.waiterCount()).toBe(0);

    // The fire-and-forget settle path removes each run's crash-recovery
    // marker once its history is safely written. Wait for that to quiesce,
    // and assert it: a leftover marker means a settled run still looks live.
    await waitUntil(async () => (await listRunMarkers()).length === 0);
    expect(await listRunMarkers()).toHaveLength(0);
  }, 30_000);
});

/* ─── 2. queue flood — a trigger storm far past the queue cap ─────────────── */

describe('load + failure injection — trigger queue flood', () => {
  afterEach(() => {
    eventBus.clear();
  });

  test('a flood far past the queue cap admits exactly maxQueue runs and rejects the rest, losing none', async () => {
    const MAX_QUEUE = 100; // the production default (TriggerQueue maxQueue)
    const FLOOD = 130;

    const started: string[] = [];
    const q = new TriggerQueue({
      engineStart: async (wf) => {
        started.push(wf.id);
        return `run-${wf.id}`;
      },
      loadWorkflow: async (id) => fakeWorkflow(id),
      // maxQueue omitted → the real 100-item default.
    });

    let accepted = 0;
    let rejected = 0;
    const acceptedWorkflowIds: string[] = [];
    for (let i = 0; i < FLOOD; i++) {
      try {
        q.enqueue({
          workflow: fakeWorkflow(`flood-wf-${i}`),
          resolvedInputs: {},
          triggerId: 't',
          receivedAt: i,
        });
        accepted++;
        acceptedWorkflowIds.push(`flood-wf-${i}`);
      } catch (err) {
        rejected++;
        // Over-cap arrivals fail loud and typed — never silently dropped.
        expect((err as { code?: string }).code).toBe('QUEUE_FULL');
      }
    }

    // The cap is a precise boundary: exactly MAX_QUEUE admitted, rest rejected.
    expect(accepted).toBe(MAX_QUEUE);
    expect(rejected).toBe(FLOOD - MAX_QUEUE);
    expect(q.size()).toBe(MAX_QUEUE);

    await q.drain();

    // Every admitted run started, in FIFO arrival order — the flood shed new
    // arrivals but never lost or reordered work it had already accepted.
    expect(started).toEqual(acceptedWorkflowIds);
    expect(q.size()).toBe(0);
  });
});

/* ─── 3. crash recovery — a whole crash's worth of artifacts at once ──────── */

const ZERO_GAUGES: GaugeSnapshot = {
  runsActive: 0,
  slotPoolInUse: 0,
  slotPoolCapacity: 0,
  slotPoolWaiting: 0,
  queueDepth: 0,
  eventBufferEvents: 0,
  eventBufferLimit: 0,
  costBudgetSpentUsd: 0,
  costBudgetLimitUsd: 0,
  processUptimeSeconds: 0,
  dataDirWritable: true,
  // null = backups not configured; the freshness gauge is then omitted.
  backupLastSuccessTimestampSeconds: null,
};

/** The current value of `infloop_runs_total{status="failed"}` on the process
 *  metrics singleton. Read as a delta so it is robust to whatever other test
 *  files have already counted into the shared registry. */
function failedRunCount(): number {
  const body = metrics.render(ZERO_GAUGES);
  for (const line of body.split('\n')) {
    if (line.startsWith('infloop_runs_total{status="failed"}')) {
      return Number(line.slice(line.lastIndexOf(' ') + 1));
    }
  }
  throw new Error('infloop_runs_total{status="failed"} not found in metrics');
}

describe('load + failure injection — batch crash recovery', () => {
  const originalDataDir = process.env.INFLOOP_DATA_DIR;
  const originalRunsDir = process.env.INFLOOP_RUNS_DIR;
  let dataDir: string;
  const children: ChildProcess[] = [];

  beforeAll(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'infloop-load-crash-'));
    process.env.INFLOOP_DATA_DIR = dataDir;
    delete process.env.INFLOOP_RUNS_DIR; // runsDir() → <dataDir>/runs
  });

  afterAll(async () => {
    await flushAudit();
    rmSync(dataDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.INFLOOP_DATA_DIR;
    else process.env.INFLOOP_DATA_DIR = originalDataDir;
    if (originalRunsDir !== undefined) {
      process.env.INFLOOP_RUNS_DIR = originalRunsDir;
    }
  });

  afterEach(() => {
    // Reap any staged child that survived the test (e.g. an assertion threw
    // before reapOrphanProcesses ran).
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

  /** Spawn a long-lived detached child standing in for an orphaned CLI. The
   *  sleep is short enough to bound the orphan leak if the test runner is
   *  hard-killed mid-test, yet far outlasts the millisecond-scale reap. */
  function spawnSleep(): ChildProcess {
    const c = spawn('sleep', ['15'], { detached: true, stdio: 'ignore' });
    c.unref();
    children.push(c);
    return c;
  }

  function writePidRecord(rec: ChildPidRecord): void {
    mkdirSync(pidsDir(), { recursive: true });
    writeFileSync(path.join(pidsDir(), `${rec.pid}.json`), JSON.stringify(rec));
  }

  function writeQueueFile(rec: PersistedQueuedRun): void {
    mkdirSync(queueDir(), { recursive: true });
    writeFileSync(
      path.join(queueDir(), `${rec.queueId}.json`),
      JSON.stringify(rec),
    );
  }

  test('boot-time recovery reconciles a whole crash worth of runs at once — markers, queued runs, and orphan process groups', async () => {
    const RUNS = 25;
    const QUEUED = 25;
    const ORPHANS = 8;

    // ── Stage a crash: write the on-disk artifacts that a server dying
    //    mid-load would leave behind. ──────────────────────────────────────

    // (a) In-flight runs — one active-run marker each, none settled.
    for (let i = 0; i < RUNS; i++) {
      writeRunMarker({
        runId: `load-run-${i}`,
        workflowId: `load-wf-${i}`,
        workflowName: `Load WF ${i}`,
        startedAt: Date.now(),
        serverPid: process.pid,
      });
    }

    // (b) Accepted-but-not-started runs — one persisted queue file each.
    for (let i = 0; i < QUEUED; i++) {
      writeQueueFile({
        queueId: `load-q-${i}`,
        workflow: fakeWorkflow(`load-qwf-${i}`),
        resolvedInputs: {},
        triggerId: 't',
        correlationId: `cid-load-${i}`,
        receivedAt: i,
        serverPid: process.pid,
      });
    }

    // (c) Orphaned provider process groups — a live detached child plus its
    //     PID record, exactly what a SIGKILL of the server leaves running.
    const orphanPids: number[] = [];
    for (let i = 0; i < ORPHANS; i++) {
      const child = spawnSleep();
      orphanPids.push(child.pid!);
      writePidRecord({
        pid: child.pid!,
        serverPid: process.pid,
        bin: 'sleep',
        spawnedAt: Date.now(),
      });
    }

    // ── Boot-time recovery, in the order server.ts runs it. ───────────────

    // Attach the exit listeners BEFORE the kill: awaiting them one at a time
    // would miss the 'exit' of a child that died while an earlier await ran.
    const exits = children.map((c) => once(c, 'exit'));

    // Orphan reaping: every orphaned group is SIGKILLed, every PID file gone.
    reapOrphanProcesses();
    for (const [, signal] of await Promise.all(exits)) {
      expect(signal).toBe('SIGKILL');
    }
    for (const pid of orphanPids) {
      expect(existsSync(path.join(pidsDir(), `${pid}.json`))).toBe(false);
    }

    // Run reconciliation: every marker becomes a `failed` history record and
    // — the fix under test — every one is folded into the failure metric.
    const failedBefore = failedRunCount();
    await reconcileInterruptedRuns();
    const failedAfter = failedRunCount();

    expect(await listRunMarkers()).toHaveLength(0);
    for (let i = 0; i < RUNS; i++) {
      expect(await runExists(`load-wf-${i}`, `load-run-${i}`)).toBe(true);
    }
    // Without the metrics fix this delta is 0 — a hard crash never reaches
    // recordRunSettled, so infloop_runs_total{status="failed"} silently
    // undercounts exactly the failure mode an operator most needs to see.
    expect(failedAfter - failedBefore).toBe(RUNS);

    // Queue reconciliation: every persisted queued run is re-enqueued and the
    // drain kicked — none of the accepted-but-unstarted runs is lost.
    const restored: QueuedRun[] = [];
    let drainCalls = 0;
    const queue: QueueRestoreTarget = {
      restore: (items) => {
        restored.push(...items);
      },
      drain: async () => {
        drainCalls++;
      },
    };
    reconcileQueuedRuns(queue);

    expect(restored).toHaveLength(QUEUED);
    expect(new Set(restored.map((r) => r.queueId)).size).toBe(QUEUED);
    expect(drainCalls).toBe(1);
  }, 30_000);
});
