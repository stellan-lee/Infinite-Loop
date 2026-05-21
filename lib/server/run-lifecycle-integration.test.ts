/*
 * End-to-end run-lifecycle smoke test.
 *
 * The rest of the suite is unit-level: executors, the engine, and the API
 * routes are each tested in isolation, often with the others mocked. This test
 * deliberately mocks nothing — it drives the product's core promise through
 * the real wiring:
 *
 *   compose  — save a workflow through the real workflow-store
 *   run      — start it via the real POST /api/run route + real engine
 *   stream   — observe events on the same bus the SSE endpoint feeds from
 *   persist  — let the run settle and land in on-disk history
 *   replay   — read it back through GET /api/runs and GET /api/runs/[wf]/[run]
 *
 * The workflow is built only from in-process node types (start / branch / end)
 * so the test needs no provider CLI on PATH.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { POST as runPOST } from '@/app/api/run/route';
import { GET as runsGET } from '@/app/api/runs/route';
import { GET as runGET } from '@/app/api/runs/[workflowId]/[runId]/route';
import { saveWorkflow } from './workflow-store';
import { workflowEngine } from './workflow-engine';
import { eventBus } from './event-bus';
import type { Workflow, WorkflowEvent } from '../shared/workflow';

const tmpWfDir = path.join(os.tmpdir(), `infinite-loop-run-lifecycle-wf-${process.pid}`);
const tmpRunsDir = path.join(os.tmpdir(), `infinite-loop-run-lifecycle-runs-${process.pid}`);

const savedEnv: Record<string, string | undefined> = {};

/** Stash an env var's current value, then set it — or delete it when `value`
 *  is omitted. `restoreEnv` puts every stashed var back and clears the stash. */
function stashEnv(name: string, value?: string): void {
  savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function restoreEnv(): void {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const name of Object.keys(savedEnv)) delete savedEnv[name];
}

beforeEach(async () => {
  await fs.rm(tmpWfDir, { recursive: true, force: true });
  await fs.rm(tmpRunsDir, { recursive: true, force: true });
  await fs.mkdir(tmpWfDir, { recursive: true });
  await fs.mkdir(tmpRunsDir, { recursive: true });
  stashEnv('INFLOOP_WORKFLOWS_DIR', tmpWfDir);
  stashEnv('INFLOOP_RUNS_DIR', tmpRunsDir);
  // A leaked token from another test file would 401 every route call here.
  stashEnv('INFLOOP_API_TOKEN');
  workflowEngine.reset();
  eventBus.clear();
});

afterEach(async () => {
  workflowEngine.reset();
  eventBus.clear();
  restoreEnv();
  await fs.rm(tmpWfDir, { recursive: true, force: true });
  await fs.rm(tmpRunsDir, { recursive: true, force: true });
});

/** Poll `probe` until it returns a defined value, or throw after `timeoutMs`. */
async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A minimal real workflow: start -> branch (true) -> end. No provider CLIs. */
function buildWorkflow(id: string): Workflow {
  const now = Date.now();
  return {
    id,
    name: 'E2E smoke',
    version: 1,
    createdAt: now,
    updatedAt: now,
    nodes: [
      { id: 'start-1', type: 'start', position: { x: 0, y: 0 }, config: {} },
      {
        id: 'branch-1',
        type: 'branch',
        position: { x: 200, y: 0 },
        config: { lhs: 'hello world', op: 'contains', rhs: 'world' },
      },
      {
        id: 'end-ok',
        type: 'end',
        position: { x: 400, y: -50 },
        config: { outcome: 'succeeded' },
      },
      {
        id: 'end-no',
        type: 'end',
        position: { x: 400, y: 50 },
        config: { outcome: 'failed' },
      },
    ],
    edges: [
      { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'branch-1' },
      { id: 'e2', source: 'branch-1', sourceHandle: 'true', target: 'end-ok' },
      { id: 'e3', source: 'branch-1', sourceHandle: 'false', target: 'end-no' },
    ],
  };
}

describe('run lifecycle — compose -> run -> stream -> persist -> replay', () => {
  test('a workflow started via /api/run streams events and lands in history', async () => {
    const workflowId = 'smoke-e2e';

    // compose: persist the workflow through the real store the route reads from.
    await saveWorkflow(buildWorkflow(workflowId));

    // stream: subscribe to the bus the SSE endpoint feeds from, before kickoff.
    const streamed: WorkflowEvent[] = [];
    const off = eventBus.subscribe((e) => streamed.push(e));

    // run: start through the real route (real engine, real executors).
    const startRes = await runPOST(
      new Request('http://localhost/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowId }),
      }),
    );
    expect(startRes.status).toBe(202);
    const { runId } = (await startRes.json()) as { runId: string };
    expect(runId).toBeTruthy();

    // persist + replay: poll the history route until the settled run is on
    // disk. The route serves a synthetic engine snapshot (no `events` field)
    // until the fire-and-forget persist writes the real record — wait for that.
    const record = await waitFor(async () => {
      const res = await runGET(
        new Request(`http://localhost/api/runs/${workflowId}/${runId}`),
        { params: Promise.resolve({ workflowId, runId }) },
      );
      if (res.status !== 200) return undefined;
      const body = (await res.json()) as {
        run?: { status?: string; events?: unknown; scope?: Record<string, unknown> };
      };
      return Array.isArray(body.run?.events) ? body.run : undefined;
    });

    expect(record.status).toBe('succeeded');
    expect((record.events as WorkflowEvent[]).length).toBeGreaterThan(0);
    // The branch routed down its `true` edge, so its outputs are in scope.
    expect(record.scope).toBeDefined();
    expect(record.scope!['branch-1']).toBeDefined();

    off();

    // stream: the run's events reached the bus, each stamped with the runId.
    const mine = streamed.filter((e) => (e as { runId?: string }).runId === runId);
    expect(mine.some((e) => e.type === 'run_started')).toBe(true);
    expect(mine.some((e) => e.type === 'node_started')).toBe(true);
    expect(
      mine.some(
        (e) => e.type === 'run_finished' && (e as { status?: string }).status === 'succeeded',
      ),
    ).toBe(true);

    // replay: the run is discoverable in the workflow's history listing.
    const listRes = await runsGET(
      new Request(`http://localhost/api/runs?workflowId=${workflowId}`),
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      runs: Array<{ runId: string; status: string }>;
    };
    const summary = listBody.runs.find((r) => r.runId === runId);
    expect(summary).toBeDefined();
    expect(summary!.status).toBe('succeeded');
  });
});
