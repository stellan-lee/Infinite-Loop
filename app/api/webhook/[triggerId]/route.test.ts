import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { POST } from './route';
import { triggerIndex } from '@/lib/server/trigger-index';
import { triggerQueue } from '@/lib/server/trigger-queue-singleton';
import { saveTrigger } from '@/lib/server/trigger-store';
import { pluginIndex } from '@/lib/server/webhook-plugins';
import { listAuditEntries } from '@/lib/server/audit-log';

const tmpWfDir = path.join(os.tmpdir(), `infinite-loop-webhook-wf-${process.pid}`);
const tmpTrDir = path.join(os.tmpdir(), `infinite-loop-webhook-tr-${process.pid}`);
const tmpPluginDir = path.join(os.tmpdir(), `infinite-loop-webhook-plugins-${process.pid}`);

async function writePlugin(name: string, body: unknown) {
  await fs.writeFile(path.join(tmpPluginDir, `${name}.json`), JSON.stringify(body), 'utf8');
}

async function writeWorkflow(id: string, inputs: unknown[] = []) {
  const file = path.join(tmpWfDir, `${id}.json`);
  await fs.writeFile(file, JSON.stringify({
    id, name: id, version: 1, createdAt: 0, updatedAt: 0,
    nodes: [{ id: 's', type: 'start', position: { x: 0, y: 0 }, config: {} }],
    edges: [],
    inputs,
  }));
}

