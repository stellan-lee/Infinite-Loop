import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test';
import type {
  EdgeHandle,
  NodeExecutor,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
} from '../shared/workflow';

/*
 * Global event-memory budget — buffer-cap coverage for RunController.
 *
 * RunController buffers a run's events in two arrays: `recentEvents` (SSE
 * replay) and `runEventLog` (persistence). Each is capped per run; the
 * EventMemoryBudget caps the AGGREGATE across concurrent runs so a burst of
 * triggers cannot OOM the process. This file is the load/soak proof the
 * production-readiness review asked for, made deterministic — event-count is
 * directly proportional to retained memory, so a plateau in buffered events
 * IS the "RSS plateaus under load" assertion, without flaky RSS sampling.
 *
 * It pins:
 *   1. A lone run keeps the full per-run hard caps — no regression, and the
 *      `truncated` flag is surfaced onto the persisted record.
 *   2. Under simulated concurrency the budget squeezes one run's buffers to
 *      its fair share.
 *   3. Two dozen genuinely-concurrent runs flooding events in parallel hold
 *      the aggregate buffered-event count at the budget — and every run
 *      unregisters cleanly on settle (no leak).
 *
 * run-store is stubbed so settling a run writes nothing to the data dir;
 * `saveRun` is captured so a test can assert the persisted record's shape.
 */
let lastSaved: Record<string, unknown> | undefined;
const realRunStore = { ...(await import('./run-store')) };
mock.module('./run-store', () => ({
  ...realRunStore,
  saveRun: async (record: Record<string, unknown>) => {
    lastSaved = record;
  },
  writeRunMarker: () => undefined,
  removeRunMarker: async () => undefined,
}));

const { RunController, EVENT_HISTORY_CAP, PERSIST_EVENT_CAP } = await import(
  './run-controller'
);
const { EventMemoryBudget } = await import('./event-memory-budget');
const { eventBus } = await import('./event-bus');
const { flushAudit } = await import('./audit-log');

afterAll(() => {
  // Restore the real run-store so later test files share the genuine impl.
  mock.module('./run-store', () => realRunStore);
});

beforeEach(() => {
  eventBus.clear();
  lastSaved = undefined;
});
afterEach(async () => {
  eventBus.clear();
  // A settled run fires `recordAudit` (fire-and-forget) into audit-log's
  // module-level buffer. Drain it so those entries cannot leak into a later
  // test file that asserts on a clean audit log.
  await flushAudit();
});

/** Executor that always settles on `branch`. */
function staticExec(branch: EdgeHandle = 'next'): NodeExecutor {
  return {
    async execute() {
      return { branch, outputs: {} };
    },
  };
}

/**
 * Agent-shaped executor that emits `count` stdout events, then — when a
 * `gate` is supplied — parks on it so the test can hold many runs live and
 * buffering at once. `onFlooded` fires once the emit burst is done.
 */
function floodExec(
  count: number,
  hooks?: { onFlooded?: () => void; gate?: Promise<void> },
): NodeExecutor {
  return {
    async execute(ctx) {
      // `emitStdoutChunk` is optional on the executor context type; the
      // engine always supplies it. Each call emits one `stdout_chunk` event.
      for (let i = 0; i < count; i++) ctx.emitStdoutChunk?.(`line-${i}`);
      hooks?.onFlooded?.();
      if (hooks?.gate) await hooks.gate;
      return { branch: 'next', outputs: {} };
    },
  };
}

const NODES: WorkflowNode[] = [
  { id: 'start-1', type: 'start', position: { x: 0, y: 0 }, config: {} },
  {
    id: 'agent-1',
    type: 'agent',
    position: { x: 0, y: 0 },
    config: { prompt: 'p', cwd: '/tmp' },
  },
  { id: 'end-1', type: 'end', position: { x: 0, y: 0 }, config: {} },
];
const EDGES: WorkflowEdge[] = [
  { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'agent-1' },
  { id: 'e2', source: 'agent-1', sourceHandle: 'next', target: 'end-1' },
];
/** start → agent → end. The agent executor is supplied per test; the
 *  workflow object is read-only during a run, so controllers may share it. */
const WF: Workflow = {
  id: 'wf-flood',
  name: 'flood',
  version: 1,
  createdAt: 0,
  updatedAt: 0,
  nodes: NODES,
  edges: EDGES,
};

const noSubworkflows = async (): Promise<Workflow> => {
  throw new Error('no subworkflows in the buffer test');
};

