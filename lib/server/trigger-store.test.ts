import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  listTriggers,
  getTrigger,
  saveTrigger,
  deleteTrigger,
  touchLastFired,
} from './trigger-store';
import type { WebhookTrigger } from '../shared/trigger';

const tmpWfDir = path.join(os.tmpdir(), `infinite-loop-tstore-wf-${process.pid}`);
const tmpTrDir = path.join(os.tmpdir(), `infinite-loop-tstore-tr-${process.pid}`);

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

function baseTrigger(overrides: Partial<WebhookTrigger> = {}): Omit<WebhookTrigger, 'createdAt' | 'updatedAt'> {
  return {
    id: 'idAAAAAAAAAAAAAAAAAAAA',
    name: 'test',
    enabled: true,
    workflowId: 'wf-a',
    pluginId: 'generic',
    match: [],
    inputs: {},
    ...overrides,
  };
}

beforeEach(async () => {
  await fs.rm(tmpWfDir, { recursive: true, force: true });
  await fs.rm(tmpTrDir, { recursive: true, force: true });
  await fs.mkdir(tmpWfDir, { recursive: true });
  await fs.mkdir(tmpTrDir, { recursive: true });
  process.env.INFLOOP_WORKFLOWS_DIR = tmpWfDir;
  process.env.INFLOOP_TRIGGERS_DIR = tmpTrDir;
  await writeWorkflow('wf-a');
});

afterEach(async () => {
  await fs.rm(tmpWfDir, { recursive: true, force: true });
  await fs.rm(tmpTrDir, { recursive: true, force: true });
});

describe('trigger-store', () => {
  test('saveTrigger writes a file and listTriggers reads it back', async () => {
    const saved = await saveTrigger(baseTrigger());
    expect(saved.id).toBe('idAAAAAAAAAAAAAAAAAAAA');
    expect(saved.createdAt).toBeGreaterThan(0);
    expect(saved.updatedAt).toBeGreaterThan(0);
    const list = await listTriggers();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('idAAAAAAAAAAAAAAAAAAAA');
  });

  test('saveTrigger rejects an invalid id', async () => {
    await expect(saveTrigger(baseTrigger({ id: 'bad' }))).rejects.toThrow(/id/i);
  });

  test('saveTrigger rejects an unknown plugin', async () => {
    await expect(
      saveTrigger(baseTrigger({ pluginId: 'imaginary' })),
    ).rejects.toThrow(/plugin/i);
  });

  test('saveTrigger requires eventType when plugin has eventHeader', async () => {
    await expect(
      saveTrigger(baseTrigger({ pluginId: 'github' /* missing eventType */ })),
    ).rejects.toThrow(/eventType|event/i);
  });

  test('saveTrigger accepts a valid GitHub event type', async () => {
    const saved = await saveTrigger(
      baseTrigger({ pluginId: 'github', eventType: 'issues' }),
    );
    expect(saved.eventType).toBe('issues');
  });

  test('saveTrigger rejects an unknown event type for github', async () => {
    await expect(
      saveTrigger(baseTrigger({ pluginId: 'github', eventType: 'merge_queue' })),
    ).rejects.toThrow(/event/i);
  });

  test('saveTrigger rejects an unknown workflowId', async () => {
    await expect(
      saveTrigger(baseTrigger({ workflowId: 'nope' })),
    ).rejects.toThrow(/workflow/i);
  });

  test('saveTrigger rejects an input key not declared on the workflow', async () => {
    await expect(
      saveTrigger(baseTrigger({ inputs: { undeclared: '{{body.x}}' } })),
    ).rejects.toThrow(/undeclared/);
  });

  test('saveTrigger accepts inputs that match declared workflow inputs', async () => {
    await writeWorkflow('wf-a', [{ name: 'branch', type: 'string' }]);
    const saved = await saveTrigger(
      baseTrigger({ inputs: { branch: '{{body.ref}}' } }),
    );
    expect(saved.inputs.branch).toBe('{{body.ref}}');
  });

  test('deleteTrigger removes the file', async () => {
    await saveTrigger(baseTrigger());
    await deleteTrigger('idAAAAAAAAAAAAAAAAAAAA');
    expect(await listTriggers()).toHaveLength(0);
  });

  test('getTrigger throws when missing', async () => {
    await expect(getTrigger('absent_id_000000000000')).rejects.toThrow(/not found/i);
  });

  test('saveTrigger second call preserves createdAt and bumps updatedAt', async () => {
    const first = await saveTrigger(baseTrigger());
    // Force a ms gap so timestamps differ
    await new Promise((r) => setTimeout(r, 5));
    const second = await saveTrigger({ ...first, name: 'renamed' });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
  });

  test('saveTrigger writes the trigger file 0600 — it can carry a webhook secret', async () => {
    if (process.platform === 'win32') return; // POSIX mode bits only
    const saved = await saveTrigger(baseTrigger({ secret: 'webhook-shared-secret' }));
    const st = await fs.stat(path.join(tmpTrDir, `${saved.id}.json`));
    expect(st.mode & 0o777).toBe(0o600);
  });

  test('touchLastFired keeps the trigger file 0600', async () => {
    if (process.platform === 'win32') return; // POSIX mode bits only
    const saved = await saveTrigger(baseTrigger({ secret: 'webhook-shared-secret' }));
    await touchLastFired(saved.id);
    const st = await fs.stat(path.join(tmpTrDir, `${saved.id}.json`));
    expect(st.mode & 0o777).toBe(0o600);
  });
});

