import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type {
  EdgeHandle,
  NodeExecutor,
  Workflow,
  WorkflowEvent,
  WorkflowNode,
} from '../../shared/workflow';

const realRunStore = { ...(await import('../run-store')) };
mock.module('../run-store', () => ({
  saveRun: async () => undefined,
  historyLimit: () => 100,
  listRuns: async () => [],
  getRun: async () => {
    throw new Error('run not found');
  },
}));

// templating must be REAL here so __inputs / dotted lookups exercise the
// production resolver — that's the whole point of input/output binding tests.
const { WorkflowEngine } = await import('../workflow-engine');
const { eventBus } = await import('../event-bus');
const { saveWorkflow } = await import('../workflow-store');

afterAll(() => {
  mock.module('../run-store', () => realRunStore);
});

const startNode: WorkflowNode = {
  id: 'start-1',
  type: 'start',
  position: { x: 0, y: 0 },
  config: {},
};
const endNode: WorkflowNode = {
  id: 'end-1',
  type: 'end',
  position: { x: 0, y: 0 },
  config: { outcome: 'succeeded' },
};

function constExec(branch: EdgeHandle, outputs: Record<string, unknown> = {}): NodeExecutor {
  return {
    async execute() {
      return { branch, outputs };
    },
  };
}

const baseExecutors = (overrides: Partial<Record<string, NodeExecutor>> = {}) => ({
  start: constExec('next'),
  end: constExec('next'),
  agent: constExec('next'),
  condition: constExec('next'),
  loop: constExec('next'),
  parallel: constExec('next'),
  subworkflow: constExec('next'),
  branch: constExec('next'),
  ...overrides,
});

let tmpDir: string;
let prevEnv: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-loop-subwf-'));
  prevEnv = process.env.INFLOOP_WORKFLOWS_DIR;
  process.env.INFLOOP_WORKFLOWS_DIR = tmpDir;
  eventBus.clear();
});

afterEach(async () => {
  if (prevEnv === undefined) delete process.env.INFLOOP_WORKFLOWS_DIR;
  else process.env.INFLOOP_WORKFLOWS_DIR = prevEnv;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  eventBus.clear();
});

function captureEvents(): { events: WorkflowEvent[]; off: () => void } {
  const events: WorkflowEvent[] = [];
  const off = eventBus.subscribe((e) => events.push(e));
  return { events, off };
}