function mkReq(triggerId: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://test/api/webhook/${triggerId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// Path to the bundled built-in plugins shipped with the project.
const builtinPluginsDir = path.resolve(__dirname, '../../../../webhook-plugins');

beforeEach(async () => {
  await fs.rm(tmpWfDir, { recursive: true, force: true });
  await fs.rm(tmpTrDir, { recursive: true, force: true });
  await fs.rm(tmpPluginDir, { recursive: true, force: true });
  await fs.mkdir(tmpWfDir, { recursive: true });
  await fs.mkdir(tmpTrDir, { recursive: true });
  await fs.mkdir(tmpPluginDir, { recursive: true });
  // Seed built-in plugins so pre-existing tests that use pluginId:'github' keep working.
  try {
    for (const file of await fs.readdir(builtinPluginsDir)) {
      await fs.copyFile(
        path.join(builtinPluginsDir, file),
        path.join(tmpPluginDir, file),
      );
    }
  } catch {
    // builtin plugins dir not present — tests will operate on an empty plugin dir
  }
  process.env.INFLOOP_WORKFLOWS_DIR = tmpWfDir;
  process.env.INFLOOP_TRIGGERS_DIR = tmpTrDir;
  process.env.INFLOOP_WEBHOOK_PLUGINS_DIR = tmpPluginDir;
  triggerIndex.invalidate();
  pluginIndex.invalidate();
  triggerQueue.clear();
});

afterEach(async () => {
  await fs.rm(tmpWfDir, { recursive: true, force: true });
  await fs.rm(tmpTrDir, { recursive: true, force: true });
  await fs.rm(tmpPluginDir, { recursive: true, force: true });
});

const goodId = 'idAAAAAAAAAAAAAAAAAAAA';

describe('POST /api/webhook/[triggerId]', () => {
  test('404 for unknown id', async () => {
    const tid = 'absent_id_000000000000';
    const res = await POST(mkReq(tid, {}), { params: Promise.resolve({ triggerId: tid }) });
    expect(res.status).toBe(404);
  });

  test('404 for disabled trigger (same body as unknown)', async () => {
    await writeWorkflow('wf-a');
    await saveTrigger({ id: goodId, name: 't', enabled: false, workflowId: 'wf-a', pluginId: 'generic', match: [], inputs: {} });
    const res = await POST(mkReq(goodId, {}), { params: Promise.resolve({ triggerId: goodId }) });
    expect(res.status).toBe(404);
  });

  test('204 when predicates do not match', async () => {
    await writeWorkflow('wf-a');
    await saveTrigger({
      id: goodId, name: 't', enabled: true,
      workflowId: 'wf-a', pluginId: 'generic',
      match: [{ lhs: '{{body.event}}', op: '==', rhs: 'push' }],
      inputs: {},
    });
    const res = await POST(
      mkReq(goodId, { event: 'pull_request' }),
      { params: Promise.resolve({ triggerId: goodId }) },
    );
    expect(res.status).toBe(204);
    expect(triggerQueue.size()).toBe(0);
  });

  test('202 when predicates match — enqueues', async () => {
    await writeWorkflow('wf-a');
    await saveTrigger({
      id: goodId, name: 't', enabled: true,
      workflowId: 'wf-a', pluginId: 'generic',
      match: [{ lhs: '{{body.event}}', op: '==', rhs: 'push' }],
      inputs: {},
    });
    const res = await POST(
      mkReq(goodId, { event: 'push' }),
      { params: Promise.resolve({ triggerId: goodId }) },
    );
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.queued).toBe(true);
    expect(typeof json.queueId).toBe('string');
    expect(json.position).toBeGreaterThanOrEqual(1);
  });

  test('422 when a required input cannot be coerced after templating', async () => {
    await writeWorkflow('wf-b', [{ name: 'count', type: 'number' }]);
    await saveTrigger({
      id: 'idBBBBBBBBBBBBBBBBBBBB', name: 't', enabled: true,
      workflowId: 'wf-b', pluginId: 'generic',
      match: [],
      inputs: { count: '{{body.x}}' }, // resolves to string ""; cannot be coerced to number
    });
    triggerIndex.invalidate();
    const res = await POST(
      mkReq('idBBBBBBBBBBBBBBBBBBBB', {}),
      { params: Promise.resolve({ triggerId: 'idBBBBBBBBBBBBBBBBBBBB' }) },
    );
    expect(res.status).toBe(422);
  });

  test('413 when content-length exceeds 1 MiB', async () => {
    await writeWorkflow('wf-a');
    await saveTrigger({ id: goodId, name: 't', enabled: true, workflowId: 'wf-a', pluginId: 'generic', match: [], inputs: {} });
    const big = 'x'.repeat(1024 * 1024 + 1);
    const res = await POST(
      mkReq(goodId, big, { 'content-length': String(big.length) }),
      { params: Promise.resolve({ triggerId: goodId }) },
    );
    expect(res.status).toBe(413);
  });

  test('503 when the queue is at cap', async () => {
    await writeWorkflow('wf-a');
    await saveTrigger({ id: goodId, name: 't', enabled: true, workflowId: 'wf-a', pluginId: 'generic', match: [], inputs: {} });
    for (let i = 0; i < 100; i++) {
      triggerQueue.enqueue({
        workflow: { id: 'wf-a', name: 'x', version: 1, nodes: [], edges: [], createdAt: 0, updatedAt: 0 } as any,
        resolvedInputs: {},
        triggerId: goodId,
        receivedAt: i,
      });
    }
    const res = await POST(mkReq(goodId, {}), { params: Promise.resolve({ triggerId: goodId }) });
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
  });

  test('verifies signature: valid sha256=<hex> → 202', async () => {
    const { createHmac } = await import('node:crypto');
    await writePlugin('frogo', {
      id: 'frogo',
      displayName: 'Frogo',
      eventHeader: 'x-frogo-event',
      signature: { header: 'x-frogo-signature', scheme: 'hmac-sha256', format: 'sha256=<hex>' },
      events: [{ type: 'task.created', displayName: 'Task created', fields: [] }],
    });
    pluginIndex.invalidate();
    await writeWorkflow('wf-frogo');
    await saveTrigger({
      id: goodId, name: 't', enabled: true,
      workflowId: 'wf-frogo', pluginId: 'frogo', eventType: 'task.created',
      match: [], inputs: {}, secret: 'shhh',
    });

    const body = JSON.stringify({ event: 'task.created', taskId: 1 });
    const sig = 'sha256=' + createHmac('sha256', 'shhh').update(body).digest('hex');
    const res = await POST(
      mkReq(goodId, body, { 'x-frogo-event': 'task.created', 'x-frogo-signature': sig }),
      { params: Promise.resolve({ triggerId: goodId }) },
    );
    expect(res.status).toBe(202);
  });

  test('verifies signature: bad signature → 401 bad-signature', async () => {
    await writePlugin('frogo', {
      id: 'frogo',
      displayName: 'Frogo',
      eventHeader: 'x-frogo-event',
      signature: { header: 'x-frogo-signature', scheme: 'hmac-sha256', format: 'sha256=<hex>' },
      events: [{ type: 'task.created', displayName: 'Task created', fields: [] }],
    });
    pluginIndex.invalidate();
    await writeWorkflow('wf-frogo');
    await saveTrigger({
      id: goodId, name: 't', enabled: true,
      workflowId: 'wf-frogo', pluginId: 'frogo', eventType: 'task.created',
      match: [], inputs: {}, secret: 'shhh',
    });

    const body = JSON.stringify({ event: 'task.created', taskId: 1 });
    const res = await POST(
      mkReq(goodId, body, {
        'x-frogo-event': 'task.created',
        'x-frogo-signature': 'sha256=' + 'a'.repeat(64),
      }),
      { params: Promise.resolve({ triggerId: goodId }) },
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'bad-signature' });
  });

  test('verifies signature: missing header → 401 bad-signature', async () => {
    await writePlugin('frogo', {
      id: 'frogo',
      displayName: 'Frogo',
      eventHeader: 'x-frogo-event',
      signature: { header: 'x-frogo-signature', scheme: 'hmac-sha256', format: 'sha256=<hex>' },
      events: [{ type: 'task.created', displayName: 'Task created', fields: [] }],
    });
    pluginIndex.invalidate();
    await writeWorkflow('wf-frogo');
    await saveTrigger({
      id: goodId, name: 't', enabled: true,
      workflowId: 'wf-frogo', pluginId: 'frogo', eventType: 'task.created',
      match: [], inputs: {}, secret: 'shhh',
    });

    const res = await POST(
      mkReq(goodId, { event: 'task.created' }, { 'x-frogo-event': 'task.created' }),
      { params: Promise.resolve({ triggerId: goodId }) },
    );
    expect(res.status).toBe(401);
  });

  test('verifyOptional=true on signed-plugin trigger → 202 without verification', async () => {
    await writePlugin('frogo', {
      id: 'frogo',
      displayName: 'Frogo',
      eventHeader: 'x-frogo-event',
      signature: { header: 'x-frogo-signature', scheme: 'hmac-sha256', format: 'sha256=<hex>' },
      events: [{ type: 'task.created', displayName: 'Task created', fields: [] }],
    });
    pluginIndex.invalidate();
    await writeWorkflow('wf-frogo');
    await saveTrigger({
      id: goodId, name: 't', enabled: true,
      workflowId: 'wf-frogo', pluginId: 'frogo', eventType: 'task.created',
      match: [], inputs: {}, verifyOptional: true,
    });

    const res = await POST(
      mkReq(goodId, { event: 'task.created' }, { 'x-frogo-event': 'task.created' }),
      { params: Promise.resolve({ triggerId: goodId }) },
    );
    expect(res.status).toBe(202);
  });

  test('signed plugin + no secret + no verifyOptional → 500 trigger-misconfigured', async () => {
    await writePlugin('frogo', {
      id: 'frogo',
      displayName: 'Frogo',
      eventHeader: 'x-frogo-event',
      signature: { header: 'x-frogo-signature', scheme: 'hmac-sha256', format: 'sha256=<hex>' },
      events: [{ type: 'task.created', displayName: 'Task created', fields: [] }],
    });
    pluginIndex.invalidate();
    await writeWorkflow('wf-frogo');
    await saveTrigger({
      id: goodId, name: 't', enabled: true,
      workflowId: 'wf-frogo', pluginId: 'frogo', eventType: 'task.created',
      match: [], inputs: {},
    });

    const res = await POST(
      mkReq(goodId, { event: 'task.created' }, { 'x-frogo-event': 'task.created' }),
      { params: Promise.resolve({ triggerId: goodId }) },
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'trigger-misconfigured' });
  });

  test('plugin without signature block → no verification applied', async () => {
    await writeWorkflow('wf-a');
    await saveTrigger({
      id: goodId, name: 't', enabled: true,
      workflowId: 'wf-a', pluginId: 'generic',
      match: [], inputs: {}, secret: 'leftover',
    });
    const res = await POST(
      mkReq(goodId, { event: 'whatever' }),
      { params: Promise.resolve({ triggerId: goodId }) },
    );
    expect(res.status).toBe(202);
  });
});