describe('malformed trigger files', () => {
  // Trigger files are read with a shape guard (isWebhookTrigger), so a file
  // that is valid JSON but the wrong shape — an old-schema trigger surfaced by
  // a backup restore, a hand-edit, a torn write — is rejected on read instead
  // of detonating later inside webhook dispatch on an undefined deref.

  test('listTriggers skips a valid-JSON-but-wrong-shape file', async () => {
    await saveTrigger(baseTrigger());
    await fs.writeFile(path.join(tmpTrDir, 'corrupt-shape.json'), '{}');
    const list = await listTriggers();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('idAAAAAAAAAAAAAAAAAAAA');
  });

  test('listTriggers skips a null file', async () => {
    await saveTrigger(baseTrigger());
    await fs.writeFile(path.join(tmpTrDir, 'corrupt-null.json'), 'null');
    expect(await listTriggers()).toHaveLength(1);
  });

  test('listTriggers skips a syntactically invalid JSON file', async () => {
    await saveTrigger(baseTrigger());
    await fs.writeFile(path.join(tmpTrDir, 'corrupt-syntax.json'), 'not json');
    expect(await listTriggers()).toHaveLength(1);
  });

  test('getTrigger treats a wrong-shape file as not-found', async () => {
    await fs.writeFile(path.join(tmpTrDir, 'wrongshape.json'), '{"id":"wrongshape"}');
    await expect(getTrigger('wrongshape')).rejects.toThrow(/not found/i);
  });

  test('getTrigger treats a syntactically invalid JSON file as not-found', async () => {
    await fs.writeFile(path.join(tmpTrDir, 'badjson.json'), '{ broken');
    await expect(getTrigger('badjson')).rejects.toThrow(/not found/i);
  });

  test('saveTrigger heals a corrupt existing file by overwriting it', async () => {
    // saveTrigger looks up the existing trigger to preserve createdAt; when
    // that file is corrupt, getTrigger reports not-found and the save proceeds
    // as a fresh write, replacing the corrupt file with a valid one.
    await fs.writeFile(
      path.join(tmpTrDir, 'idAAAAAAAAAAAAAAAAAAAA.json'),
      '{}',
    );
    const saved = await saveTrigger(baseTrigger());
    expect(saved.createdAt).toBeGreaterThan(0);
    const list = await listTriggers();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('idAAAAAAAAAAAAAAAAAAAA');
  });
});

describe('touchLastFired', () => {
  test('updates lastFiredAt without re-validation', async () => {
    await saveTrigger(baseTrigger());
    await touchLastFired('idAAAAAAAAAAAAAAAAAAAA', 1_700_000_000_000);
    const after = await getTrigger('idAAAAAAAAAAAAAAAAAAAA');
    expect(after.lastFiredAt).toBe(1_700_000_000_000);
  });

  test('is a no-op when the trigger does not exist', async () => {
    await touchLastFired('absent_id_000000000000');
    // Should not throw.
  });

  test('three concurrent touches do not collide on the tmp file', async () => {
    // Regression for the touchLastFired ENOENT race surfaced by the review:
    // with a shared `${target}.tmp` name, near-simultaneous touches racing
    // through writeFile + rename produced ENOENT when one cleanup arrived
    // between another's writeFile and rename. With the per-call random
    // suffix, all three writers coexist and one wins the final rename.
    await saveTrigger(baseTrigger());
    await Promise.all([
      touchLastFired('idAAAAAAAAAAAAAAAAAAAA', 1_700_000_000_010),
      touchLastFired('idAAAAAAAAAAAAAAAAAAAA', 1_700_000_000_020),
      touchLastFired('idAAAAAAAAAAAAAAAAAAAA', 1_700_000_000_030),
    ]);
    const after = await getTrigger('idAAAAAAAAAAAAAAAAAAAA');
    expect([1_700_000_000_010, 1_700_000_000_020, 1_700_000_000_030])
      .toContain(after.lastFiredAt!);
    // No `.tmp` leftover should remain in the directory.
    const dirEntries = await fs.readdir(tmpTrDir);
    expect(dirEntries.some((f) => f.endsWith('.tmp'))).toBe(false);
  });
});
