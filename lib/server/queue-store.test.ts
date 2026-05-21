import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { queueDir } from './paths';
import {
  listPersistedQueuedRuns,
  persistQueuedRun,
  removeQueuedRun,
} from './queue-store';
import type { QueuedRun } from './trigger-queue';
import type { Workflow } from '../shared/workflow';

function fakeWorkflow(id: string): Workflow {
  return {
    id,
    name: id,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    nodes: [{ id: 's', type: 'start', position: { x: 0, y: 0 }, config: {} }],
    edges: [],
  };
}

function fakeQueuedRun(over: Partial<QueuedRun> = {}): QueuedRun {
  return {
    queueId: 'q-1-1',
    workflow: fakeWorkflow('wf'),
    resolvedInputs: { topic: 'hello' },
    triggerId: 'trigger-abcdef0123456789',
    receivedAt: 1_000,
    ...over,
  };
}

describe('queue-store', () => {
  const originalDataDir = process.env.INFLOOP_DATA_DIR;
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'infloop-queue-store-'));
    process.env.INFLOOP_DATA_DIR = tmp;
  });

  afterAll(() => {
    if (originalDataDir === undefined) delete process.env.INFLOOP_DATA_DIR;
    else process.env.INFLOOP_DATA_DIR = originalDataDir;
    rmSync(tmp, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(queueDir(), { recursive: true, force: true });
  });

  it('round-trips a persisted queued run', () => {
    const item = fakeQueuedRun({ queueId: 'q-100-1' });
    persistQueuedRun(item);

    const loaded = listPersistedQueuedRuns();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].queueId).toBe('q-100-1');
    expect(loaded[0].workflow.id).toBe('wf');
    expect(loaded[0].resolvedInputs).toEqual({ topic: 'hello' });
    expect(loaded[0].triggerId).toBe('trigger-abcdef0123456789');
    expect(loaded[0].receivedAt).toBe(1_000);
  });

  it('stamps the current process pid', () => {
    persistQueuedRun(fakeQueuedRun({ queueId: 'q-100-2' }));
    expect(listPersistedQueuedRuns()[0].serverPid).toBe(process.pid);
  });

  it('leaves no .tmp file behind after a successful persist', () => {
    persistQueuedRun(fakeQueuedRun({ queueId: 'q-100-3' }));
    const names = readdirSync(queueDir());
    expect(names).toEqual(['q-100-3.json']);
  });

  it('removeQueuedRun deletes the file', () => {
    persistQueuedRun(fakeQueuedRun({ queueId: 'q-100-4' }));
    expect(listPersistedQueuedRuns()).toHaveLength(1);

    removeQueuedRun('q-100-4');
    expect(listPersistedQueuedRuns()).toHaveLength(0);
  });

  it('removeQueuedRun on a missing file is a silent no-op', () => {
    expect(() => removeQueuedRun('q-does-not-exist')).not.toThrow();
  });

  it('returns an empty list when the queue dir does not exist', () => {
    // afterEach removed the dir; nothing persisted in this test.
    expect(listPersistedQueuedRuns()).toEqual([]);
  });

  it('skips a torn / unparseable file', () => {
    persistQueuedRun(fakeQueuedRun({ queueId: 'q-100-5' }));
    writeFileSync(path.join(queueDir(), 'q-torn.json'), '{not json', 'utf8');

    const loaded = listPersistedQueuedRuns();
    expect(loaded.map((i) => i.queueId)).toEqual(['q-100-5']);
  });

  it('skips a structurally invalid record', () => {
    persistQueuedRun(fakeQueuedRun({ queueId: 'q-100-6' }));
    writeFileSync(
      path.join(queueDir(), 'q-bad.json'),
      JSON.stringify({ queueId: 'q-bad' }), // missing required fields
      'utf8',
    );

    const loaded = listPersistedQueuedRuns();
    expect(loaded.map((i) => i.queueId)).toEqual(['q-100-6']);
  });

  it('reaps a leftover .tmp file from a crashed write', () => {
    persistQueuedRun(fakeQueuedRun({ queueId: 'q-100-7' }));
    const tmpFile = path.join(queueDir(), 'q-100-7.json.tmp');
    writeFileSync(tmpFile, 'partial', 'utf8');

    const loaded = listPersistedQueuedRuns();
    expect(loaded.map((i) => i.queueId)).toEqual(['q-100-7']);
    expect(existsSync(tmpFile)).toBe(false);
  });
});
