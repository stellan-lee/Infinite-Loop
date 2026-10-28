import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newCorrelationId } from './correlation';
import { EventBus } from './event-bus';
import {
  createWebhookReceipt, getWebhookReceipt, listWebhookReceipts,
  subscribeWebhookReceipts, updateWebhookReceipt,
  reconcileWebhookReceipts,
} from './webhook-receipt-store';
import { saveRun, writeRunMarker } from './run-store';
import { persistQueuedRun } from './queue-store';
import { GET as listGET } from '@/app/api/webhook-receipts/route';
import { GET as detailGET } from '@/app/api/webhook-receipts/[id]/route';
import type { WebhookReceipt } from '../shared/webhook-receipt';

let dir: string;
let previousDir: string | undefined;
let previousToken: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'infloop-receipts-'));
  previousDir = process.env.INFLOOP_DATA_DIR;
  previousToken = process.env.INFLOOP_API_TOKEN;
  process.env.INFLOOP_DATA_DIR = dir;
  delete process.env.INFLOOP_API_TOKEN;
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.INFLOOP_DATA_DIR;
  else process.env.INFLOOP_DATA_DIR = previousDir;
  if (previousToken === undefined) delete process.env.INFLOOP_API_TOKEN;
  else process.env.INFLOOP_API_TOKEN = previousToken;
  rmSync(dir, { recursive: true, force: true });
});

function receipt(overrides: Partial<WebhookReceipt> = {}): WebhookReceipt {
  return {
    id: newCorrelationId(), receivedAt: Date.now(), updatedAt: Date.now(),
    triggerId: 'test-trigger', source: 'GitHub', sender: 'alice',
    workflowId: 'wf', state: 'received', body: '{"sender":{"login":"alice"}}',
    ...overrides,
  };
}