describe('audit logging', () => {
  test('records a webhook/accepted entry on 202', async () => {
    await writeWorkflow('wf-a');
    await saveTrigger({
      id: goodId, name: 't', enabled: true,
      workflowId: 'wf-a', pluginId: 'generic', match: [], inputs: {},
    });
    const res = await POST(
      mkReq(goodId, { event: 'push' }),
      { params: Promise.resolve({ triggerId: goodId }) },
    );
    expect(res.status).toBe(202);
    const entries = await listAuditEntries({ limit: 20 });
    expect(
      entries.some(
        (e) => e.category === 'webhook' && e.action === 'accepted' && e.target === goodId,
      ),
    ).toBe(true);
  });

  test('records a webhook/rejected entry on a bad signature', async () => {
    await writePlugin('frogo', {
      id: 'frogo',
      displayName: 'Frogo',
      eventHeader: 'x-frogo-event',
      signature: { header: 'x-frogo-signature', scheme: 'hmac-sha256', format: 'sha256=<hex>' },
      events: [{ type: 'task.created', displayName: 'Task created', fields: [] }],
    });
    pluginIndex.invalidate();
    await writeWorkflow('wf-frogo');
    await saveTrigger({
      id: goodId, name: 't', enabled: true,
      workflowId: 'wf-frogo', pluginId: 'frogo', eventType: 'task.created',
      match: [], inputs: {}, secret: 'shhh',
    });
    const body = JSON.stringify({ event: 'task.created', taskId: 1 });
    const res = await POST(
      mkReq(goodId, body, {
        'x-frogo-event': 'task.created',
        'x-frogo-signature': 'sha256=' + 'a'.repeat(64),
      }),
      { params: Promise.resolve({ triggerId: goodId }) },
    );
    expect(res.status).toBe(401);
    const entries = await listAuditEntries({ limit: 20 });
    expect(
      entries.some(
        (e) =>
          e.category === 'webhook' &&
          e.action === 'rejected' &&
          e.target === goodId &&
          (e.detail as { reason?: string } | undefined)?.reason === 'bad-signature',
      ),
    ).toBe(true);
  });
});