describe('RunController — event buffers, lone run', () => {
  it('keeps the full per-run hard caps and surfaces truncation', async () => {
    // A budget far larger than the per-run hard cap: nothing to squeeze, so
    // the run is bounded by PERSIST_EVENT_CAP / EVENT_HISTORY_CAP exactly as
    // it was before the budget existed.
    const budget = new EventMemoryBudget({ totalCap: 5_000_000 });
    const controller = new RunController({
      runId: 'solo',
      workflow: WF,
      executors: {
        start: staticExec(),
        end: staticExec(),
        agent: floodExec(PERSIST_EVENT_CAP + 5_000),
      },
      loadWorkflow: noSubworkflows,
      eventBudget: budget,
    });

    await controller.start();

    expect(controller.bufferedEventCount()).toBe(PERSIST_EVENT_CAP);
    expect(controller.getState().events!.length).toBe(EVENT_HISTORY_CAP);
    // Overflowing the persisted log must mark the saved record truncated.
    expect(lastSaved?.truncated).toBe(true);
  });

  it('does not mark a within-cap run truncated', async () => {
    const budget = new EventMemoryBudget({ totalCap: 5_000_000 });
    const controller = new RunController({
      runId: 'small',
      workflow: WF,
      executors: {
        start: staticExec(),
        end: staticExec(),
        agent: floodExec(50),
      },
      loadWorkflow: noSubworkflows,
      eventBudget: budget,
    });

    await controller.start();

    expect(controller.bufferedEventCount()).toBeLessThan(EVENT_HISTORY_CAP);
    // `truncated: args.truncated || undefined` — a non-truncated run omits it.
    expect(lastSaved?.truncated).toBeUndefined();
  });
});

describe('RunController — event buffers, under concurrency', () => {
  it('squeezes one run’s buffers to its budget fair share', async () => {
    const budget = new EventMemoryBudget({ totalCap: 40_000 });
    // Simulate 9 other live runs; with this run that is 10, so the fair
    // share is 4_000 events.
    for (let i = 0; i < 9; i++) budget.register();

    const controller = new RunController({
      runId: 'squeezed',
      workflow: WF,
      executors: {
        start: staticExec(),
        end: staticExec(),
        agent: floodExec(20_000),
      },
      loadWorkflow: noSubworkflows,
      eventBudget: budget,
    });

    await controller.start();
    for (let i = 0; i < 9; i++) budget.unregister();

    // The run emitted 20_000 events but the budget held both buffers to the
    // 4_000-event fair share (recentEvents is clamped to never exceed it).
    expect(controller.bufferedEventCount()).toBe(4_000);
    expect(controller.getState().events!.length).toBe(4_000);
  });

  it('holds the aggregate at the budget while two dozen runs flood at once', async () => {
    const N = 20;
    const TOTAL_CAP = 40_000; // 2_000 per run at N-way concurrency
    const FLOOD = 2_500; // each run emits more than its fair share
    const budget = new EventMemoryBudget({ totalCap: TOTAL_CAP });

    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let flooded = 0;
    let signalAllFlooded!: () => void;
    const allFlooded = new Promise<void>((resolve) => {
      signalAllFlooded = resolve;
    });
    const onFlooded = () => {
      if (++flooded === N) signalAllFlooded();
    };

    const controllers = Array.from(
      { length: N },
      (_, i) =>
        new RunController({
          runId: `run-${i}`,
          workflow: WF,
          executors: {
            start: staticExec(),
            end: staticExec(),
            agent: floodExec(FLOOD, { onFlooded, gate }),
          },
          loadWorkflow: noSubworkflows,
          eventBudget: budget,
        }),
    );

    const completions = controllers.map((c) => c.start());
    // Every run has emitted its flood and is now parked on the gate: all N
    // are live, registered, and buffering simultaneously.
    await allFlooded;

    expect(budget.activeRuns).toBe(N);
    const aggregate = controllers.reduce(
      (sum, c) => sum + c.bufferedEventCount(),
      0,
    );
    // The proof: the runs together emitted far more than the budget
    // (`N * FLOOD` events), yet the budget held the aggregate at the
    // ceiling — memory plateaus, it does not grow with the number of runs.
    expect(aggregate).toBeLessThanOrEqual(TOTAL_CAP);
    expect(aggregate).toBeGreaterThan(TOTAL_CAP * 0.8);
    expect(aggregate).toBeLessThan(N * FLOOD);
    for (const c of controllers) {
      expect(c.bufferedEventCount()).toBeLessThanOrEqual(TOTAL_CAP / N);
    }

    releaseGate();
    await Promise.all(completions);
    // Every run unregistered from the budget on settle — no participant leak.
    expect(budget.activeRuns).toBe(0);
  });
});
