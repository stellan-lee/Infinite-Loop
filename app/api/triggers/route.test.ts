import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GET, POST } from './route';
import { pluginIndex } from '@/lib/server/webhook-plugins/index';
import { listAuditEntries } from '@/lib/server/audit-log';

const tmpWfDir = path.join(os.tmpdir(), `infinite-loop-api-tr-wf-${process.pid}`);
const tmpTrDir = path.join(os.tmpdir(), `infinite-loop-api-tr-tr-${process.pid}`);
const tmpPluginDir = path.join(os.tmpdir(), `infinite-loop-api-tr-plugins-${process.pid}`);

// Path to the bundled built-in plugins shipped with the project.
const builtinPluginsDir = path.resolve(__dirname, '../../../webhook-plugins');

async function writeWorkflow(id: string, inputs: unknown[] = []) {
  await fs.writeFile(
    path.join(tmpWfDir, `${id}.json`),
    JSON.stringify({
      id, name: id, version: 1, createdAt: 0, updatedAt: 0,
      nodes: [{ id: 's', type: 'start', position: { x: 0, y: 0 }, config: {} }],
      edges: [], inputs,
    }),
  );
}

async function writePlugin(name: string, body: unknown) {
  await fs.writeFile(path.join(tmpPluginDir, `${name}.json`), JSON.stringify(body), 'utf8');
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
  await writeWorkflow('wf-b');
});

afterEach(async () => {
  await fs.rm(tmpWfDir, { recursive: true, force: true });
  await fs.rm(tmpTrDir, { recursive: true, force: true });
  await fs.rm(tmpPluginDir, { recursive: true, force: true });
});

describe('GET /api/triggers', () => {
  test('returns empty list when none exist', async () => {
    const res = await GET(new Request('http://test/api/triggers'));
    const json = await res.json();
    expect(json.triggers).toEqual([]);
  });

  test('lists all triggers', async () => {
    const r1 = await POST(new Request('http://test/api/triggers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'a', enabled: true, workflowId: 'wf-a',
        pluginId: 'generic', match: [], inputs: {},
      }),
    }));
    expect(r1.status).toBe(201);
    const r2 = await POST(new Request('http://test/api/triggers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'b', enabled: true, workflowId: 'wf-b',
        pluginId: 'generic', match: [], inputs: {},
      }),
    }));
    expect(r2.status).toBe(201);

    const res = await GET(new Request('http://test/api/triggers'));
    const json = await res.json();
    expect(json.triggers).toHaveLength(2);
  });

  test('?workflowId filters server-side', async () => {
    await POST(new Request('http://test/api/triggers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'a', enabled: true, workflowId: 'wf-a',
        pluginId: 'generic', match: [], inputs: {},
      }),
    }));
    await POST(new Request('http://test/api/triggers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'b', enabled: true, workflowId: 'wf-b',
        pluginId: 'generic', match: [], inputs: {},
      }),
    }));
    const res = await GET(new Request('http://test/api/triggers?workflowId=wf-a'));
    const json = await res.json();
    expect(json.triggers).toHaveLength(1);
    expect(json.triggers[0].workflowId).toBe('wf-a');
  });
});

describe('POST /api/triggers', () => {
  test('creates a trigger with a server-generated id and timestamps', async () => {
    const res = await POST(new Request('http://test/api/triggers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'gh', enabled: true, workflowId: 'wf-a',
        pluginId: 'github', eventType: 'issues',
        match: [], inputs: {},
      }),
    }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.trigger.id).toMatch(/^[A-Za-z0-9_-]{16,32}$/);
    expect(json.trigger.createdAt).toBeGreaterThan(0);
    expect(json.trigger.updatedAt).toBeGreaterThan(0);
  });

  test('records a trigger/created audit entry', async () => {
    const res = await POST(new Request('http://test/api/triggers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'audited', enabled: true, workflowId: 'wf-a',
        pluginId: 'generic', match: [], inputs: {},
      }),
    }));
    expect(res.status).toBe(201);
    const { id } = (await res.json()).trigger;
    const entries = await listAuditEntries({ limit: 10 });
    expect(
      entries.some(
        (e) => e.category === 'trigger' && e.action === 'created' && e.target === id,
      ),
    ).toBe(true);
  });

  test('400 on invalid body', async () => {
    const res = await POST(new Request('http://test/api/triggers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ /* missing required fields */ }),
    }));
    expect(res.status).toBe(400);
  });

  test('400 when plugin unknown', async () => {
    const res = await POST(new Request('http://test/api/triggers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'x', enabled: true, workflowId: 'wf-a',
        pluginId: 'nope', match: [], inputs: {},
      }),
    }));
    expect(res.status).toBe(400);
  });

  test('400 invalid-trigger when signed plugin trigger has no secret and no verifyOptional', async () => {
    await writePlugin('frogo', {
      id: 'frogo',
      displayName: 'Frogo',
      eventHeader: 'x-frogo-event',
      signature: { header: 'x-frogo-signature', scheme: 'hmac-sha256', format: 'sha256=<hex>' },
      events: [{ type: 'task.created', displayName: 'Task created', fields: [] }],
    });
    pluginIndex.invalidate();
    const res = await POST(
      new Request('http://test/api/triggers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 't', enabled: true, workflowId: 'wf-a', pluginId: 'frogo',
          eventType: 'task.created', match: [], inputs: {},
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid-trigger', reason: 'secret-required' });
  });

  test('201 when signed plugin trigger has verifyOptional=true', async () => {
    await writePlugin('frogo', {
      id: 'frogo',
      displayName: 'Frogo',
      eventHeader: 'x-frogo-event',
      signature: { header: 'x-frogo-signature', scheme: 'hmac-sha256', format: 'sha256=<hex>' },
      events: [{ type: 'task.created', displayName: 'Task created', fields: [] }],
    });
    pluginIndex.invalidate();
    const res = await POST(
      new Request('http://test/api/triggers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 't', enabled: true, workflowId: 'wf-a', pluginId: 'frogo',
          eventType: 'task.created', match: [], inputs: {}, verifyOptional: true,
        }),
      }),
    );
    expect(res.status).toBe(201);
  });
});
