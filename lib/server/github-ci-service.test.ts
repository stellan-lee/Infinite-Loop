import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { GitHubCIClient, aggregateCI } from './github-ci-client';
import { GitHubCIService, githubCIService } from './github-ci-service';
import type { GitHubCIConfig } from '../shared/github-ci';
import { readDurableJSON } from './durable-json';
import { flushAudit } from './audit-log';
import { POST } from '../../app/api/webhook/github-ci/route';

const config: GitHubCIConfig = { repository: 'owner/repo', pullRequest: '1', required: [{ kind: 'check', name: 'test' }], timeoutMs: 1000 };
let directory: string;
let oldDirectory: string | undefined;
let oldSecret: string | undefined;
beforeEach(async () => {
  await flushAudit();
  oldDirectory = process.env.INFLOOP_DATA_DIR;
  oldSecret = process.env.INFLOOP_GITHUB_WEBHOOK_SECRET;
  directory = mkdtempSync(path.join(os.tmpdir(), 'ci-service-'));
  process.env.INFLOOP_DATA_DIR = directory;
  process.env.INFLOOP_GITHUB_WEBHOOK_SECRET = 'local-webhook-secret';
});
afterEach(async () => {
  await flushAudit();
  if (oldDirectory === undefined) delete process.env.INFLOOP_DATA_DIR; else process.env.INFLOOP_DATA_DIR = oldDirectory;
  if (oldSecret === undefined) delete process.env.INFLOOP_GITHUB_WEBHOOK_SECRET; else process.env.INFLOOP_GITHUB_WEBHOOK_SECRET = oldSecret;
  rmSync(directory, { recursive: true, force: true });
});

test('mandatory signature and durable acknowledgment; duplicate delivery id is idempotent', async () => {
  const body = JSON.stringify({ repository: { full_name: 'owner/repo' }, action: 'synchronize' });
  const request = (signature?: string) => new Request('http://localhost/api/webhook/github-ci', { method: 'POST', body, headers: { 'x-github-event': 'pull_request', 'x-github-delivery': 'delivery-1', ...(signature ? { 'x-hub-signature-256': signature } : {}) } });
  expect((await POST(request())).status).toBe(401);
  expect(readDurableJSON('github-ci-inbox')).toHaveLength(0);
  const signed = `sha256=${createHmac('sha256', 'local-webhook-secret').update(body).digest('hex')}`;
  expect((await POST(request(signed))).status).toBe(202);
  expect((await POST(request(signed))).status).toBe(202);
  expect(readDurableJSON('github-ci-inbox')).toHaveLength(1);
  await githubCIService.drainInbox();
  await new Promise(resolve => setImmediate(resolve));
  delete process.env.INFLOOP_GITHUB_WEBHOOK_SECRET;
  expect((await POST(request(signed))).status).toBe(503);
});

test('missed events reconcile to success; late old events only reconcile authoritative state', async () => {
  const client = new GitHubCIClient();
  let output = aggregateCI(config, 'a'.repeat(40), []);
  const reconcile = spyOn(client, 'reconcile').mockImplementation(async () => output);
  const service = new GitHubCIService(client);
  const state = service.create(config);
  const seen: string[] = [];
  const completion = service.wait(state, new AbortController().signal, value => seen.push(value.status));
  await service.reconcile();
  expect(state.output.status).toBe('Pending');
  output = { ...output, status: 'Passed', passed: 1 };
  await service.reconcile();
  expect((await completion).status).toBe('Passed');
  service.accept('old-event', 'check_run', config.repository);
  await service.drainInbox();
  await new Promise(resolve => setImmediate(resolve));
  expect(seen.at(-1)).toBe('Passed');
  reconcile.mockRestore();
});

test('expired, cancelled, and failed checkpoint waits always settle without success', async () => {
  const client = new GitHubCIClient();
  const reconcile = spyOn(client, 'reconcile').mockResolvedValue(aggregateCI(config, '', []));
  const service = new GitHubCIService(client);
  const expired = service.create(config, Date.now() - 1);
  expect((await service.wait(expired, new AbortController().signal, () => {})).status).toBe('Error');
  const abort = new AbortController();
  const cancelled = service.wait(service.create(config), abort.signal, () => {});
  abort.abort();
  expect((await cancelled).status).toBe('Cancelled');
  const failed = service.wait(service.create(config), new AbortController().signal, () => { throw new Error('disk full'); });
  await expect(failed).rejects.toThrow('disk full');
  reconcile.mockRestore();
});