describe('subworkflow walker', () => {
  it('binds inputs into child __inputs scope and copies declared outputs back', async () => {
    // Child workflow: reads {{__inputs.task}} via templating, an agent emits
    // an output, then end. We capture the resolved prompt to verify.
    let seenPrompt = '';
    const child: Workflow = {
      id: 'child',
      name: 'child',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        startNode,
        {
          id: 'agent-c',
          type: 'agent',
          position: { x: 0, y: 0 },
          config: {
            providerId: 'claude',
            prompt: '{{__inputs.task}}',
            cwd: '/tmp',
            timeoutMs: 1000,
          },
        },
        { id: 'end-1', type: 'end', position: { x: 0, y: 0 }, config: { outcome: 'succeeded' } },
      ],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'agent-c' },
        { id: 'e2', source: 'agent-c', sourceHandle: 'next', target: 'end-1' },
      ],
    };
    await saveWorkflow(child);

    const parent: Workflow = {
      id: 'parent',
      name: 'parent',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        startNode,
        {
          id: 'sub-1',
          type: 'subworkflow',
          position: { x: 0, y: 0 },
          config: {
            workflowId: 'child',
            inputs: { task: 'hello world' },
            outputs: { result: 'agent-c.stdout' },
          },
        },
        endNode,
      ],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'sub-1' },
        { id: 'e2', source: 'sub-1', sourceHandle: 'next', target: 'end-1' },
      ],
    };

    const eng = new WorkflowEngine(
      baseExecutors({
        agent: {
          async execute(ctx) {
            const cfg = ctx.config as { prompt: string };
            seenPrompt = cfg.prompt;
            return { branch: 'next' as EdgeHandle, outputs: { stdout: 'CHILD-OUT' } };
          },
        },
      }),
    );

    await eng.start(parent);
    expect(eng.getState().status).toBe('succeeded');
    expect(seenPrompt).toBe('hello world');
    const subOut = eng.getState().scope['sub-1'] as { status: string; result: unknown };
    expect(subOut.status).toBe('succeeded');
    expect(subOut.result).toBe('CHILD-OUT');
  });

  it('returns error when target workflowId is missing', async () => {
    const parent: Workflow = {
      id: 'parent2',
      name: 'parent2',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        startNode,
        {
          id: 'sub-1',
          type: 'subworkflow',
          position: { x: 0, y: 0 },
          config: { workflowId: 'does-not-exist', inputs: {}, outputs: {} },
        },
        {
          id: 'err-end',
          type: 'end',
          position: { x: 0, y: 0 },
          config: { outcome: 'failed' },
        },
      ],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'sub-1' },
        { id: 'e2', source: 'sub-1', sourceHandle: 'error', target: 'err-end' },
      ],
    };
    const eng = new WorkflowEngine(baseExecutors());
    await eng.start(parent);
    expect(eng.getState().status).toBe('failed');
    const subOut = eng.getState().scope['sub-1'] as { status: string; errorMessage: string };
    expect(subOut.status).toBe('failed');
    expect(subOut.errorMessage).toMatch(/load failed|not found/i);
  });

  it('rejects save when subworkflow chain forms a cycle', async () => {
    const a: Workflow = {
      id: 'a',
      name: 'a',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        startNode,
        {
          id: 'sub-a',
          type: 'subworkflow',
          position: { x: 0, y: 0 },
          config: { workflowId: 'b', inputs: {}, outputs: {} },
        },
        endNode,
      ],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'sub-a' },
        { id: 'e2', source: 'sub-a', sourceHandle: 'next', target: 'end-1' },
      ],
    };
    // First save 'a' — at this point 'b' doesn't exist yet, so cycle check
    // tolerates the missing edge as "not a cycle".
    await saveWorkflow(a);

    // Now define 'b' that calls back into 'a' — this would close the loop.
    const b: Workflow = {
      id: 'b',
      name: 'b',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        startNode,
        {
          id: 'sub-b',
          type: 'subworkflow',
          position: { x: 0, y: 0 },
          config: { workflowId: 'a', inputs: {}, outputs: {} },
        },
        endNode,
      ],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'sub-b' },
        { id: 'e2', source: 'sub-b', sourceHandle: 'next', target: 'end-1' },
      ],
    };
    await expect(saveWorkflow(b)).rejects.toThrow(/cycle/i);
  });

  it('accepts nested subworkflows when there is no cycle', async () => {
    const leaf: Workflow = {
      id: 'leaf',
      name: 'leaf',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [startNode, endNode],
      edges: [{ id: 'e', source: 'start-1', sourceHandle: 'next', target: 'end-1' }],
    };
    const middle: Workflow = {
      id: 'middle',
      name: 'middle',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        startNode,
        {
          id: 'sub',
          type: 'subworkflow',
          position: { x: 0, y: 0 },
          config: { workflowId: 'leaf', inputs: {}, outputs: {} },
        },
        endNode,
      ],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'sub' },
        { id: 'e2', source: 'sub', sourceHandle: 'next', target: 'end-1' },
      ],
    };
    const root: Workflow = {
      id: 'root',
      name: 'root',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        startNode,
        {
          id: 'sub',
          type: 'subworkflow',
          position: { x: 0, y: 0 },
          config: { workflowId: 'middle', inputs: {}, outputs: {} },
        },
        endNode,
      ],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'sub' },
        { id: 'e2', source: 'sub', sourceHandle: 'next', target: 'end-1' },
      ],
    };
    await saveWorkflow(leaf);
    await saveWorkflow(middle);
    // Should not throw — three-level chain with no back edges.
    await expect(saveWorkflow(root)).resolves.toBeDefined();
  });

  it('emits events with namespaced node ids while running a subworkflow', async () => {
    const child: Workflow = {
      id: 'ns-child',
      name: 'ns-child',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        startNode,
        {
          id: 'agent-c',
          type: 'agent',
          position: { x: 0, y: 0 },
          config: { providerId: 'x', prompt: 'p', cwd: '/tmp', timeoutMs: 1 },
        },
        endNode,
      ],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'agent-c' },
        { id: 'e2', source: 'agent-c', sourceHandle: 'next', target: 'end-1' },
      ],
    };
    await saveWorkflow(child);
    const parent: Workflow = {
      id: 'ns-parent',
      name: 'ns-parent',
      version: 1,
      createdAt: 0,
      updatedAt: 0,
      nodes: [
        startNode,
        {
          id: 'sub-1',
          type: 'subworkflow',
          position: { x: 0, y: 0 },
          config: { workflowId: 'ns-child', inputs: {}, outputs: {} },
        },
        endNode,
      ],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'sub-1' },
        { id: 'e2', source: 'sub-1', sourceHandle: 'next', target: 'end-1' },
      ],
    };
    const eng = new WorkflowEngine(
      baseExecutors({
        agent: constExec('next', { stdout: 'ok' }),
      }),
    );
    const { events } = captureEvents();
    await eng.start(parent);
    // Child agent's events should be namespaced under "sub-1/agent-c".
    const childAgentEvents = events.filter(
      (e): e is Extract<WorkflowEvent, { nodeId: string }> =>
        'nodeId' in e && (e as { nodeId: string }).nodeId === 'sub-1/agent-c',
    );
    expect(childAgentEvents.length).toBeGreaterThan(0);
  });
});
