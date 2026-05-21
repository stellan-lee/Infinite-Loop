import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GET, PUT, DELETE } from './route';
import { pluginIndex } from '@/lib/server/webhook-plugins/index';
import { listAuditEntries } from '@/lib/server/audit-log';

const tmpWfDir = path.join(os.tmpdir(), `infinite-loop-api-tr-id-wf-${process.pid}`);
const tmpTrDir = path.join(os.tmpdir(), `infinite-loop-api-tr-id-tr-${process.pid}`);
const tmpPluginDir = path.join(os.tmpdir(), `infinite-loop-api-tr-id-plugins-${process.pid}`);

// Path to the bundled built-in plugins shipped with the project.
const builtinPluginsDir = path.resolve(__dirname, '../../../../webhook-plugins');

async function writeWorkflow(id: string) {
  await fs.writeFile(
    path.join(tmpWfDir, `${id}.json`),
    JSON.stringify({
      id, name: id, version: 1, createdAt: 0, updatedAt: 0,
      nodes: [{ id: 's', type: 'start', position: { x: 0, y: 0 }, config: {} }],
      edges: [], inputs: [],
    }),
  );
}

async function writePlugin(name: string, body: unknown) {
  await fs.writeFile(path.join(tmpPluginDir, `${name}.json`), JSON.stringify(body), 'utf8');
}

async function seedTrigger(id: string) {
  const { saveTrigger } = await import('@/lib/server/trigger-store');
  return saveTrigger({
    id, name: id, enabled: true, workflowId: 'wf-a',
    pluginId: 'generic', match: [], inputs: {},
  });
}

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
    // builtinPluginsDir may not exist in all environments; that's OK.
  }
  process.env.INFLOOP_WORKFLOWS_DIR = tmpWfDir;
  process.env.INFLOOP_TRIGGERS_DIR = tmpTrDir;
  process.env.INFLOOP_WEBHOOK_PLUGINS_DIR = tmpPluginDir;
  pluginIndex.invalidate();
  await writeWorkflow('wf-a');
});

afterEach(async () => {
  await fs.rm(tmpWfDir, { recursive: true, force: true });
  await fs.rm(tmpTrDir, { recursive: true, force: true });
  await fs.rm(tmpPluginDir, { recursive: true, force: true });
});

