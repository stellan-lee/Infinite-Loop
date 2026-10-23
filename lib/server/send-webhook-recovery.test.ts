import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkflowEngine } from './workflow-engine';
import { nodeExecutors } from './nodes';
import * as transport from './webhook-transport';
import * as durable from './durable-run';
import { flushAudit } from './audit-log';
import { saveWorkflow } from './workflow-store';
import type { Workflow, WorkflowNode } from '../shared/workflow';

const node = (id: string, type: WorkflowNode['type'], config = {}): WorkflowNode => ({ id, type, config, position: { x: 0, y: 0 } });
const edge = (source: string, target: string, sourceHandle: 'next' | 'success' | 'failure' = 'next') => ({ id: `${source}-${target}`, source, target, sourceHandle });
const workflow = (): Workflow => ({ id: 'webhook-recovery', name: 'Webhook recovery', version: 1, createdAt: 1, updatedAt: 1,
  nodes: [node('start', 'start'), node('send', 'send-webhook', { url: 'https://example.com/secret-path?event=private-query', method: 'POST', body: '{"message":"hello"}' }), node('ok', 'end'), node('bad', 'end', { outcome: 'failed' })],
  edges: [edge('start', 'send'), edge('send', 'ok', 'success'), edge('send', 'bad', 'failure')],
});
let directory: string; let previous: Record<string, string | undefined>;
let request: ReturnType<typeof spyOn<typeof transport, 'sendWebhookRequest'>>;
const engines: WorkflowEngine[] = [];
beforeEach(async () => {
  await flushAudit(); directory = mkdtempSync(path.join(os.tmpdir(), 'webhook-recovery-'));
  previous = Object.fromEntries(['INFLOOP_DATA_DIR', 'INFLOOP_RUNS_DIR', 'INFLOOP_WORKFLOWS_DIR'].map(key => [key, process.env[key]]));
  process.env.INFLOOP_DATA_DIR = directory; process.env.INFLOOP_RUNS_DIR = path.join(directory, 'runs'); process.env.INFLOOP_WORKFLOWS_DIR = path.join(directory, 'workflows');
  request = spyOn(transport, 'sendWebhookRequest').mockResolvedValue({ statusCode: 204, headers: {}, body: '', truncated: false });
});
afterEach(async () => {
  engines.forEach(engine => engine.stop());
  for (let i = 0; i < 100 && engines.some(engine => engine.list().length); i++) await Bun.sleep(2);
  engines.length = 0; await flushAudit(); request.mockRestore();
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(directory, { recursive: true, force: true });
});
const engine = () => { const value = new WorkflowEngine(nodeExecutors); engines.push(value); return value; };
test('actual controller persists executing frame and attempt before send and routes success', async () => {
  request.mockImplementation(async () => {
    const saved = durable.listDurableRuns()[0];
    expect(saved.root.phase).toBe('executing'); expect(saved.root.currentNodeId).toBe('send');
    expect(saved.scopes[saved.root.scopeId].send.attempts).toHaveLength(1);
    return { statusCode: 201, body: '{"accepted":true}', headers: {}, truncated: false };
  });
  const value = engine(); await value.startRun(workflow()).completion;
  expect(value.getState().status).toBe('succeeded'); expect(value.getState().scope.send.statusCode).toBe(201);
  const event = value.getState().events?.find(item => item.type === 'node_started' && item.nodeId === 'send');
  expect(JSON.stringify(event)).not.toContain('secret-path'); expect(JSON.stringify(event)).not.toContain('private-query'); expect(JSON.stringify(event)).not.toContain('message');
});
test('unreached node is inert and reached HTTP failure follows failure edge', async () => {
  const wf = workflow(); wf.edges = [edge('start', 'ok')];
  await engine().startRun(wf).completion; expect(request).not.toHaveBeenCalled();
  request.mockResolvedValue({ statusCode: 500, body: 'failed', headers: {}, truncated: false });
  const value = engine(); await value.startRun(workflow()).completion;
  expect(value.getState().status).toBe('failed'); expect(value.getState().events?.some(event => event.type === 'node_started' && event.nodeId === 'bad')).toBe(true);
});
test('restart preserves attempt evidence and fails uncertain delivery without replay', async () => {
  let saved: durable.DurableRun | undefined;
  request.mockImplementation(async (_url, _method, _headers, _body, signal) => {
    saved = durable.listDurableRuns()[0];
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('fixture abort')), { once: true }));
  });
  const first = engine(); const run = first.startRun(workflow());
  for (let i = 0; i < 100 && !saved; i++) await Bun.sleep(2);
  expect(saved).toBeDefined(); first.stop(); await run.completion;
  const restored = engine(); await restored.startRun(workflow(), { restored: saved! }).completion;
  expect(request).toHaveBeenCalledTimes(1); expect(restored.getState().status).toBe('failed');
  expect(restored.getState().scope.send).toMatchObject({ status: 'FAILED', errorCategory: 'interrupted' });
  expect(restored.getState().scope.send.attempts).toHaveLength(1);
  expect(restored.getState().events?.some(event => event.type === 'node_started' && event.nodeId === 'bad')).toBe(true);
});
test('completed result checkpoint resumes continuation without another HTTP request', async () => {
  let saved: durable.DurableRun | undefined;
  const native = durable.saveDurableRun;
  const persist = spyOn(durable, 'saveDurableRun').mockImplementation(record => { native(record); if (record.root.currentNodeId === 'send' && record.root.phase === 'result') saved = structuredClone(record); });
  try {
    await engine().startRun(workflow()).completion; expect(saved).toBeDefined();
    const restored = engine(); await restored.startRun(workflow(), { restored: saved! }).completion;
    expect(restored.getState().status).toBe('succeeded'); expect(request).toHaveBeenCalledTimes(1);
  } finally { persist.mockRestore(); }
});
test('Stop wins over failure routing and missing template returns structured failure', async () => {
  request.mockImplementation(async (_url, _method, _headers, _body, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('fixture abort')), { once: true })));
  const value = engine(); const run = value.startRun(workflow());
  for (let i = 0; i < 100 && !request.mock.calls.length; i++) await Bun.sleep(2);
  value.stop(); await run.completion;
  expect(value.getState().status).toBe('cancelled'); expect(value.getState().scope.send.status).toBe('CANCELLED');
  expect(value.getState().events?.some(event => event.type === 'node_started' && event.nodeId === 'bad')).toBe(false);
  const wf = workflow(); (wf.nodes[1].config as { body: string }).body = '{"value":"{{missing.value}}"}';
  const missing = engine(); await missing.startRun(wf).completion;
  expect(missing.getState().scope.send).toMatchObject({ status: 'FAILED', errorCategory: 'unresolved_template' });
  expect(missing.getState().status).toBe('failed');
});
test('workflow persistence recursively rejects plaintext auth in nested webhook nodes', async () => {
  const wf = workflow();
  const child = node('unsafe', 'send-webhook', { url: 'https://example.com', method: 'POST', headers: { Authorization: 'plaintext' } });
  wf.nodes = [node('start', 'start'), { ...node('loop', 'loop', { maxIterations: 1, mode: 'unbounded' }), children: [child] }];
  wf.edges = [edge('start', 'loop')];
  await expect(saveWorkflow(wf)).rejects.toThrow('authentication reference');
});
