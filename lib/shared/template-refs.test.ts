import { describe, expect, it } from 'bun:test';
import {
  availableVariables,
  isKnownRef,
  lintField,
  lintWorkflowTemplates,
  reachablePredecessors,
} from './template-refs';
import { findTemplateSlot } from '../../app/components/TemplateField';
import type { Workflow } from './workflow';

const baseWorkflow: Workflow = {
  id: 'wf',
  name: 'wf',
  version: 1,
  createdAt: 0,
  updatedAt: 0,
  // A linear chain: start-1 → claude-1 → script-1 → cond-1
  edges: [
    { id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'claude-1' },
    { id: 'e2', source: 'claude-1', sourceHandle: 'next', target: 'script-1' },
    { id: 'e3', source: 'script-1', sourceHandle: 'next', target: 'cond-1' },
  ],
  nodes: [
    { id: 'start-1', type: 'start', position: { x: 0, y: 0 }, config: {} },
    {
      id: 'claude-1',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { providerId: 'claude', prompt: '', cwd: '/tmp', timeoutMs: 1000 },
    },
    {
      id: 'script-1',
      type: 'script',
      position: { x: 0, y: 0 },
      config: {
        language: 'ts',
        inputs: { arg1: '{{claude-1.stdout}}' },
        outputs: ['greeting', 'count'],
        code: 'function run(a) { return { greeting: a }; }',
      },
    },
    {
      id: 'cond-1',
      type: 'condition',
      position: { x: 0, y: 0 },
      config: {
        kind: 'sentinel',
        against: '{{claude-1.stdout}}',
        sentinel: { pattern: 'DONE', isRegex: false },
      },
    },
  ],
};

describe('availableVariables', () => {
  it('exposes static fields per node type', () => {
    const refs = availableVariables(baseWorkflow, '__none__');
    const claudeRefs = refs.filter((r) => r.nodeId === 'claude-1').map((r) => r.field);
    expect(claudeRefs).toEqual(
      expect.arrayContaining(['stdout', 'stderr', 'exitCode', 'durationMs', 'timedOut']),
    );
  });

  it('includes declared script outputs as dynamic fields', () => {
    const refs = availableVariables(baseWorkflow, '__none__');
    const fields = refs.filter((r) => r.nodeId === 'script-1').map((r) => r.field);
    expect(fields).toEqual(expect.arrayContaining(['greeting', 'count', 'stdout', 'language']));
  });

  it('excludes the self id', () => {
    const refs = availableVariables(baseWorkflow, 'claude-1');
    expect(refs.some((r) => r.nodeId === 'claude-1')).toBe(false);
  });

  it('returns an empty list for null workflow', () => {
    expect(availableVariables(null, 'x')).toEqual([]);
  });
});

describe('isKnownRef', () => {
  it('matches declared static + dynamic refs', () => {
    expect(isKnownRef(baseWorkflow, 'claude-1.stdout')).toBe(true);
    expect(isKnownRef(baseWorkflow, 'script-1.greeting')).toBe(true);
  });
  it('rejects unknown refs', () => {
    expect(isKnownRef(baseWorkflow, 'claude-1.totally-fake')).toBe(false);
    expect(isKnownRef(baseWorkflow, 'no-such-node.stdout')).toBe(false);
  });
});

describe('reachablePredecessors', () => {
  it('walks edges backward to collect upstream nodes', () => {
    const preds = reachablePredecessors(baseWorkflow, 'cond-1');
    expect(Array.from(preds).sort()).toEqual(['claude-1', 'script-1', 'start-1']);
  });

  it('returns an empty set for the entry node', () => {
    const preds = reachablePredecessors(baseWorkflow, 'start-1');
    expect(preds.size).toBe(0);
  });

  it('treats disconnected siblings as not-predecessors', () => {
    const wf: Workflow = {
      ...baseWorkflow,
      nodes: [
        ...baseWorkflow.nodes,
        {
          id: 'orphan-1',
          type: 'agent',
          position: { x: 0, y: 0 },
          config: { providerId: 'claude', prompt: '', cwd: '/tmp', timeoutMs: 1000 },
        },
      ],
    };
    const preds = reachablePredecessors(wf, 'cond-1');
    expect(preds.has('orphan-1')).toBe(false);
  });
});

describe('availableVariables — scope flags', () => {
  it('marks upstream refs in-scope and others out-of-scope', () => {
    const refs = availableVariables(baseWorkflow, 'claude-1');
    const claudeIn = refs.find((r) => r.ref === 'claude-1.stdout');
    expect(claudeIn).toBeUndefined(); // self-ref excluded
    const scriptOut = refs.find((r) => r.ref === 'script-1.greeting');
    // script-1 is downstream of claude-1, so it's NOT a predecessor.
    expect(scriptOut?.inScope).toBe(false);
    const startIn = refs.find((r) => r.nodeId === 'start-1');
    // start-1 has no outputs, so no refs at all.
    expect(startIn).toBeUndefined();
  });

  it('surfaces workflow globals at the top of the list', () => {
    const wf: Workflow = {
      ...baseWorkflow,
      globals: { API_URL: 'https://x.test', TOKEN: 's3cret' },
    };
    const refs = availableVariables(wf, 'claude-1');
    expect(refs[0].ref).toBe('globals.API_URL');
    expect(refs[0].kind).toBe('global');
    expect(refs[0].inScope).toBe(true);
  });
});