describe('GET /api/triggers/[id]', () => {
  test('returns the trigger', async () => {
    await seedTrigger('idAAAAAAAAAAAAAAAAAAAA');
    const res = await GET(
      new Request('http://test/api/triggers/idAAAAAAAAAAAAAAAAAAAA'),
      { params: Promise.resolve({ id: 'idAAAAAAAAAAAAAAAAAAAA' }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.trigger.id).toBe('idAAAAAAAAAAAAAAAAAAAA');
  });

  test('404 for unknown id', async () => {
    const res = await GET(
      new Request('http://test/api/triggers/absent_id_000000000000'),
      { params: Promise.resolve({ id: 'absent_id_000000000000' }) },
    );
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/triggers/[id]', () => {
  test('updates the trigger and preserves createdAt', async () => {
    const orig = await seedTrigger('idAAAAAAAAAAAAAAAAAAAA');
    await new Promise((r) => setTimeout(r, 5));
    const res = await PUT(
      new Request('http://test/api/triggers/idAAAAAAAAAAAAAAAAAAAA', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...orig, name: 'renamed' }),
      }),
      { params: Promise.resolve({ id: 'idAAAAAAAAAAAAAAAAAAAA' }) },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.trigger.name).toBe('renamed');
    expect(json.trigger.createdAt).toBe(orig.createdAt);
    expect(json.trigger.updatedAt).toBeGreaterThan(orig.updatedAt);
  });

  test('records a trigger/updated audit entry', async () => {
    const orig = await seedTrigger('idAAAAAAAAAAAAAAAAAAAA');
    const res = await PUT(
      new Request('http://test/api/triggers/idAAAAAAAAAAAAAAAAAAAA', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...orig, name: 'renamed' }),
      }),
      { params: Promise.resolve({ id: 'idAAAAAAAAAAAAAAAAAAAA' }) },
    );
    expect(res.status).toBe(200);
    const entries = await listAuditEntries({ limit: 10 });
    expect(
      entries.some(
        (e) =>
          e.category === 'trigger' &&
          e.action === 'updated' &&
          e.target === 'idAAAAAAAAAAAAAAAAAAAA',
      ),
    ).toBe(true);
  });

  test('400 when body tries to change the id', async () => {
    await seedTrigger('idAAAAAAAAAAAAAAAAAAAA');
    const res = await PUT(
      new Request('http://test/api/triggers/idAAAAAAAAAAAAAAAAAAAA', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 'idDIFFERENTDIFFERENT12', name: 'x', enabled: true,
          workflowId: 'wf-a', pluginId: 'generic', match: [], inputs: {},
        }),
      }),
      { params: Promise.resolve({ id: 'idAAAAAAAAAAAAAAAAAAAA' }) },
    );
    expect(res.status).toBe(400);
  });

  test('400 invalid-trigger on PUT when removing secret from signed-plugin trigger', async () => {
    await writePlugin('frogo', {
      id: 'frogo',
      displayName: 'Frogo',
      eventHeader: 'x-frogo-event',
      signature: { header: 'x-frogo-signature', scheme: 'hmac-sha256', format: 'sha256=<hex>' },
      events: [{ type: 'task.created', displayName: 'Task created', fields: [] }],
    });
    pluginIndex.invalidate();
    // Create a trigger with a secret first (bypassing validation by seeding directly)
    const { saveTrigger } = await import('@/lib/server/trigger-store');
    await saveTrigger({
      id: 'idAAAAAAAAAAAAAAAAAAAA', name: 't', enabled: true,
      workflowId: 'wf-a', pluginId: 'frogo', eventType: 'task.created',
      match: [], inputs: {}, secret: 'shhh',
    });
    // Now PUT without a secret (simulating secret removal)
    const res = await PUT(
      new Request('http://test/api/triggers/idAAAAAAAAAAAAAAAAAAAA', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 't', enabled: true, workflowId: 'wf-a', pluginId: 'frogo',
          eventType: 'task.created', match: [], inputs: {},
          // no secret, no verifyOptional
        }),
      }),
      { params: Promise.resolve({ id: 'idAAAAAAAAAAAAAAAAAAAA' }) },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid-trigger', reason: 'secret-required' });
  });

  test('200 on PUT when adding verifyOptional=true to signed-plugin trigger', async () => {
    await writePlugin('frogo', {
      id: 'frogo',
      displayName: 'Frogo',
      eventHeader: 'x-frogo-event',
      signature: { header: 'x-frogo-signature', scheme: 'hmac-sha256', format: 'sha256=<hex>' },
      events: [{ type: 'task.created', displayName: 'Task created', fields: [] }],
    });
    pluginIndex.invalidate();
    const { saveTrigger } = await import('@/lib/server/trigger-store');
    await saveTrigger({
      id: 'idAAAAAAAAAAAAAAAAAAAA', name: 't', enabled: true,
      workflowId: 'wf-a', pluginId: 'frogo', eventType: 'task.created',
      match: [], inputs: {}, verifyOptional: true,
    });
    const res = await PUT(
      new Request('http://test/api/triggers/idAAAAAAAAAAAAAAAAAAAA', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 't', enabled: true, workflowId: 'wf-a', pluginId: 'frogo',
          eventType: 'task.created', match: [], inputs: {}, verifyOptional: true,
        }),
      }),
      { params: Promise.resolve({ id: 'idAAAAAAAAAAAAAAAAAAAA' }) },
    );
    expect(res.status).toBe(200);
  });
});

describe('DELETE /api/triggers/[id]', () => {
  test('removes the trigger', async () => {
    await seedTrigger('idAAAAAAAAAAAAAAAAAAAA');
    const res = await DELETE(
      new Request('http://test/api/triggers/idAAAAAAAAAAAAAAAAAAAA', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'idAAAAAAAAAAAAAAAAAAAA' }) },
    );
    expect(res.status).toBe(204);
    const { listTriggers } = await import('@/lib/server/trigger-store');
    expect(await listTriggers()).toHaveLength(0);
  });

  test('404 for unknown id', async () => {
    const res = await DELETE(
      new Request('http://test/api/triggers/absent_id_000000000000', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'absent_id_000000000000' }) },
    );
    expect(res.status).toBe(404);
  });

  test('records a trigger/deleted audit entry', async () => {
    await seedTrigger('idAAAAAAAAAAAAAAAAAAAA');
    const res = await DELETE(
      new Request('http://test/api/triggers/idAAAAAAAAAAAAAAAAAAAA', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'idAAAAAAAAAAAAAAAAAAAA' }) },
    );
    expect(res.status).toBe(204);
    const entries = await listAuditEntries({ limit: 10 });
    expect(
      entries.some(
        (e) =>
          e.category === 'trigger' &&
          e.action === 'deleted' &&
          e.target === 'idAAAAAAAAAAAAAAAAAAAA',
      ),
    ).toBe(true);
  });
});
