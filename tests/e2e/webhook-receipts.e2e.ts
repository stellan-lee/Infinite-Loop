/*
 * Black-box Dispatch receipt checks against the real production server.
 * A Manual node keeps the webhook run active until this test submits a
 * decision, so the running state is observable without a provider call.
 */
import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { API_TOKEN } from './lib/env';

const authed = { Authorization: `Bearer ${API_TOKEN}` };

interface Receipt {
  id: string;
  triggerId: string;
  source: string;
  sender?: string;
  workflowId?: string;
  workflowName?: string;
  state: string;
  body: string;
  httpStatus?: number;
  runId?: string;
  result?: Record<string, Record<string, unknown>>;
}

async function readReceipt(request: APIRequestContext, id: string): Promise<Receipt> {
  const response = await request.get(`/api/webhook-receipts/${encodeURIComponent(id)}`, { headers: authed });
  expect(response.ok()).toBeTruthy();
  const data = await response.json() as { receipt: Receipt };
  return data.receipt;
}

async function createManualWorkflow(request: APIRequestContext): Promise<string> {
  const id = `receipt-e2e-${randomBytes(6).toString('hex')}`;
  const response = await request.post('/api/workflows', {
    headers: authed,
    data: {
      id,
      name: 'Receipt E2E manual review',
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      nodes: [
        { id: 'start-1', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'manual-1', type: 'manual', position: { x: 260, y: 0 },
          config: { brief: 'Review the webhook receipt', decisions: [{ key: 'accepted' }] },
        },
        { id: 'end-1', type: 'end', position: { x: 520, y: 0 }, config: { outcome: 'succeeded' } },
      ],
      edges: [
        { id: 'e-start-manual', source: 'start-1', sourceHandle: 'next', target: 'manual-1' },
        { id: 'e-manual-end', source: 'manual-1', sourceHandle: 'accepted', target: 'end-1' },
      ],
      inputs: [],
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return id;
}

async function createGitHubTrigger(request: APIRequestContext, workflowId: string): Promise<string> {
  const response = await request.post('/api/triggers', {
    headers: authed,
    data: {
      name: 'Receipt E2E GitHub issue',
      enabled: true,
      workflowId,
      pluginId: 'github',
      eventType: 'issues',
      match: [{ lhs: '{{body.action}}', op: '==', rhs: 'opened' }],
      inputs: {},
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const data = await response.json() as { trigger: { id: string } };
  return data.trigger.id;
}

test('Dispatch shows the received body and sender while a workflow runs, then its result', async ({ page, request }) => {
  const workflowId = await createManualWorkflow(request);
  const triggerId = await createGitHubTrigger(request, workflowId);
  const payload = {
    action: 'opened',
    issue: { number: 17, title: 'trace-e2e receipt' },
    sender: { login: 'alice' },
  };

  const delivery = await request.post(`/api/webhook/${triggerId}`, {
    headers: { 'content-type': 'application/json', 'x-github-event': 'issues' },
    data: payload,
  });
  expect(delivery.status()).toBe(202);
  const accepted = await delivery.json() as { correlationId: string };
  expect(accepted.correlationId).toBeTruthy();

  await expect.poll(async () => (await readReceipt(request, accepted.correlationId)).state).toBe('running');
  const running = await readReceipt(request, accepted.correlationId);
  expect(running.triggerId).toBe(triggerId);
  expect(running.workflowId).toBe(workflowId);
  expect(running.workflowName).toBe('Receipt E2E manual review');
  expect(running.source).toBe('GitHub');
  expect(running.sender).toBe('alice');
  expect(running.httpStatus).toBe(202);
  expect(JSON.parse(running.body)).toEqual(payload);
  expect(running.runId).toBeTruthy();
  expect(running.result).toBeUndefined();

  await page.request.post('/api/auth', { data: { token: API_TOKEN } });
  await page.goto('/#dispatch');
  await page.getByRole('tab', { name: 'Messages' }).click();
  const list = page.getByRole('region', { name: 'Received webhook messages' });
  const message = list.getByRole('button', { name: /GitHub · alice/ });
  await expect(message).toContainText('Running');
  await message.click();
  const detail = page.getByRole('region', { name: 'Webhook message details' });
  await expect(detail).toContainText('trace-e2e receipt');
  await expect(detail).toContainText('Workflow running');
  await expect(detail.getByRole('heading', { name: 'Workflow result' })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('receipt-running.png'), fullPage: true });

  const decision = await request.post(`/api/runs/${workflowId}/${running.runId}/decision`, {
    headers: authed,
    data: { nodeId: 'manual-1', decision: 'accepted', comment: 'Approved in receipt E2E' },
  });
  expect(decision.status(), await decision.text()).toBe(200);

  await expect.poll(async () => (await readReceipt(request, accepted.correlationId)).state).toBe('succeeded');
  const finished = await readReceipt(request, accepted.correlationId);
  expect(finished.result?.['manual-1']?.decision).toBe('accepted');
  expect(finished.result?.['manual-1']?.comment).toBe('Approved in receipt E2E');
  await expect(message).toContainText('Succeeded', { timeout: 15_000 });
  await expect(detail).toContainText('Approved in receipt E2E', { timeout: 15_000 });
  await expect(detail.getByRole('heading', { name: 'Workflow result' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('receipt-result.png'), fullPage: true });
});

test('Dispatch records unknown and ignored deliveries and protects receipt history', async ({ request }) => {
  const anonymousList = await request.get('/api/webhook-receipts');
  expect(anonymousList.status()).toBe(401);

  const unknownPayload = { sender: { login: 'nobody' }, probe: 'unknown-receipt-e2e' };
  const unknown = await request.post(`/api/webhook/missing-${randomBytes(8).toString('hex')}`, {
    headers: { 'content-type': 'application/json' },
    data: unknownPayload,
  });
  expect(unknown.status()).toBe(404);
  const unknownId = unknown.headers()['x-correlation-id'];
  expect(unknownId).toBeTruthy();
  const unknownReceipt = await readReceipt(request, unknownId);
  expect(unknownReceipt.state).toBe('rejected');
  expect(unknownReceipt.httpStatus).toBe(404);
  expect(JSON.parse(unknownReceipt.body)).toEqual(unknownPayload);

  const workflowId = await createManualWorkflow(request);
  const triggerId = await createGitHubTrigger(request, workflowId);
  const ignoredPayload = { action: 'opened', sender: { login: 'bob' }, probe: 'ignored-receipt-e2e' };
  const ignored = await request.post(`/api/webhook/${triggerId}`, {
    headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
    data: ignoredPayload,
  });
  expect(ignored.status()).toBe(204);
  const ignoredId = ignored.headers()['x-correlation-id'];
  expect(ignoredId).toBeTruthy();
  const ignoredReceipt = await readReceipt(request, ignoredId);
  expect(ignoredReceipt.state).toBe('ignored');
  expect(ignoredReceipt.source).toBe('GitHub');
  expect(ignoredReceipt.sender).toBe('bob');
  expect(ignoredReceipt.workflowId).toBe(workflowId);
  expect(JSON.parse(ignoredReceipt.body)).toEqual(ignoredPayload);

  const list = await request.get(`/api/webhook-receipts?triggerId=${encodeURIComponent(triggerId)}`, { headers: authed });
  expect(list.ok()).toBeTruthy();
  const listed = await list.json() as { receipts: Array<{ id: string; state: string }> };
  expect(listed.receipts).toContainEqual(expect.objectContaining({ id: ignoredId, state: 'ignored' }));
});
