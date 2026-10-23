/** Outbound webhook acceptance against the production server and real browser. */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { API_TOKEN, DEFAULT_WORKFLOW_ID, REPO_ROOT, TMP_DIR, serverEnv } from './lib/env';
import { waitForExit, waitForHealth, type ServerHandle } from './lib/server';
import type { RunRecord, Workflow } from '../../lib/shared/workflow';
const PORT = 3463;
const AUTH = { Authorization: `Bearer ${API_TOKEN}`, 'content-type': 'application/json' };
test('browser configures webhook; reached execution, redacted results, retries and restart are observable', async ({ page }, info) => {
  test.setTimeout(120_000);
  const root = path.join(TMP_DIR, `send-webhook-${info.retry}`), data = path.join(root, 'data');
  for (const sub of ['workflows', 'runs', 'triggers', 'audit']) mkdirSync(path.join(data, sub), { recursive: true });
  mkdirSync(path.join(root, 'providers'), { recursive: true });
  const fixture = path.join(root, 'fixture.json'), requestLog = path.join(root, 'requests.jsonl');
  writeFileSync(fixture, JSON.stringify({ statusCode: 201, delayMs: 700 })); writeFileSync(requestLog, '');
  const workflow: Workflow = { id: DEFAULT_WORKFLOW_ID, name: 'Send webhook acceptance', version: 1, createdAt: 1, updatedAt: 1, nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 }, config: {} },
    { id: 'source', type: 'script', position: { x: 200, y: 0 }, config: { language: 'ts', code: 'function run() { return { message: \'quote " and {{literal}}\' }; }', outputs: ['message'], timeoutMs: 5000 } },
    { id: 'send', type: 'send-webhook', position: { x: 460, y: 0 }, config: { url: 'https://webhook-fixture.test/send?event=private-query', method: 'POST', body: '{}', timeoutMs: 10000 } },
    { id: 'ok', type: 'end', position: { x: 780, y: -100 }, config: {} },
    { id: 'failed', type: 'end', position: { x: 780, y: 100 }, config: { outcome: 'failed' } },
  ], edges: [
    { id: 'a', source: 'start', target: 'source', sourceHandle: 'next' },
    { id: 'b', source: 'source', target: 'send', sourceHandle: 'next' },
    { id: 'c', source: 'send', target: 'ok', sourceHandle: 'success' },
    { id: 'd', source: 'send', target: 'failed', sourceHandle: 'failure' },
  ] };
  writeFileSync(path.join(data, 'workflows', `${DEFAULT_WORKFLOW_ID}.json`), JSON.stringify(workflow));
  const servers: ServerHandle[] = [];
  const boot = async () => {
    const proc = spawn('bun', ['--preload', './lib/server/async-local-storage-global.ts', '--preload', './tests/e2e/fixtures/send-webhook-preload.ts', 'server.ts'], { cwd: REPO_ROOT, env: { ...process.env, ...serverEnv({ PORT: String(PORT), INFLOOP_DATA_DIR: data, INFLOOP_RUNS_DIR: path.join(data, 'runs'), INFLOOP_PROVIDERS_DIR: path.join(root, 'providers'), INFLOOP_E2E_WEBHOOK_FIXTURE: fixture, INFLOOP_E2E_WEBHOOK_REQUESTS: requestLog, INFLOOP_WEBHOOK_SECRET_E2E: 'synthetic-webhook-e2e-secret' }) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-12000); }; proc.stdout?.on('data', capture); proc.stderr?.on('data', capture);
    const server = { proc, port: PORT, baseUrl: `http://127.0.0.1:${PORT}`, output: () => output }; servers.push(server); await waitForHealth(server); return server;
  };
  let server = await boot();
  const api = (route: string, init: RequestInit = {}) => fetch(`${server.baseUrl}${route}`, { ...init, headers: AUTH });
  const requests = () => readFileSync(requestLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const start = async () => { const response = await api('/api/run', { method: 'POST', body: JSON.stringify({ workflowId: DEFAULT_WORKFLOW_ID }) }); expect(response.status).toBe(202); return (await response.json() as { runId: string }).runId; };
  const readRun = async (runId: string) => (await (await api(`/api/runs/${DEFAULT_WORKFLOW_ID}/${runId}`)).json() as { run: RunRecord }).run;
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    expect((await page.request.post(`${server.baseUrl}/api/auth`, { data: { token: API_TOKEN } })).status()).toBe(200);
    await page.goto(server.baseUrl);
    const card = page.locator('[data-id="send"]'); await expect(card).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole('button', { name: 'add send-webhook node' })).toBeVisible();
    await card.click();
    await page.getByRole('textbox', { name: 'Webhook JSON body' }).fill('{"message":"{{source.message}}"}');
    await page.getByRole('textbox', { name: 'Webhook headers' }).fill('{"X-Event":"acceptance"}');
    await page.getByRole('button', { name: 'Webhook authentication', exact: true }).click();
    await page.getByRole('option', { name: 'Bearer token reference' }).click();
    await page.getByRole('textbox', { name: 'Webhook secret reference' }).fill('E2E');
    await expect.poll(async () => {
      const saved = await (await api(`/api/workflows/${DEFAULT_WORKFLOW_ID}`)).json() as { workflow: Workflow };
      return (saved.workflow.nodes.find(node => node.id === 'send')?.config as { auth?: { secretRef: string } }).auth?.secretRef;
    }).toBe('E2E');
    await page.screenshot({ path: info.outputPath('send-webhook.png'), fullPage: true });
    expect(requests()).toHaveLength(0);
    const runId = await start();
    await expect(card).toContainText('RUNNING');
    await expect.poll(async () => (await readRun(runId)).status).toBe('succeeded');
    await expect(card).toContainText('SUCCEEDED'); await expect(card).toContainText('HTTP 201');
    const result = await readRun(runId);
    expect(requests()).toHaveLength(1); expect(JSON.parse(requests()[0].body)).toEqual({ message: 'quote " and {{literal}}' });
    expect(requests()[0].headers.authorization).toBe('Bearer synthetic-webhook-e2e-secret');
    expect(JSON.stringify(result)).not.toContain('synthetic-webhook-e2e-secret');
    expect(JSON.stringify(result)).not.toContain('private-fixture-cookie');
    expect(result.scope.send.statusCode).toBe(201); expect(result.scope.send.responseBody).toContain('[REDACTED]');
    await page.reload(); await expect(card).toBeVisible(); await card.click();
    await expect(page.getByRole('region', { name: 'Webhook results' })).toContainText('SUCCEEDED');
    expect(await page.content()).not.toContain('synthetic-webhook-e2e-secret');

    const saved = (await (await api(`/api/workflows/${DEFAULT_WORKFLOW_ID}`)).json() as { workflow: Workflow }).workflow;
    Object.assign(saved.nodes.find(node => node.id === 'send')!.config, { maxAttempts: 2, retryDelayMs: 0, idempotencyKey: 'fixture-event-1' });
    expect((await api(`/api/workflows/${DEFAULT_WORKFLOW_ID}`, { method: 'PUT', body: JSON.stringify(saved) })).status).toBe(200);
    writeFileSync(fixture, JSON.stringify({ statusCode: 503, delayMs: 20 }));
    const failed = await start(); await expect.poll(async () => (await readRun(failed)).status).toBe('failed');
    expect((await readRun(failed)).scope.send.attempts).toHaveLength(2); expect(requests()).toHaveLength(3);

    writeFileSync(fixture, JSON.stringify({ statusCode: 201, delayMs: 30000 }));
    const interrupted = await start(); await expect.poll(() => requests().length).toBe(4);
    server.proc.kill('SIGKILL'); await waitForExit(server.proc);
    server = await boot();
    await expect.poll(async () => (await readRun(interrupted)).status).toBe('failed');
    const recovered = await readRun(interrupted);
    expect(recovered.scope.send.errorCategory).toBe('interrupted'); expect(recovered.scope.send.attempts).toHaveLength(1); expect(requests()).toHaveLength(4);
  } finally {
    for (const handle of servers) {
      if (handle.proc.exitCode !== null || handle.proc.signalCode !== null) continue;
      handle.proc.kill('SIGTERM'); try { await waitForExit(handle.proc, 10000); } catch { handle.proc.kill('SIGKILL'); await waitForExit(handle.proc); }
    }
  }
});
