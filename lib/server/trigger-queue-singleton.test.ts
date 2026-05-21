import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type {
  EdgeHandle,
  NodeExecutor,
  Workflow,
  WorkflowNode,
} from '../shared/workflow';

// Capture the real modules first so the mocks can be reverted at file end.
// bun's `mock.module` is global to the test process, so anything captured
// AFTER the mock call would itself be the mock.
const realTemplating = { ...(await import('./templating')) };
const realRunStore = { ...(await import('./run-store')) };

mock.module('./templating', () => ({
  resolve: (text: string) => ({ text, warnings: [] }),
}));
mock.module('./run-store', () => ({
  saveRun: async () => undefined,
  historyLimit: () => 100,
  listRuns: async () => [],
  getRun: async () => {
    throw new Error('run not found');
  },
}));

const { engineStartAdapter, triggerQueue } = await import('./trigger-queue-singleton');
const { WorkflowEngine } = await import('./workflow-engine');
const { GlobalCostBudget } = await import('./cost-budget');

afterAll(() => {
  mock.module('./templating', () => realTemplating);
  mock.module('./run-store', () => realRunStore);
});

describe('triggerQueue singleton', () => {
  test('exists and exposes the TriggerQueue interface', () => {
    expect(typeof triggerQueue.enqueue).toBe('function');
    expect(typeof triggerQueue.drain).toBe('function');
    expect(typeof triggerQueue.size).toBe('function');
  });
});

describe('engineStartAdapter', () => {
  const startNode: WorkflowNode = {
    id: 'start-1', type: 'start', position: { x: 0, y: 0 }, config: {},
  };
  const wf: Workflow = {
    id: 'w-adapter',
    name: 'adapter-test',
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    nodes: [startNode],
    edges: [],
  };

  function hangingExecutor(): { exec: NodeExecutor; release: () => void } {
    const pending: Array<(v: { branch: EdgeHandle; outputs: Record<string, unknown> }) => void> = [];
    const exec: NodeExecutor = {
      execute: () =>
        new Promise((r) => {
          pending.push(r);
        }),
    };
    return {
      exec,
      // Release ALL parked invocations so tests with multiple concurrent
      // runs don't leak hanging promises after teardown.
      release: () => {
        while (pending.length > 0) {
          pending.shift()!({ branch: 'next', outputs: {} });
        }
      },
    };
  }

  test('returns a freshly-assigned runId on the idle path', async () => {
    const { exec, release } = hangingExecutor();
    const engine = new WorkflowEngine({ start: exec });

    expect(engine.getState().status).toBe('idle');
    const runId = await engineStartAdapter(engine, wf, { resolvedInputs: {} });

    expect(typeof runId).toBe('string');
    expect(runId.length).toBeGreaterThan(0);
    expect(engine.getState().status).toBe('running');
    expect(engine.getState().runId).toBe(runId);

    // Let the in-flight run finish so we don't leak a pending promise.
    release();
    // Give the engine a tick to settle.
    await new Promise((r) => setTimeout(r, 5));
  });

  test('admits a second run while the first is still in flight (lazy slot model)', async () => {
    const { exec, release } = hangingExecutor();
    const engine = new WorkflowEngine({ start: exec });

    // Kick off the first run; it parks inside the hanging start executor.
    void engine.start(wf).catch(() => {});
    await Promise.resolve();
    expect(engine.getState().status).toBe('running');
    const firstRunId = engine.getState().runId;

    // Stage 5: the adapter no longer pre-checks busy. A second start returns
    // a NEW runId synchronously and both runs are alive concurrently.
    const secondRunId = await engineStartAdapter(engine, wf, { resolvedInputs: {} });
    expect(secondRunId).toBeTruthy();
    expect(secondRunId).not.toBe(firstRunId);
    expect(engine.list().length).toBe(2);

    release();
    await new Promise((r) => setTimeout(r, 5));
  });

  test('refuses to start a run when the process-wide cost budget is exhausted', async () => {
    const { exec } = hangingExecutor();
    const engine = new WorkflowEngine({ start: exec });
    const budget = new GlobalCostBudget({ ceilingUsd: 1 });
    budget.add(2); // $2 spent against a $1 ceiling — exhausted.
    expect(budget.exceeded()).toBe(true);

    let thrown: (Error & { code?: string }) | undefined;
    try {
      await engineStartAdapter(engine, wf, { resolvedInputs: {} }, budget);
    } catch (err) {
      thrown = err as Error & { code?: string };
    }

    expect(thrown?.code).toBe('COST_BUDGET_EXCEEDED');
    // The refusal runs BEFORE engine.startRun — no controller is registered
    // and no run is left half-started.
    expect(engine.list().length).toBe(0);
    expect(engine.getState().status).toBe('idle');
  });

  test('admits a run when the cost budget is set but not yet exhausted', async () => {
    const { exec, release } = hangingExecutor();
    const engine = new WorkflowEngine({ start: exec });
    const budget = new GlobalCostBudget({ ceilingUsd: 100 });
    budget.add(10); // well under the ceiling — admission proceeds normally.

    const runId = await engineStartAdapter(
      engine,
      wf,
      { resolvedInputs: {} },
      budget,
    );
    expect(typeof runId).toBe('string');
    expect(engine.list().length).toBe(1);

    release();
    await new Promise((r) => setTimeout(r, 5));
  });
});
