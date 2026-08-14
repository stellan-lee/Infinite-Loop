import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, test } from 'bun:test';
import type { Workflow } from '../shared/workflow';
import {
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  saveWorkflow,
} from './workflow-store';

let tmpDir: string;
let prevEnv: string | undefined;
let prevLibEnv: string | undefined;

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-1',
    name: 'Test Workflow',
    version: 0,
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      {
        id: 'start-1',
        type: 'start',
        position: { x: 0, y: 0 },
        config: {},
      },
      {
        id: 'end-1',
        type: 'end',
        position: { x: 200, y: 0 },
        config: { outcome: 'succeeded' },
      },
    ],
    edges: [
      {
        id: 'e1',
        source: 'start-1',
        sourceHandle: 'next',
        target: 'end-1',
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-loop-wfstore-'));
  prevEnv = process.env.INFLOOP_WORKFLOWS_DIR;
  prevLibEnv = process.env.INFLOOP_LIBRARY_DIR;
  process.env.INFLOOP_WORKFLOWS_DIR = tmpDir;
  process.env.INFLOOP_LIBRARY_DIR = path.join(tmpDir, 'library');
});

afterEach(async () => {
  if (prevEnv === undefined) {
    delete process.env.INFLOOP_WORKFLOWS_DIR;
  } else {
    process.env.INFLOOP_WORKFLOWS_DIR = prevEnv;
  }
  if (prevLibEnv === undefined) {
    delete process.env.INFLOOP_LIBRARY_DIR;
  } else {
    process.env.INFLOOP_LIBRARY_DIR = prevLibEnv;
  }
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('workflow-store', () => {
  it('rejects a structured-output node whose schema is not an object', async () => {
    const wf = makeWorkflow({
      nodes: [
        { id: 'start-1', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'structured-output-1',
          type: 'structured-output',
          position: { x: 100, y: 0 },
          config: {
            providerId: 'http-provider',
            prompt: 'p',
            schema: [] as unknown as Record<string, unknown>,
            timeoutMs: 1000,
          },
        },
      ],
      edges: [],
    });

    await expect(saveWorkflow(wf)).rejects.toThrow(/structured-output.*schema must be a JSON object/i);
  });

  it('listWorkflows returns [] when the directory is empty (and creates it)', async () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-loop-wfstore-empty-'));
    const nested = path.join(fresh, 'does-not-exist-yet');
    process.env.INFLOOP_WORKFLOWS_DIR = nested;

    const list = await listWorkflows();
    expect(list).toEqual([]);
    expect(fs.existsSync(nested)).toBe(true);

    await fsp.rm(fresh, { recursive: true, force: true });
  });

  it('saveWorkflow writes the workflow, list returns it, and get returns the saved object with bumped version + updatedAt', async () => {
    const before = Date.now();
    const wf = makeWorkflow();
    const saved = await saveWorkflow(wf);

    expect(saved.version).toBe(1);
    expect(saved.updatedAt).toBeGreaterThanOrEqual(before);

    const list = await listWorkflows();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 'wf-1',
      name: 'Test Workflow',
      version: 1,
    });

    const fetched = await getWorkflow('wf-1');
    expect(fetched).toEqual(saved);

    // Save again -> version bumps.
    const second = await saveWorkflow(wf);
    expect(second.version).toBe(2);
    expect(second.updatedAt).toBeGreaterThanOrEqual(saved.updatedAt);

    const fetchedAgain = await getWorkflow('wf-1');
    expect(fetchedAgain.version).toBe(2);
  });

  it('saveWorkflow throws when the workflow has no start node', async () => {
    const bad = makeWorkflow({
      nodes: [
        {
          id: 'end-1',
          type: 'end',
          position: { x: 0, y: 0 },
          config: { outcome: 'succeeded' },
        },
      ],
      edges: [],
    });

    await expect(saveWorkflow(bad)).rejects.toThrow(/start/i);
  });

  it('saveWorkflow throws when an edge references an unknown node id', async () => {
    const bad = makeWorkflow({
      edges: [
        {
          id: 'e-bad',
          source: 'start-1',
          sourceHandle: 'next',
          target: 'ghost-node',
        },
      ],
    });

    await expect(saveWorkflow(bad)).rejects.toThrow(/ghost-node/);
  });

  it('rejects a legacy standalone judge node on save', async () => {
    const bad = makeWorkflow({
      nodes: [
        {
          id: 'start-1',
          type: 'start',
          position: { x: 0, y: 0 },
          config: {},
        },
        {
          id: 'judge-1',
          type: 'judge',
          position: { x: 100, y: 0 },
          config: { criteria: '', candidates: [] },
        },
      ],
      edges: [],
    } as unknown as Partial<Workflow>);

    await expect(saveWorkflow(bad)).rejects.toThrow(/judge node .* has been removed/i);
  });

  it('saveWorkflow accepts edges that reference container children', async () => {
    const wf = makeWorkflow({
      id: 'wf-loop',
      nodes: [
        {
          id: 'start-1',
          type: 'start',
          position: { x: 0, y: 0 },
          config: {},
        },
        {
          id: 'loop-1',
          type: 'loop',
          position: { x: 100, y: 0 },
          config: { maxIterations: 3, mode: 'while-not-met' },
          children: [
            {
              id: 'agent-1',
              type: 'agent',
              position: { x: 0, y: 0 },
              config: { providerId: 'claude', prompt: 'p', cwd: '/tmp', timeoutMs: 1000 },
            },
            {
              id: 'cond-1',
              type: 'condition',
              position: { x: 100, y: 0 },
              config: {
                kind: 'sentinel',
                sentinel: { pattern: 'X', isRegex: false },
              },
            },
          ],
        },
        {
          id: 'end-1',
          type: 'end',
          position: { x: 300, y: 0 },
          config: { outcome: 'succeeded' },
        },
      ],
      edges: [
        { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'loop-1' },
        { id: 'e2', source: 'loop-1', sourceHandle: 'next', target: 'end-1' },
        { id: 'e3', source: 'agent-1', sourceHandle: 'next', target: 'cond-1' },
      ],
    });

    const saved = await saveWorkflow(wf);
    expect(saved.id).toBe('wf-loop');
    const fetched = await getWorkflow('wf-loop');
    expect(fetched.nodes.find((n) => n.id === 'loop-1')?.children).toHaveLength(2);
  });

  it('getWorkflow throws a descriptive error when the id is missing', async () => {
    await expect(getWorkflow('nope')).rejects.toThrow(/workflow not found: nope/);
  });

  it('deleteWorkflow removes the file and subsequent get throws', async () => {
    const wf = makeWorkflow();
    await saveWorkflow(wf);

    await deleteWorkflow('wf-1');

    await expect(getWorkflow('wf-1')).rejects.toThrow(/workflow not found: wf-1/);
    await expect(deleteWorkflow('wf-1')).rejects.toThrow(/workflow not found: wf-1/);
  });

  it('two consecutive saves both produce a consistent on-disk file (atomic write)', async () => {
    const wf = makeWorkflow();
    const a = await saveWorkflow(wf);
    const b = await saveWorkflow(wf);

    expect(a.version).toBe(1);
    expect(b.version).toBe(2);

    // No leftover .tmp files.
    const entries = await fsp.readdir(tmpDir);
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);

    const fetched = await getWorkflow('wf-1');
    expect(fetched.version).toBe(2);
    // On-disk JSON parses cleanly.
    const raw = await fsp.readFile(path.join(tmpDir, 'wf-1.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('migrates legacy `type: "claude"` nodes to `agent` with providerId on load', async () => {
    // Drop a legacy file directly to disk (skipping the validating writer).
    const legacy = {
      id: 'wf-legacy',
      name: 'Legacy',
      version: 5,
      createdAt: 1,
      updatedAt: 2,
      nodes: [
        { id: 'start-1', type: 'start', position: { x: 0, y: 0 }, config: {} },
        {
          id: 'claude-1',
          type: 'claude',
          position: { x: 0, y: 0 },
          config: { prompt: 'p', cwd: '/tmp', timeoutMs: 1000 },
        },
        { id: 'end-1', type: 'end', position: { x: 0, y: 0 }, config: {} },
      ],
      edges: [],
    };
    fs.writeFileSync(
      path.join(tmpDir, 'wf-legacy.json'),
      JSON.stringify(legacy),
    );

    const fetched = await getWorkflow('wf-legacy');
    const migrated = fetched.nodes.find((n) => n.id === 'claude-1');
    expect(migrated?.type).toBe('agent');
    expect(migrated?.config).toMatchObject({
      providerId: 'claude',
      prompt: 'p',
      cwd: '/tmp',
      timeoutMs: 1000,
    });
  });

  it('listWorkflows ignores malformed *.json files without throwing', async () => {
    const wf = makeWorkflow();
    await saveWorkflow(wf);

    // Drop a junk file alongside.
    fs.writeFileSync(path.join(tmpDir, 'broken.json'), '{not valid json');
    // Drop a structurally-invalid one (missing required fields).
    fs.writeFileSync(
      path.join(tmpDir, 'partial.json'),
      JSON.stringify({ id: 'partial' }),
    );

    const list = await listWorkflows();
    expect(list.map((s) => s.id)).toEqual(['wf-1']);
  });

  it('listWorkflows sorts by updatedAt descending', async () => {
    const a = await saveWorkflow(makeWorkflow({ id: 'a', name: 'A' }));
    // Force distinct timestamps.
    await new Promise((r) => setTimeout(r, 5));
    const b = await saveWorkflow(makeWorkflow({ id: 'b', name: 'B' }));

    const list = await listWorkflows();
    expect(list.map((s) => s.id)).toEqual(['b', 'a']);
    expect(b.updatedAt).toBeGreaterThanOrEqual(a.updatedAt);
  });

  describe('manual node validation', () => {
    function withManualConfig(config: unknown): Workflow {
      return makeWorkflow({
        nodes: [
          { id: 'start-1', type: 'start', position: { x: 0, y: 0 }, config: {} },
          {
            id: 'manual-1',
            type: 'manual',
            position: { x: 100, y: 0 },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            config: config as any,
          },
          {
            id: 'end-1',
            type: 'end',
            position: { x: 200, y: 0 },
            config: { outcome: 'succeeded' },
          },
        ],
        edges: [
          { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'manual-1' },
          { id: 'e2', source: 'manual-1', sourceHandle: 'accepted', target: 'end-1' },
        ],
      });
    }

    it('accepts the default-ish shape (omitted decisions, blank brief)', async () => {
      await expect(saveWorkflow(withManualConfig({ brief: '' }))).resolves.toBeDefined();
    });

    it('accepts a valid decisions array with the conventional keys', async () => {
      await expect(
        saveWorkflow(
          withManualConfig({
            decisions: [
              { key: 'accepted', label: 'Ship' },
              { key: 'rejected' },
            ],
          }),
        ),
      ).resolves.toBeDefined();
    });

    it('rejects a non-array decisions value', async () => {
      await expect(
        saveWorkflow(withManualConfig({ decisions: 'all-of-them' })),
      ).rejects.toThrow(/decisions must be an array/);
    });

    it('rejects an empty decisions array', async () => {
      await expect(
        saveWorkflow(withManualConfig({ decisions: [] })),
      ).rejects.toThrow(/at least one entry/);
    });

    it('rejects a decision key outside the conventional set', async () => {
      await expect(
        saveWorkflow(withManualConfig({ decisions: [{ key: 'maybe' }] })),
      ).rejects.toThrow(/must be one of/);
    });

    it('rejects duplicate decision keys', async () => {
      await expect(
        saveWorkflow(
          withManualConfig({ decisions: [{ key: 'accepted' }, { key: 'accepted' }] }),
        ),
      ).rejects.toThrow(/duplicate decision/);
    });

    it('rejects a negative timeoutMs', async () => {
      await expect(
        saveWorkflow(withManualConfig({ decisions: [{ key: 'accepted' }], timeoutMs: -1 })),
      ).rejects.toThrow(/timeoutMs must be a non-negative number/);
    });

    it('rejects timeoutMs > 0 when the decisions array omits `rejected`', async () => {
      await expect(
        saveWorkflow(
          withManualConfig({
            decisions: [{ key: 'accepted' }, { key: 'needs_changes' }],
            timeoutMs: 60_000,
          }),
        ),
      ).rejects.toThrow(/requires a "rejected" decision/);
    });

    it('accepts timeoutMs > 0 when `rejected` is in the decisions array', async () => {
      await expect(
        saveWorkflow(
          withManualConfig({
            decisions: [{ key: 'accepted' }, { key: 'rejected' }],
            timeoutMs: 60_000,
          }),
        ),
      ).resolves.toBeDefined();
    });

    it('accepts timeoutMs: 0 (treated as no timeout) without requiring `rejected`', async () => {
      await expect(
        saveWorkflow(
          withManualConfig({ decisions: [{ key: 'accepted' }], timeoutMs: 0 }),
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('agent outputs validation', () => {
    function withAgentOutputs(outputs: unknown): Workflow {
      return makeWorkflow({
        nodes: [
          { id: 'start-1', type: 'start', position: { x: 0, y: 0 }, config: {} },
          {
            id: 'agent-1',
            type: 'agent',
            position: { x: 100, y: 0 },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            config: { providerId: 'claude', prompt: 'p', cwd: '/tmp', timeoutMs: 1000, outputs } as any,
          },
          {
            id: 'end-1',
            type: 'end',
            position: { x: 200, y: 0 },
            config: { outcome: 'succeeded' },
          },
        ],
        edges: [
          { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'agent-1' },
          { id: 'e2', source: 'agent-1', sourceHandle: 'next', target: 'end-1' },
        ],
      });
    }

    it('accepts a valid outputs declaration', async () => {
      const wf = withAgentOutputs([
        { name: 'PR_LINK' },
        { name: 'PR_ID', description: 'pull-request id' },
      ]);
      await expect(saveWorkflow(wf)).resolves.toBeDefined();
    });

    it('rejects non-array outputs', async () => {
      const wf = withAgentOutputs('not-an-array');
      await expect(saveWorkflow(wf)).rejects.toThrow(/outputs must be an array/);
    });

    it('rejects entries without a name', async () => {
      const wf = withAgentOutputs([{ description: 'no name' }]);
      await expect(saveWorkflow(wf)).rejects.toThrow(/outputs entries must be/);
    });

    it('rejects reserved names', async () => {
      const wf = withAgentOutputs([{ name: 'stdout' }]);
      await expect(saveWorkflow(wf)).rejects.toThrow(/collides with a reserved runtime field/);
    });

    it('rejects duplicate names', async () => {
      const wf = withAgentOutputs([{ name: 'X' }, { name: 'X' }]);
      await expect(saveWorkflow(wf)).rejects.toThrow(/duplicate output/);
    });

    it('accepts an empty outputs array', async () => {
      const wf = withAgentOutputs([]);
      await expect(saveWorkflow(wf)).resolves.toBeDefined();
    });
  });

  describe('agent messages validation', () => {
    function withAgentMessages(messages: unknown): Workflow {
      return makeWorkflow({
        nodes: [
          { id: 'start-1', type: 'start', position: { x: 0, y: 0 }, config: {} },
          {
            id: 'agent-1',
            type: 'agent',
            position: { x: 100, y: 0 },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            config: { providerId: 'claude', prompt: 'p', cwd: '/tmp', timeoutMs: 1000, messages } as any,
          },
          {
            id: 'end-1',
            type: 'end',
            position: { x: 200, y: 0 },
            config: { outcome: 'succeeded' },
          },
        ],
        edges: [
          { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'agent-1' },
          { id: 'e2', source: 'agent-1', sourceHandle: 'next', target: 'end-1' },
        ],
      });
    }

    it('rejects malformed message entries before saving', async () => {
      await expect(saveWorkflow(withAgentMessages([{ role: 'user', content: '' }]))).rejects
        .toThrow(/messages\.0\.content must be non-empty/);
    });

    it('rejects a system message after the first turn', async () => {
      await expect(saveWorkflow(withAgentMessages([
        { role: 'user', content: 'first' },
        { role: 'system', content: 'later instruction' },
      ]))).rejects.toThrow(/only messages\.0 may use the system role/);
    });
  });
});

describe('saveWorkflow migration: legacy triggers[] → trigger-store', () => {
  // Inherits the global beforeEach/afterEach that set INFLOOP_WORKFLOWS_DIR=tmpDir.
  // This describe also sets up INFLOOP_TRIGGERS_DIR so the trigger-store has a
  // clean, isolated directory per test.
  let tmpTrDir: string;

  beforeEach(async () => {
    tmpTrDir = path.join(os.tmpdir(), `infinite-loop-wfstore-triggers-${process.pid}`);
    process.env.INFLOOP_TRIGGERS_DIR = tmpTrDir;
    await fsp.rm(tmpTrDir, { recursive: true, force: true });
    await fsp.mkdir(tmpTrDir, { recursive: true });
    const { triggerIndex } = await import('./trigger-index');
    triggerIndex.invalidate();
  });

  afterEach(async () => {
    await fsp.rm(tmpTrDir, { recursive: true, force: true });
    delete process.env.INFLOOP_TRIGGERS_DIR;
  });

  test('migrates legacy triggers on load and the in-memory workflow has them stripped', async () => {
    const triggerId = 'abcdefghijklmnopqrst01';
    // Drop a legacy workflow file with an embedded triggers[] array.
    const legacy = {
      id: 'wf-migrate',
      name: 'Migrate Me',
      version: 1,
      createdAt: 1,
      updatedAt: 2,
      nodes: [{ id: 's', type: 'start', position: { x: 0, y: 0 }, config: {} }],
      edges: [],
      triggers: [
        {
          id: triggerId,
          name: 'PR opened',
          enabled: true,
          match: [],
          inputs: {},
        },
      ],
    };
    fs.writeFileSync(path.join(tmpDir, 'wf-migrate.json'), JSON.stringify(legacy));

    const { getWorkflow: freshGetWorkflow } = await import('./workflow-store');
    const loaded = await freshGetWorkflow('wf-migrate');

    // The in-memory workflow should NOT have the triggers field.
    expect((loaded as unknown as { triggers?: unknown }).triggers).toBeUndefined();

    // The trigger should have been migrated into the trigger-store.
    const { getTrigger } = await import('./trigger-store');
    const migratedTrigger = await getTrigger(triggerId);
    expect(migratedTrigger.id).toBe(triggerId);
    expect(migratedTrigger.workflowId).toBe('wf-migrate');
    expect(migratedTrigger.pluginId).toBe('generic');

    // The migrated trigger file is written 0600, like every triggers/*.json.
    if (process.platform !== 'win32') {
      const st = await fsp.stat(path.join(tmpTrDir, `${triggerId}.json`));
      expect(st.mode & 0o777).toBe(0o600);
    }
  });

  test('migration is idempotent across multiple loads', async () => {
    const triggerId = 'abcdefghijklmnopqrst02';
    const legacy = {
      id: 'wf-idem',
      name: 'Idempotent',
      version: 1,
      createdAt: 1,
      updatedAt: 2,
      nodes: [{ id: 's', type: 'start', position: { x: 0, y: 0 }, config: {} }],
      edges: [],
      triggers: [
        {
          id: triggerId,
          name: 'Push',
          enabled: true,
          match: [],
          inputs: {},
        },
      ],
    };
    fs.writeFileSync(path.join(tmpDir, 'wf-idem.json'), JSON.stringify(legacy));

    const { getWorkflow: freshGetWorkflow } = await import('./workflow-store');

    // First load: migrates.
    await freshGetWorkflow('wf-idem');
    // Second load: should NOT throw and should still return triggers stripped.
    const second = await freshGetWorkflow('wf-idem');
    expect((second as unknown as { triggers?: unknown }).triggers).toBeUndefined();

    // Only one trigger entry should exist in the trigger-store.
    const { listTriggers } = await import('./trigger-store');
    const all = await listTriggers();
    expect(all.filter((t) => t.id === triggerId)).toHaveLength(1);
  });
});
