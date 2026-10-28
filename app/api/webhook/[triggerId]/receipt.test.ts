import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { POST } from './route';
import { getWebhookReceipt } from '@/lib/server/webhook-receipt-store';
import { triggerIndex } from '@/lib/server/trigger-index';
import { saveTrigger } from '@/lib/server/trigger-store';

let dir: string;
let previousDir: string | undefined;
let previousWorkflows: string | undefined;
let previousTriggers: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'infloop-receipt-ingress-'));
  previousDir = process.env.INFLOOP_DATA_DIR;
  previousWorkflows = process.env.INFLOOP_WORKFLOWS_DIR;
  previousTriggers = process.env.INFLOOP_TRIGGERS_DIR;
  process.env.INFLOOP_DATA_DIR = dir;
  delete process.env.INFLOOP_WORKFLOWS_DIR;
  delete process.env.INFLOOP_TRIGGERS_DIR;
  triggerIndex.invalidate();
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.INFLOOP_DATA_DIR;
  else process.env.INFLOOP_DATA_DIR = previousDir;
  if (previousWorkflows === undefined) delete process.env.INFLOOP_WORKFLOWS_DIR;
  else process.env.INFLOOP_WORKFLOWS_DIR = previousWorkflows;
  if (previousTriggers === undefined) delete process.env.INFLOOP_TRIGGERS_DIR;
  else process.env.INFLOOP_TRIGGERS_DIR = previousTriggers;
  triggerIndex.invalidate();
  rmSync(dir, { recursive: true, force: true });
});

async function post(triggerId: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return POST(new Request(`http://localhost/api/webhook/${triggerId}`, {
    method: 'POST', body,
    headers: { 'content-type': 'application/json', ...headers },
  }), { params: Promise.resolve({ triggerId }) });
}

test('unknown trigger receipts preserve body and sender claim', async () => {
  const response = await post('unknown-trigger', '{"sender":{"login":"alice"},"message":"hello"}');
  expect(response.status).toBe(404);
  const id = response.headers.get('x-correlation-id');
  expect(id).toBeTruthy();
  const item = getWebhookReceipt(id!);
  expect(item).toMatchObject({
    triggerId: 'unknown-trigger', source: 'Unknown', sender: 'alice',
    state: 'rejected', httpStatus: 404, reason: 'not-found',
    body: '{"sender":{"login":"alice"},"message":"hello"}',
  });
  const plainSender = await post('unknown-trigger', '{"sender":"carol"}');
  expect(getWebhookReceipt(plainSender.headers.get('x-correlation-id')!)?.sender).toBe('carol');
});

test('oversized delivery is rejected while retaining only the bounded prefix', async () => {
  const response = await post('unknown-trigger', 'x'.repeat(1024 * 1024 + 1));
  expect(response.status).toBe(413);
  const item = getWebhookReceipt(response.headers.get('x-correlation-id')!);
  expect(item?.body.length).toBe(1024 * 1024);
  expect(item?.bodyTruncated).toBe(true);
  expect(item?.state).toBe('rejected');
});

test('known plugin receipt shows source and sender even for ignored event', async () => {
  const workflows = path.join(dir, 'workflows');
  mkdirSync(workflows);
  writeFileSync(path.join(workflows, 'wf.json'), JSON.stringify({
    id: 'wf', name: 'Receipt target', version: 1, createdAt: 0, updatedAt: 0,
    nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} }],
    edges: [], inputs: [],
  }));
  const triggerId = 'receiptTestTriggerAAAAAA';
  await saveTrigger({
    id: triggerId, name: 'GitHub issues', enabled: true,
    workflowId: 'wf', pluginId: 'github', eventType: 'issues', match: [], inputs: {},
  });
  const response = await post(triggerId, '{"sender":{"login":"bob"}}', { 'x-github-event': 'push' });
  expect(response.status).toBe(204);
  expect(getWebhookReceipt(response.headers.get('x-correlation-id')!)).toMatchObject({
    source: 'GitHub', sender: 'bob', triggerName: 'GitHub issues',
    workflowId: 'wf', state: 'ignored', httpStatus: 204,
    reason: 'event-header-mismatch',
  });

  const frogoId = 'receiptTestFrogoAAAAAAA';
  await saveTrigger({
    id: frogoId, name: 'Frogo tasks', enabled: true,
    workflowId: 'wf', pluginId: 'frogo', eventType: 'task.created',
    match: [], inputs: {}, verifyOptional: true,
  });
  const frogo = await post(frogoId, '{"payload":{"task":{"createdBy":"carol"}}}', {
    'x-frogo-event': 'ping',
  });
  expect(frogo.status).toBe(204);
  expect(getWebhookReceipt(frogo.headers.get('x-correlation-id')!)).toMatchObject({
    source: 'Frogo', sender: 'carol', state: 'ignored',
  });
});

test('webhook does not proceed when its initial receipt cannot be stored', async () => {
  const blocked = path.join(dir, 'not-a-directory');
  writeFileSync(blocked, 'x');
  process.env.INFLOOP_DATA_DIR = blocked;
  const response = await post('unknown-trigger', '{}');
  expect(response.status).toBe(503);
  expect((await response.json()).error).toBe('receipt-unavailable');
  expect(response.headers.get('x-correlation-id')).toBeTruthy();
});