describe('plugin event-header filter (Dispatch v2)', () => {
  const githubId = 'idGITHUBGITHUBGITHUBGI';

  test('204 when plugin has eventHeader and request header is missing', async () => {
    await writeWorkflow('wf-a');
    await saveTrigger({
      id: githubId, name: 'gh', enabled: true,
      workflowId: 'wf-a', pluginId: 'github', eventType: 'issues',
      match: [], inputs: {},
    });
    // No x-github-event header
    const res = await POST(
      mkReq(githubId, { action: 'opened' }),
      { params: Promise.resolve({ triggerId: githubId }) },
    );
    expect(res.status).toBe(204);
    expect(triggerQueue.size()).toBe(0);
  });

  test('204 when plugin event-header mismatches trigger eventType', async () => {
    await writeWorkflow('wf-a');
    await saveTrigger({
      id: githubId, name: 'gh', enabled: true,
      workflowId: 'wf-a', pluginId: 'github', eventType: 'issues',
      match: [], inputs: {},
    });
    // Header present but wrong event type
    const res = await POST(
      mkReq(githubId, { action: 'opened' }, { 'x-github-event': 'push' }),
      { params: Promise.resolve({ triggerId: githubId }) },
    );
    expect(res.status).toBe(204);
    expect(triggerQueue.size()).toBe(0);
  });

  test('202 when plugin event-header matches AND user predicates pass', async () => {
    await writeWorkflow('wf-a');
    await saveTrigger({
      id: githubId, name: 'gh', enabled: true,
      workflowId: 'wf-a', pluginId: 'github', eventType: 'issues',
      match: [], inputs: {},
    });
    // Header matches trigger's eventType
    const res = await POST(
      mkReq(githubId, { action: 'opened' }, { 'x-github-event': 'issues' }),
      { params: Promise.resolve({ triggerId: githubId }) },
    );
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.queued).toBe(true);
    expect(typeof json.queueId).toBe('string');
  });
});