describe('webhook receipt store', () => {
  test('persists full body separately from paginated summaries and filters', () => {
    const first = receipt({ receivedAt: 10 });
    const second = receipt({ receivedAt: 20, workflowId: 'other' });
    const third = receipt({ receivedAt: 30 });
    for (const item of [first, second, third]) createWebhookReceipt(item);
    const page = listWebhookReceipts({ limit: 2 });
    expect(page.receipts.map((r) => r.id)).toEqual([third.id, second.id]);
    expect(page.receipts[0]).not.toHaveProperty('body');
    expect(page.nextCursor).toBe(second.id);
    expect(listWebhookReceipts({ before: page.nextCursor!, limit: 2 }).receipts.map((r) => r.id)).toEqual([first.id]);
    expect(listWebhookReceipts({ workflowId: 'wf' }).receipts.map((r) => r.id)).toEqual([third.id, first.id]);
    expect(getWebhookReceipt(first.id)?.body).toBe(first.body);
  });

  test('equal-time pagination uses one bytewise ID order for pages and cursors', () => {
    const upper = receipt({ id: 'cid_BaXXXXXXXXXXXXXXXXXXXXXX', receivedAt: 100 });
    const lower = receipt({ id: 'cid_aZXXXXXXXXXXXXXXXXXXXXXX', receivedAt: 100 });
    createWebhookReceipt(upper);
    createWebhookReceipt(lower);
    const first = listWebhookReceipts({ limit: 1 });
    expect(first.receipts.map((r) => r.id)).toEqual([lower.id]);
    expect(first.nextCursor).toBe(lower.id);
    expect(listWebhookReceipts({ limit: 1, before: first.nextCursor! }).receipts.map((r) => r.id)).toEqual([upper.id]);
  });

  test('a fast finished run cannot be rolled back by late started or queued events', () => {
    const item = receipt();
    createWebhookReceipt(item);
    const bus = new EventBus();
    const unsubscribe = subscribeWebhookReceipts(bus);
    const scope = { end: { answer: 42 } };
    bus.emit({ type: 'run_finished', correlationId: item.id, runId: 'run-1', status: 'succeeded', scope });
    bus.emit({ type: 'trigger_started', correlationId: item.id, triggerId: item.triggerId, workflowId: 'wf', queueId: 'q-1', runId: 'run-1' });
    bus.emit({ type: 'trigger_enqueued', correlationId: item.id, triggerId: item.triggerId, workflowId: 'wf', queueId: 'q-1', position: 1, receivedAt: item.receivedAt });
    updateWebhookReceipt(item.id, { httpStatus: 202, state: 'queued' });
    const settled = getWebhookReceipt(item.id);
    expect(settled?.state).toBe('succeeded');
    expect(settled?.result).toEqual(scope);
    expect(settled?.runId).toBe('run-1');
    expect(settled?.httpStatus).toBe(202);
    unsubscribe();
  });

  test('queue drop and cancellation have visible terminal states', () => {
    const item = receipt();
    createWebhookReceipt(item);
    const bus = new EventBus();
    const unsubscribe = subscribeWebhookReceipts(bus);
    bus.emit({ type: 'trigger_dropped', correlationId: item.id, triggerId: item.triggerId, queueId: 'rejected', reason: 'queue-full' });
    expect(getWebhookReceipt(item.id)?.state).toBe('rejected');
    expect(getWebhookReceipt(item.id)?.reason).toBe('queue-full');
    unsubscribe();
  });

  test('startup restores a terminal result and repairs a missing list summary', async () => {
    const item = receipt({ state: 'running', runId: 'completed-run' });
    createWebhookReceipt(item);
    unlinkSync(path.join(dir, 'webhook-receipts', 'summaries', `${item.id}.json`));
    await saveRun({
      runId: 'completed-run', workflowId: 'wf', workflowName: 'Workflow',
      status: 'failed', startedAt: 1, finishedAt: 2, durationMs: 1,
      scope: { end: { message: 'partial' } }, events: [],
      errorMessage: 'run interrupted', correlationId: item.id,
    });
    await reconcileWebhookReceipts();
    expect(getWebhookReceipt(item.id)).toMatchObject({
      state: 'failed', runId: 'completed-run', errorMessage: 'run interrupted',
      result: { end: { message: 'partial' } },
    });
    expect(listWebhookReceipts().receipts[0].state).toBe('failed');
  });

  test('startup leaves a persisted queue item queued and closes an abandoned receipt', async () => {
    const queued = receipt({ state: 'received' });
    const abandoned = receipt({ state: 'received' });
    const missingQueue = receipt({ state: 'queued' });
    const missingRun = receipt({ state: 'running', runId: 'lost-run' });
    createWebhookReceipt(queued);
    createWebhookReceipt(abandoned);
    createWebhookReceipt(missingQueue);
    createWebhookReceipt(missingRun);
    persistQueuedRun({
      queueId: 'queued-1', triggerId: queued.triggerId,
      correlationId: queued.id, receivedAt: queued.receivedAt,
      workflow: {
        id: 'wf', name: 'Workflow', version: 1,
        createdAt: 0, updatedAt: 0, nodes: [], edges: [],
      }, resolvedInputs: {},
    });
    await reconcileWebhookReceipts();
    expect(getWebhookReceipt(queued.id)?.state).toBe('queued');
    expect(getWebhookReceipt(abandoned.id)).toMatchObject({
      state: 'rejected', reason: 'interrupted-before-enqueue',
    });
    expect(getWebhookReceipt(missingQueue.id)).toMatchObject({
      state: 'dropped', reason: 'queue-unavailable-after-restart',
    });
    expect(getWebhookReceipt(missingRun.id)).toMatchObject({
      state: 'failed', reason: 'run-unavailable-after-restart',
    });
  });

  test('a surviving queue replay supersedes old failed history and accepts the new result', async () => {
    const old = receipt({ state: 'failed', runId: 'old-run', result: { end: { old: true } }, errorMessage: 'old failure' });
    createWebhookReceipt(old);
    await saveRun({
      runId: 'old-run', workflowId: 'wf', workflowName: 'Workflow',
      status: 'failed', startedAt: 1, finishedAt: 2, durationMs: 1,
      scope: { end: { old: true } }, events: [], errorMessage: 'old failure',
      correlationId: old.id,
    });
    persistQueuedRun({
      queueId: 'replay-queue', triggerId: old.triggerId,
      correlationId: old.id, receivedAt: old.receivedAt,
      workflow: {
        id: 'wf', name: 'Workflow', version: 1,
        createdAt: 0, updatedAt: 0, nodes: [], edges: [],
      }, resolvedInputs: {},
    });
    await reconcileWebhookReceipts();
    expect(getWebhookReceipt(old.id)).toMatchObject({ state: 'queued', queueId: 'replay-queue' });
    expect(getWebhookReceipt(old.id)?.runId).toBeUndefined();
    expect(getWebhookReceipt(old.id)?.result).toBeUndefined();
    expect(getWebhookReceipt(old.id)?.errorMessage).toBeUndefined();

    const bus = new EventBus();
    const unsubscribe = subscribeWebhookReceipts(bus);
    bus.emit({ type: 'run_finished', correlationId: old.id, runId: 'old-run', status: 'failed', scope: { end: { old: true } } });
    expect(getWebhookReceipt(old.id)?.state).toBe('queued');
    bus.emit({ type: 'trigger_started', correlationId: old.id, triggerId: old.triggerId, workflowId: 'wf', queueId: 'replay-queue', runId: 'new-run' });
    expect(getWebhookReceipt(old.id)).toMatchObject({ state: 'running', runId: 'new-run' });
    bus.emit({ type: 'run_finished', correlationId: old.id, runId: 'new-run', status: 'succeeded', scope: { end: { new: true } } });
    expect(getWebhookReceipt(old.id)).toMatchObject({
      state: 'succeeded', runId: 'new-run', result: { end: { new: true } },
    });
    expect(getWebhookReceipt(old.id)?.errorMessage).toBeUndefined();
    unsubscribe();
  });

  test('second restart selects the current retry result over older failed history', async () => {
    const item = receipt({ state: 'running', runId: 'retry-run', supersededRunIds: ['old-run'] });
    createWebhookReceipt(item);
    await saveRun({
      runId: 'old-run', workflowId: 'wf', workflowName: 'Workflow',
      status: 'failed', startedAt: 1, finishedAt: 2, durationMs: 1,
      scope: { end: { old: true } }, events: [], errorMessage: 'old failure',
      correlationId: item.id,
    });
    await saveRun({
      runId: 'retry-run', workflowId: 'wf', workflowName: 'Workflow',
      status: 'succeeded', startedAt: 3, finishedAt: 4, durationMs: 1,
      scope: { end: { new: true } }, events: [], correlationId: item.id,
    });
    await reconcileWebhookReceipts();
    expect(getWebhookReceipt(item.id)).toMatchObject({
      state: 'succeeded', runId: 'retry-run', result: { end: { new: true } },
    });
    expect(listWebhookReceipts().receipts[0].state).toBe('succeeded');
  });

  test('a current active retry outranks superseded completed history', async () => {
    const item = receipt({ state: 'queued', supersededRunIds: ['old-run'] });
    createWebhookReceipt(item);
    await saveRun({
      runId: 'old-run', workflowId: 'wf', workflowName: 'Workflow',
      status: 'failed', startedAt: 1, finishedAt: 2, durationMs: 1,
      scope: { end: { old: true } }, events: [], errorMessage: 'old failure',
      correlationId: item.id,
    });
    writeRunMarker({
      runId: 'retry-run', workflowId: 'wf', workflowName: 'Workflow',
      startedAt: 3, serverPid: process.pid, correlationId: item.id,
    });
    await reconcileWebhookReceipts();
    expect(getWebhookReceipt(item.id)).toMatchObject({ state: 'running', runId: 'retry-run' });
    expect(getWebhookReceipt(item.id)?.result).toBeUndefined();
  });
});

describe('webhook receipt API', () => {
  test('requires authentication and returns summary/detail only to authorized callers', async () => {
    const item = receipt();
    createWebhookReceipt(item);
    process.env.INFLOOP_API_TOKEN = 'receipt-test-token';
    const url = 'http://localhost/api/webhook-receipts';
    expect((await listGET(new Request(url))).status).toBe(401);
    expect((await detailGET(new Request(`${url}/${item.id}`), { params: Promise.resolve({ id: item.id }) })).status).toBe(401);
    const auth = { Authorization: 'Bearer receipt-test-token' };
    const list = await listGET(new Request(url, { headers: auth }));
    expect((await list.json()).receipts[0].id).toBe(item.id);
    const detail = await detailGET(new Request(`${url}/${item.id}`, { headers: auth }), { params: Promise.resolve({ id: item.id }) });
    expect((await detail.json()).receipt.body).toBe(item.body);
    expect((await listGET(new Request(`${url}?limit=1000`, { headers: auth }))).status).toBe(400);
  });
});