describe('lintField', () => {
  it('returns no warnings for valid refs', () => {
    expect(lintField(baseWorkflow, 'cond-1', 'against', '{{claude-1.stdout}}')).toEqual([]);
  });

  it('flags unknown node refs', () => {
    const warnings = lintField(
      baseWorkflow,
      'script-1',
      'inputs.arg1',
      '{{ghost-node.stdout}}',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toBe('unknown');
    expect(warnings[0].ref).toBe('ghost-node.stdout');
  });

  it('flags missing fields on known nodes', () => {
    const warnings = lintField(
      baseWorkflow,
      'script-1',
      'inputs.arg1',
      '{{claude-1.notarealfield}}',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toBe('missing-field');
  });

  it('flags self-references', () => {
    const warnings = lintField(
      baseWorkflow,
      'script-1',
      'inputs.arg1',
      '{{script-1.greeting}}',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toBe('self-ref');
  });

  it('flags refs to downstream nodes as out-of-scope', () => {
    // claude-1 references script-1, which runs AFTER claude-1 — at the
    // time the templating resolves, script-1's outputs don't exist yet.
    const warnings = lintField(
      baseWorkflow,
      'claude-1',
      'prompt',
      '{{script-1.greeting}}',
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toBe('out-of-scope');
  });

  it('flags refs to disconnected nodes as out-of-scope', () => {
    const wf: Workflow = {
      ...baseWorkflow,
      nodes: [
        ...baseWorkflow.nodes,
        {
          id: 'orphan-1',
          type: 'agent',
          position: { x: 0, y: 0 },
          config: { providerId: 'claude', prompt: '', cwd: '/tmp', timeoutMs: 1000 },
        },
      ],
    };
    const warnings = lintField(wf, 'cond-1', 'against', '{{orphan-1.stdout}}');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toBe('out-of-scope');
  });

  it('accepts {{globals.NAME}} when the global is declared', () => {
    const wf: Workflow = { ...baseWorkflow, globals: { API_URL: 'https://x' } };
    expect(lintField(wf, 'claude-1', 'prompt', '{{globals.API_URL}}')).toEqual([]);
  });

  it('flags missing globals', () => {
    const wf: Workflow = { ...baseWorkflow, globals: { API_URL: 'https://x' } };
    const warnings = lintField(wf, 'claude-1', 'prompt', '{{globals.MISSING}}');
    expect(warnings).toHaveLength(1);
    expect(warnings[0].reason).toBe('missing-global');
  });

  it('does not lint the __inputs virtual scope', () => {
    expect(
      lintField(baseWorkflow, 'script-1', 'inputs.arg1', '{{__inputs.task}}'),
    ).toEqual([]);
  });

  it('handles multiple refs in one field', () => {
    const warnings = lintField(
      baseWorkflow,
      'script-1',
      'inputs.arg1',
      '{{claude-1.stdout}} and {{ghost.stdout}} and {{claude-1.fake}}',
    );
    expect(warnings.map((w) => w.reason)).toEqual(['unknown', 'missing-field']);
  });
});

describe('lintWorkflowTemplates', () => {
  it('walks every templated field across all nodes', () => {
    const bad: Workflow = {
      ...baseWorkflow,
      nodes: [
        ...baseWorkflow.nodes,
        {
          id: 'branch-1',
          type: 'branch',
          position: { x: 0, y: 0 },
          config: { lhs: '{{claude-1.stdout}}', op: '==', rhs: '{{ghost.x}}' },
        },
      ],
    };
    const warnings = lintWorkflowTemplates(bad);
    const refs = warnings.map((w) => `${w.nodeId}:${w.field}:${w.ref}`);
    expect(refs).toEqual(
      expect.arrayContaining(['branch-1:rhs:ghost.x']),
    );
  });
});

describe('availableVariables — workflow inputs', () => {
  it('surfaces declared inputs at the top of the list', () => {
    const wf: Workflow = {
      ...baseWorkflow,
      inputs: [
        { name: 'topic', type: 'string' },
        { name: 'max', type: 'number', default: 5 },
      ],
    };
    const refs = availableVariables(wf, 'claude-1');
    const inputRefs = refs.filter((r) => r.nodeId === 'inputs');
    expect(inputRefs.map((r) => r.ref)).toEqual([
      'inputs.topic',
      'inputs.max',
    ]);
    expect(inputRefs.every((r) => r.inScope)).toBe(true);
  });
});

describe('lintField — workflow inputs', () => {
  it('reports missing-input for undeclared input refs', () => {
    const wf: Workflow = { ...baseWorkflow, inputs: [{ name: 'topic', type: 'string' }] };
    const warnings = lintField(wf, 'claude-1', 'prompt', '{{inputs.unknown}}');
    expect(warnings.map((w) => w.reason)).toEqual(['missing-input']);
  });

  it('accepts declared input refs', () => {
    const wf: Workflow = { ...baseWorkflow, inputs: [{ name: 'topic', type: 'string' }] };
    const warnings = lintField(wf, 'claude-1', 'prompt', '{{inputs.topic}}');
    expect(warnings).toEqual([]);
  });
});

describe('findTemplateSlot', () => {
  it('returns the slot when caret sits inside open braces', () => {
    // Text: "hello {{x.y}} world", caret right after "{{"
    const slot = findTemplateSlot('hello {{x.y}} world', 8);
    expect(slot).not.toBeNull();
    expect(slot!.prefix).toBe('');
  });

  it('captures the in-slot prefix as the user types', () => {
    // Text: "{{cla", caret at end
    const slot = findTemplateSlot('{{cla', 5);
    expect(slot).not.toBeNull();
    expect(slot!.prefix).toBe('cla');
    expect(slot!.hasClose).toBe(false);
  });

  it('returns null when the caret is outside any braces', () => {
    expect(findTemplateSlot('plain text', 4)).toBeNull();
    expect(findTemplateSlot('{{x.y}} done', 11)).toBeNull();
  });
});
