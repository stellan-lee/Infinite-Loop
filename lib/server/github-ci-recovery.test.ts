import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowEngine } from './workflow-engine';
import { nodeExecutors } from './nodes';
import { GitHubCIClient, aggregateCI } from './github-ci-client';
import { githubCIService } from './github-ci-service';
import { flushAudit } from './audit-log';
import { listDurableRuns, type DurableRun } from './durable-run';
import type { GitHubCIConfig, GitHubCIOutput } from '../shared/github-ci';
import type { Workflow, WorkflowNode, NodeExecutor, EdgeHandle } from '../shared/workflow';

const config: GitHubCIConfig = { repository: 'owner/repo', pullRequest: '2', required: [{ kind: 'check', name: 'test' }], timeoutMs: 60_000 };
const node = (id: string, type: WorkflowNode['type'], cfg = {}): WorkflowNode => ({ id, type, position: { x: 0, y: 0 }, config: cfg });
const edge = (source: string, target: string, sourceHandle: EdgeHandle = 'next') => ({ id: `${source}-${target}`, source, target, sourceHandle });
const wf = (nodes: WorkflowNode[], edges: Workflow['edges']): Workflow => ({ id: 'ci-recovery', name: 'CI recovery', version: 1, createdAt: 1, updatedAt: 1, nodes, edges });
let directory: string;
let oldData: string | undefined, oldRuns: string | undefined, oldSecret: string | undefined;
let clientSpy: ReturnType<typeof spyOn<GitHubCIClient, 'reconcile'>>;
let output: GitHubCIOutput;
const engines: WorkflowEngine[] = [];
beforeEach(async () => {
  await flushAudit();
  oldData = process.env.INFLOOP_DATA_DIR; oldRuns = process.env.INFLOOP_RUNS_DIR; oldSecret = process.env.INFLOOP_GITHUB_WEBHOOK_SECRET;
  directory = mkdtempSync(path.join(os.tmpdir(), 'ci-recovery-'));
  process.env.INFLOOP_DATA_DIR = directory; process.env.INFLOOP_RUNS_DIR = path.join(directory, 'runs'); process.env.INFLOOP_GITHUB_WEBHOOK_SECRET = 'test-local-secret';
  output = aggregateCI(config, 'a'.repeat(40), []);
  clientSpy = spyOn(GitHubCIClient.prototype, 'reconcile').mockImplementation(async () => structuredClone(output));
});
afterEach(async () => {
  for (const engine of engines) engine.stop();
  for (let i = 0; i < 200 && engines.some(e => e.list().length); i++) await new Promise(resolve => setTimeout(resolve, 2));
  engines.length = 0;
  await githubCIService.reconcile();
  await flushAudit();
  clientSpy.mockRestore();
  for (const [key, value] of [['INFLOOP_DATA_DIR', oldData], ['INFLOOP_RUNS_DIR', oldRuns], ['INFLOOP_GITHUB_WEBHOOK_SECRET', oldSecret]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});
function engine(executors: Record<string, NodeExecutor> = nodeExecutors, loader?: (id: string) => Promise<Workflow>) {
  const value = new WorkflowEngine(executors, loader, { maxConcurrentRuns: 1 }); engines.push(value); return value;
}
async function checkpoint(predicate: (saved: DurableRun) => boolean = () => true): Promise<DurableRun> {
  for (let i = 0; i < 200; i++) {
    const saved = listDurableRuns()[0];
    if (saved && predicate(saved)) return saved;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('CI continuation did not reach expected wait');
}
function pass() { output = { ...output, status: 'Passed', passed: 1 }; }

test('same run resumes after CI wait without replaying upstream and releases its worker slot', async () => {
  let sideEffects = 0;
  const executors = { ...nodeExecutors, agent: { execute: async () => { sideEffects++; return { outputs: { pullRequest: '2' }, branch: 'next' as const }; } } };
  const workflow = wf([node('start', 'start'), node('create-pr', 'agent'), node('ci', 'github-ci', { ...config, pullRequest: '{{create-pr.pullRequest}}' }), node('end', 'end')], [edge('start', 'create-pr'), edge('create-pr', 'ci'), edge('ci', 'end', 'success')]);
  const first = engine(executors);
  const run = first.startRun(workflow);
  await first.slotPool.acquireForRun({ runId: run.runId, nodeId: 'test-slot-owner' });
  const saved = await checkpoint(s => s.root.phase === 'ci-wait' && Boolean(s.root.ci?.output.headSha));
  expect(first.slotPool.hasSlot(run.runId)).toBe(false);
  expect(saved.scopes[saved.root.scopeId]['create-pr'].pullRequest).toBe('2');
  first.stop(); await run.completion;
  pass();
  const restored = engine(executors);
  const resumed = restored.startRun(workflow, { restored: saved });
  expect(resumed.runId).toBe(run.runId);
  await resumed.completion;
  expect(restored.getState().status).toBe('succeeded');
  expect(sideEffects).toBe(1);
  expect(restored.getState().scope.ci.headSha).toBe(output.headSha);
});

test('restores loop iteration and scope without replaying completed body side effects', async () => {
  let executions = 0, reconciliations = 0;
  clientSpy.mockImplementation(async () => ({ ...output, status: ++reconciliations === 1 ? 'Passed' : output.status }));
  const agent: NodeExecutor = { execute: async () => ({ outputs: { count: ++executions }, branch: 'next' }) };
  const loop = node('loop', 'loop', { maxIterations: 2, mode: 'unbounded' });
  loop.children = [node('agent', 'agent'), node('ci', 'github-ci', config)];
  const workflow = wf([node('start', 'start'), loop, node('end', 'end')], [edge('start', 'loop'), edge('agent', 'ci'), edge('loop', 'end')]);
  const first = engine({ ...nodeExecutors, agent });
  const run = first.startRun(workflow);
  const saved = await checkpoint(s => s.root.loop?.iteration === 2 && s.root.loop.body?.phase === 'ci-wait');
  expect(executions).toBe(2);
  first.stop(); await run.completion;
  pass();
  const restored = engine({ ...nodeExecutors, agent });
  await restored.startRun(workflow, { restored: saved }).completion;
  expect(restored.getState().status).toBe('succeeded');
  expect(executions).toBe(2);
});

test('parallel recovery retains completed siblings and marks interrupted ordinary work failed', async () => {
  let completedCalls = 0, interruptedCalls = 0;
  const agent: NodeExecutor = { execute: async ctx => {
    if (ctx.nodeId === 'done') { completedCalls++; return { outputs: { sideEffect: true }, branch: 'next' }; }
    interruptedCalls++;
    await new Promise<void>((_, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true }));
    return { outputs: {}, branch: 'next' };
  } };
  const parallel = node('parallel', 'parallel', { mode: 'wait-all', onError: 'best-effort' });
  parallel.children = [node('done', 'agent'), node('active', 'agent'), node('ci', 'github-ci', config)];
  const workflow = wf([node('start', 'start'), parallel], [edge('start', 'parallel')]);
  const first = engine({ ...nodeExecutors, agent });
  const run = first.startRun(workflow);
  await first.slotPool.acquireForRun({ runId: run.runId, nodeId: 'test-slot-owner' });
  const saved = await checkpoint(s => Boolean(s.root.parallel?.results.done) && s.root.parallel?.branches.ci.phase === 'ci-wait');
  expect(first.slotPool.hasSlot(run.runId)).toBe(true);
  first.stop(); await run.completion;
  pass();
  const restored = engine({ ...nodeExecutors, agent });
  await restored.startRun(workflow, { restored: saved }).completion;
  expect(restored.getState().status).toBe('failed');
  expect(completedCalls).toBe(1);
  expect(interruptedCalls).toBe(1);
  const children = restored.getState().scope.parallel.children as Record<string, { status: string }>;
  expect(children.done.status).toBe('succeeded');
  expect(children.active.status).toBe('failed');
  expect(children.ci.status).toBe('succeeded');
});

test('subworkflow recovery freezes loaded definition and retains child scope', async () => {
  let executions = 0;
  const agent: NodeExecutor = { execute: async () => ({ outputs: { value: ++executions }, branch: 'next' }) };
  const child = wf([node('start', 'start'), node('agent', 'agent'), node('ci', 'github-ci', config)], [edge('start', 'agent'), edge('agent', 'ci')]);
  child.id = 'child';
  const parent = wf([node('start', 'start'), node('sub', 'subworkflow', { workflowId: 'child', inputs: {}, outputs: { value: 'agent.value' } })], [edge('start', 'sub')]);
  const first = engine({ ...nodeExecutors, agent }, async () => child);
  const run = first.startRun(parent);
  const saved = await checkpoint(s => s.root.subworkflow?.child.phase === 'ci-wait');
  first.stop(); await run.completion;
  pass();
  const restored = engine({ ...nodeExecutors, agent }, async () => { throw new Error('child definition was deleted'); });
  await restored.startRun(parent, { restored: saved }).completion;
  expect(restored.getState().status).toBe('succeeded');
  expect(restored.getState().scope.sub.value).toBe(1);
  expect(executions).toBe(1);
});

test('checkpoint write failure stops progression instead of routing a business failure', async () => {
  let downstream = 0;
  const agent: NodeExecutor = { execute: async () => ({ outputs: { count: ++downstream }, branch: 'next' }) };
  const workflow = wf([node('start', 'start'), node('ci', 'github-ci', config), node('repair', 'agent')], [edge('start', 'ci'), edge('ci', 'repair', 'failure'), edge('ci', 'repair', 'success')]);
  const first = engine({ ...nodeExecutors, agent });
  const run = first.startRun(workflow);
  await checkpoint(s => s.root.phase === 'ci-wait');
  rmSync(path.join(directory, 'durable-runs'), { recursive: true, force: true });
  writeFileSync(path.join(directory, 'durable-runs'), 'disk fault fixture');
  pass();
  await expect(githubCIService.reconcile()).rejects.toThrow('Could not persist workflow continuation');
  await run.completion;
  expect(first.getState().status).toBe('failed');
  expect(downstream).toBe(0);
});

test('a persisted result resumes routing once without executing the settled CI node', async () => {
  let downstream = 0;
  const agent: NodeExecutor = { execute: async () => ({ outputs: { count: ++downstream }, branch: 'next' }) };
  const workflow = wf([node('start', 'start'), node('ci', 'github-ci', config), node('next', 'agent')], [edge('start', 'ci'), edge('ci', 'next', 'success')]);
  const first = engine({ ...nodeExecutors, agent });
  const run = first.startRun(workflow);
  const saved = await checkpoint(s => s.root.phase === 'ci-wait');
  first.stop(); await run.completion;
  saved.root.phase = 'result';
  saved.root.branch = 'success';
  saved.scopes[saved.root.scopeId].ci = { ...output, status: 'Passed' };
  clientSpy.mockImplementation(async () => { throw new Error('settled CI must not fetch again'); });
  const restored = engine({ ...nodeExecutors, agent });
  await restored.startRun(workflow, { restored: saved }).completion;
  expect(restored.getState().status).toBe('succeeded');
  expect(downstream).toBe(1);
});

test('terminal checkpoint wins over an unfinished cursor after a cleanup/history crash', async () => {
  const workflow = wf([node('start', 'start'), node('ci', 'github-ci', config)], [edge('start', 'ci')]);
  const first = engine();
  const run = first.startRun(workflow);
  const saved = await checkpoint(s => s.root.phase === 'ci-wait');
  first.stop(); await run.completion;
  saved.terminal = { status: 'succeeded' };
  clientSpy.mockImplementation(async () => { throw new Error('terminal recovery must not fetch again'); });
  const calls = clientSpy.mock.calls.length;
  const restored = engine();
  await restored.startRun(workflow, { restored: saved }).completion;
  expect(restored.getState().status).toBe('succeeded');
  expect(clientSpy.mock.calls.length).toBe(calls);
  expect(listDurableRuns()).toHaveLength(0);
});

test('a deadline elapsed during restart settles Error even if CI now succeeds', async () => {
  const workflow = wf([node('start', 'start'), node('ci', 'github-ci', config)], [edge('start', 'ci')]);
  const first = engine();
  const run = first.startRun(workflow);
  const saved = await checkpoint(s => s.root.phase === 'ci-wait');
  first.stop(); await run.completion;
  saved.root.ci!.deadline = Date.now() - 100;
  pass();
  const restored = engine();
  await restored.startRun(workflow, { restored: saved }).completion;
  expect(restored.getState().status).toBe('failed');
  expect(restored.getState().scope.ci.status).toBe('Error');
  expect(restored.getState().scope.ci.errorMessage).toContain('timed out');
});

test.each([false, true])('Stop a waiting CI gate is cancelled with a failure edge: %s', async connected => {
  let downstream = 0;
  const agent: NodeExecutor = { execute: async () => ({ outputs: { count: ++downstream }, branch: 'next' }) };
  const workflow = wf([node('start', 'start'), node('ci', 'github-ci', config), node('repair', 'agent')], [
    edge('start', 'ci'),
    ...(connected ? [edge('ci', 'repair', 'failure')] : []),
  ]);
  const first = engine({ ...nodeExecutors, agent });
  const run = first.startRun(workflow);
  await checkpoint(s => s.root.phase === 'ci-wait');
  first.stop();
  await run.completion;
  expect(first.getState().status).toBe('cancelled');
  expect(first.getState().scope.ci.status).toBe('Cancelled');
  expect(downstream).toBe(0);
});

test('parallel output deltas are identical after JSON recovery, including equal-valued writes', async () => {
  const parallel = node('parallel', 'parallel', { mode: 'wait-all', onError: 'best-effort' });
  parallel.children = [node('globals', 'agent'), node('ci-one', 'github-ci', config), node('ci-two', 'github-ci', config)];
  const workflow = wf([node('start', 'start'), node('upstream', 'agent'), parallel], [
    edge('start', 'upstream'), edge('upstream', 'parallel'), edge('globals', 'ci-one'),
  ]);
  workflow.globals = { value: 'same' };
  const agent: NodeExecutor = {
    execute: async ctx => ({ outputs: ctx.nodeId === 'globals' ? { value: 'same' } : { existing: 'parent-only' }, branch: 'next' }),
  };
  const first = engine({ ...nodeExecutors, agent });
  const run = first.startRun(workflow);
  const saved = await checkpoint(s => s.root.parallel?.branches.globals.phase === 'ci-wait' &&
    s.root.parallel?.branches['ci-two'].phase === 'ci-wait');
  pass();
  await githubCIService.reconcile();
  await run.completion;
  const uninterrupted = first.getState().scope.parallel.children;
  const restored = engine({ ...nodeExecutors, agent });
  await restored.startRun(workflow, { restored: saved }).completion;
  expect(restored.getState().scope.parallel.children).toEqual(uninterrupted);
  const children = uninterrupted as Record<string, { outputs: Record<string, unknown> }>;
  expect(Object.keys(children.globals.outputs).sort()).toEqual(['ci-one', 'globals']);
  expect(children.globals.outputs.globals).toEqual({ value: 'same' });
  expect(Object.keys(children['ci-two'].outputs)).toEqual(['ci-two']);
});

test('CI snapshots survive event eviction, retain namespaced gates, and persist for recovery', async () => {
  const parallel = node('parallel', 'parallel', { mode: 'wait-all', onError: 'best-effort' });
  parallel.children = [node('left', 'subworkflow', { workflowId: 'child', inputs: {}, outputs: {} }), node('right', 'subworkflow', { workflowId: 'child', inputs: {}, outputs: {} })];
  const child = wf([node('start', 'start'), node('ci', 'github-ci', config)], [edge('start', 'ci')]);
  child.id = 'child';
  const workflow = wf([node('start', 'start'), parallel], [edge('start', 'parallel')]);
  const first = engine(nodeExecutors, async () => child);
  const run = first.startRun(workflow);
  await checkpoint(s => Boolean(s.snapshot.githubCI?.['left/ci']?.headSha && s.snapshot.githubCI?.['right/ci']?.headSha));
  const controller = first.getRun(run.runId)!;
  for (let i = 0; i < 6000; i++) controller.emit({ type: 'stdout_chunk', nodeId: 'sibling', line: `line ${i}` });
  const snapshot = first.getState();
  expect(snapshot.events?.some(event => event.type === 'github_ci_updated')).toBe(false);
  expect(snapshot.githubCI?.['left/ci']?.headSha).toBe(output.headSha);
  expect(snapshot.githubCI?.['right/ci']?.status).toBe('Pending');
  const saved = await checkpoint();
  expect(saved.snapshot.githubCI?.['left/ci']?.headSha).toBe(output.headSha);
  expect(saved.snapshot.githubCI?.['right/ci']?.status).toBe('Pending');
  first.stop(); await run.completion;
});

test('Stop intent survives checkpoints before and during cancellation publication', async () => {
  const { eventBus } = await import('./event-bus');
  let repairCalls = 0;
  const agent: NodeExecutor = { execute: async () => ({ outputs: { count: ++repairCalls }, branch: 'next' }) };
  const workflow = wf([node('start', 'start'), node('ci', 'github-ci', config), node('repair', 'agent')], [
    edge('start', 'ci'), edge('ci', 'repair', 'failure'),
  ]);
  const first = engine({ ...nodeExecutors, agent });
  const run = first.startRun(workflow);
  let beforeWaiterPublication: DurableRun | undefined;
  // Registered before the walker enters the CI gate, so this observes the
  // Stop checkpoint before the gate's abort listener publishes its result.
  first.getRun(run.runId)!.abort.signal.addEventListener('abort', () => {
    beforeWaiterPublication = listDurableRuns().find(saved => saved.runId === run.runId);
  }, { once: true });
  await checkpoint(saved => Boolean(saved.root.ci?.output.headSha));
  let atPublication: DurableRun | undefined;
  const unsubscribe = eventBus.subscribe(event => {
    if (event.type === 'github_ci_updated' && event.runId === run.runId && event.output.status === 'Cancelled') {
      atPublication = listDurableRuns().find(saved => saved.runId === run.runId);
    }
  });
  first.stop();
  await run.completion;
  unsubscribe();
  expect(first.getState().status).toBe('cancelled');
  expect(repairCalls).toBe(0);
  for (const saved of [beforeWaiterPublication, atPublication]) {
    expect(saved).toBeDefined();
    expect(saved!.terminal).toBeUndefined();
    expect(saved!.cancellation?.reason).toBe('user');
    expect(saved!.root.phase).toBe('ci-wait');
    expect(saved!.snapshot.githubCI?.ci.status).toBe('Cancelled');
    pass();
    const restored = engine({ ...nodeExecutors, agent });
    await restored.startRun(workflow, { restored: saved! }).completion;
    expect(restored.getState().status).toBe('cancelled');
    expect(restored.getState().githubCI?.ci.status).toBe('Cancelled');
    expect(restored.getState().scope.ci.status).toBe('Cancelled');
    expect(repairCalls).toBe(0);
  }
});

test('a GitHub cancelled conclusion still follows the failure branch', async () => {
  let repairCalls = 0;
  const agent: NodeExecutor = { execute: async () => ({ outputs: { count: ++repairCalls }, branch: 'next' }) };
  const workflow = wf([node('start', 'start'), node('ci', 'github-ci', config), node('repair', 'agent')], [
    edge('start', 'ci'), edge('ci', 'repair', 'failure'),
  ]);
  output = { ...output, status: 'Cancelled', failed: ['check:test'] };
  const first = engine({ ...nodeExecutors, agent });
  await first.startRun(workflow).completion;
  expect(first.getState().status).toBe('succeeded');
  expect(first.getState().scope.ci.status).toBe('Cancelled');
  expect(repairCalls).toBe(1);
});

test('budget cancellation intent survives the waiter publication checkpoint', async () => {
  const { eventBus } = await import('./event-bus');
  let releaseSibling!: () => void;
  let downstream = 0;
  const agent: NodeExecutor = {
    execute: async ctx => {
      if (ctx.nodeId === 'costly') {
        await new Promise<void>(resolve => { releaseSibling = resolve; });
        return { outputs: { costUsd: 2 }, branch: 'next' };
      }
      return { outputs: { count: ++downstream }, branch: 'next' };
    },
  };
  const parallel = node('parallel', 'parallel', { mode: 'wait-all', onError: 'best-effort' });
  parallel.children = [node('ci', 'github-ci', config), node('costly', 'agent'), node('repair', 'agent')];
  const workflow = wf([node('start', 'start'), parallel], [edge('start', 'parallel'), edge('ci', 'repair', 'failure')]);
  const first = new WorkflowEngine({ ...nodeExecutors, agent }, undefined, { runBudget: { maxCostUsd: 1 } });
  engines.push(first);
  const run = first.startRun(workflow);
  await checkpoint(saved => saved.root.parallel?.branches.ci.phase === 'ci-wait');
  let saved: DurableRun | undefined;
  const unsubscribe = eventBus.subscribe(event => {
    if (event.type === 'github_ci_updated' && event.runId === run.runId && event.output.status === 'Cancelled') {
      saved = listDurableRuns().find(record => record.runId === run.runId);
    }
  });
  releaseSibling();
  await run.completion;
  unsubscribe();
  expect(first.getState().status).toBe('failed');
  expect(saved?.cancellation?.reason).toBe('budget');
  const restored = engine({ ...nodeExecutors, agent });
  await restored.startRun(workflow, { restored: saved! }).completion;
  expect(restored.getState().status).toBe('failed');
  expect(restored.getState().errorMessage).toBe(saved!.cancellation!.message);
  expect(downstream).toBe(0);
});
