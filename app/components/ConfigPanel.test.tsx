import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import FakeTimers, { type InstalledClock } from '@sinonjs/fake-timers';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useWorkflowStore } from '@/lib/client/workflow-store-client';
import type { Workflow, WorkflowInputDecl, WorkflowNode } from '@/lib/shared/workflow';
import { validateAgentOutputs } from '@/lib/shared/workflow';
import ConfigPanel from './ConfigPanel';

function makeWorkflow(nodes: WorkflowNode[]): Workflow {
  return {
    id: 'wf-test',
    name: 'Test',
    version: 1,
    nodes,
    edges: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

const startNode: WorkflowNode = {
  id: 'start-1',
  type: 'start',
  position: { x: 0, y: 0 },
  config: {},
};

const agentNode: WorkflowNode = {
  id: 'agent-1',
  type: 'agent',
  position: { x: 0, y: 0 },
  config: { providerId: 'claude', prompt: 'hello', cwd: '/tmp', timeoutMs: 60000 },
};

const conditionNode: WorkflowNode = {
  id: 'cond-1',
  type: 'condition',
  position: { x: 0, y: 0 },
  config: { kind: 'sentinel', sentinel: { pattern: 'OK', isRegex: false } },
};

const loopNode: WorkflowNode = {
  id: 'loop-1',
  type: 'loop',
  position: { x: 0, y: 0 },
  config: { maxIterations: 5, mode: 'while-not-met' },
  children: [],
};

function reset() {
  useWorkflowStore.setState({
    currentWorkflow: null,
    isDirty: false,
    selectedNodeId: null,
    runStatus: 'idle',
    runEvents: [],
  });
}

/** Stand-in for the panel's `/api/providers` probe so tests can pin a
 * specific transport (CLI vs HTTP) — without this, fetch fails with
 * NotSupportedError under happy-dom and `providerInfo` ends up `null`,
 * which collapses `isHttpProvider` to a false default. */
type StubProvider = { id: string; label?: string; transport: 'cli' | 'http' };
function mockProvidersFetch(providers: StubProvider[]) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/providers')) {
      return new Response(JSON.stringify({ providers }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // Anything else (e.g. `/api/providers/<id>/agents`) just 404s — the
    // panel handles that path silently.
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

describe('ConfigPanel', () => {
  let clock: InstalledClock | null = null;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    reset();
    // Default: claude is a CLI provider. Tests that need HTTP override.
    mockProvidersFetch([{ id: 'claude', transport: 'cli' }]);
  });

  afterEach(() => {
    cleanup();
    if (clock) {
      clock.uninstall();
      clock = null;
    }
    globalThis.fetch = originalFetch;
    reset();
  });

  it('renders the empty placeholder when no workflow is loaded', () => {
    render(<ConfigPanel />);
    expect(screen.getByLabelText('config panel')).toBeInTheDocument();
    // Without a workflow, the panel prompts the user to open one.
    expect(
      screen.getByText(/open a workflow to configure/i),
    ).toBeInTheDocument();
  });

  it('renders the workflow globals editor when a workflow is loaded but no node is selected', () => {
    const wf = makeWorkflow([startNode]);
    act(() => {
      useWorkflowStore.getState().loadWorkflow(wf);
      useWorkflowStore.getState().selectNode(null);
    });
    render(<ConfigPanel />);
    expect(screen.getByText(/workflow · globals/i)).toBeInTheDocument();
    expect(screen.getByText(/\{\{globals\.NAME\}\}/)).toBeInTheDocument();
  });

  it('renders Agent config fields when an Agent node is selected', () => {
    const wf = makeWorkflow([startNode, agentNode]);
    act(() => {
      useWorkflowStore.getState().loadWorkflow(wf);
      useWorkflowStore.getState().selectNode('agent-1');
    });

    render(<ConfigPanel />);

    expect(screen.getByLabelText('Prompt')).toBeInTheDocument();
    expect(screen.getByLabelText('Working directory')).toBeInTheDocument();
    expect(screen.getByLabelText('Iteration timeout')).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Iteration timeout unit' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Provider')).toHaveTextContent('claude');
    // header shows id + type
    expect(screen.getByText(/agent-1 · agent/)).toBeInTheDocument();
  });

  it('debounces edits to the Agent prompt and dispatches updateNode', () => {
    clock = FakeTimers.install();
    const wf = makeWorkflow([startNode, agentNode]);
    act(() => {
      useWorkflowStore.getState().loadWorkflow(wf);
      useWorkflowStore.getState().selectNode('agent-1');
    });

    render(<ConfigPanel />);

    const promptField = screen.getByLabelText('Prompt') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(promptField, { target: { value: 'updated prompt' } });
    });

    // Before the debounce timer fires, the store has not been updated.
    let stored = useWorkflowStore.getState().currentWorkflow!.nodes.find(
      (n) => n.id === 'agent-1',
    )!.config as { prompt: string };
    expect(stored.prompt).toBe('hello');

    act(() => {
      clock!.tick(300);
    });

    stored = useWorkflowStore.getState().currentWorkflow!.nodes.find(
      (n) => n.id === 'agent-1',
    )!.config as { prompt: string };
    expect(stored.prompt).toBe('updated prompt');
  });

  it('flushes a pending debounced edit when the selected node changes', () => {
    clock = FakeTimers.install();
    const wf = makeWorkflow([startNode, agentNode]);
    act(() => {
      useWorkflowStore.getState().loadWorkflow(wf);
      useWorkflowStore.getState().selectNode('agent-1');
    });

    render(<ConfigPanel />);

    const promptField = screen.getByLabelText('Prompt') as HTMLTextAreaElement;
    act(() => {
      fireEvent.change(promptField, { target: { value: 'switch-safe prompt' } });
    });

    let stored = useWorkflowStore.getState().currentWorkflow!.nodes.find(
      (n) => n.id === 'agent-1',
    )!.config as { prompt: string };
    expect(stored.prompt).toBe('hello');

    act(() => {
      useWorkflowStore.getState().selectNode('start-1');
    });

    stored = useWorkflowStore.getState().currentWorkflow!.nodes.find(
      (n) => n.id === 'agent-1',
    )!.config as { prompt: string };
    expect(stored.prompt).toBe('switch-safe prompt');
  });

  it('renders the Agent outputs editor and commits a new row through to config.outputs', () => {
    clock = FakeTimers.install();
    const wf = makeWorkflow([startNode, agentNode]);
    act(() => {
      useWorkflowStore.getState().loadWorkflow(wf);
      useWorkflowStore.getState().selectNode('agent-1');
    });

    render(<ConfigPanel />);

    // No declared outputs yet — just the empty editor with an add button.
    expect(
      screen.queryByLabelText('agent output name 0'),
    ).not.toBeInTheDocument();

    const addBtn = screen.getByRole('button', { name: /\+ add output/i });
    act(() => {
      fireEvent.click(addBtn);
    });

    const nameField = screen.getByLabelText('agent output name 0') as HTMLInputElement;
    const descField = screen.getByLabelText(
      'agent output description 0',
    ) as HTMLInputElement;
    act(() => {
      fireEvent.change(nameField, { target: { value: 'PR_LINK' } });
      // Whitespace-only description must be omitted on the wire, not stored
      // as `description: "   "` — keeps the saved shape canonical and
      // matches what `validateAgentOutputs` (and a hand-written JSON file)
      // expects.
      fireEvent.change(descField, { target: { value: '   ' } });
    });

    // Pre-debounce: store still has no outputs key.
    let stored = useWorkflowStore.getState().currentWorkflow!.nodes.find(
      (n) => n.id === 'agent-1',
    )!.config as { outputs?: { name: string; description?: string }[] };
    expect(stored.outputs).toBeUndefined();

    act(() => {
      clock!.tick(300);
    });

    stored = useWorkflowStore.getState().currentWorkflow!.nodes.find(
      (n) => n.id === 'agent-1',
    )!.config as { outputs?: { name: string; description?: string }[] };
    expect(stored.outputs).toEqual([{ name: 'PR_LINK' }]);
    // And the canonical shape must pass server-side validation. This is
    // the round-trip contract that justifies the editor existing at all.
    expect(() => validateAgentOutputs(stored.outputs, 'agent-1')).not.toThrow();
  });

  it('warns inline when two Agent output rows declare the same name', () => {
    clock = FakeTimers.install();
    const wf = makeWorkflow([startNode, agentNode]);
    act(() => {
      useWorkflowStore.getState().loadWorkflow(wf);
      useWorkflowStore.getState().selectNode('agent-1');
    });

    render(<ConfigPanel />);

    const addBtn = screen.getByRole('button', { name: /\+ add output/i });
    act(() => {
      fireEvent.click(addBtn);
      fireEvent.click(addBtn);
    });

    const name0 = screen.getByLabelText('agent output name 0') as HTMLInputElement;
    const name1 = screen.getByLabelText('agent output name 1') as HTMLInputElement;
    act(() => {
      fireEvent.change(name0, { target: { value: 'PR_LINK' } });
      fireEvent.change(name1, { target: { value: 'PR_LINK' } });
    });
    act(() => {
      clock!.tick(300);
    });

    // Both rows render the warning — duplicate detection is symmetric. We
    // assert "at least two" rather than exact so future copy tweaks don't
    // break this for cosmetic reasons.
    expect(screen.getAllByText(/duplicate name "PR_LINK"/i)).toHaveLength(2);
  });

  it('canonicalizes config.outputs back to undefined when the last row is removed', () => {
    clock = FakeTimers.install();
    const agentWithOutputs: WorkflowNode = {
      ...agentNode,
      config: {
        ...(agentNode.config as Record<string, unknown>),
        outputs: [{ name: 'PR_LINK' }],
      },
    };
    const wf = makeWorkflow([startNode, agentWithOutputs]);
    act(() => {
      useWorkflowStore.getState().loadWorkflow(wf);
      useWorkflowStore.getState().selectNode('agent-1');
    });

    render(<ConfigPanel />);

    const removeBtn = screen.getByRole('button', {
      name: 'remove agent output 0',
    });
    act(() => {
      fireEvent.click(removeBtn);
    });

    // Remove is a synchronous commit (no per-row debounce on the button),
    // so the store should reflect the change immediately.
    const stored = useWorkflowStore.getState().currentWorkflow!.nodes.find(
      (n) => n.id === 'agent-1',
    )!.config as { outputs?: unknown };
    // Strict undefined, not []. Empty arrays would still validate, but the
    // canonical "no outputs declared" shape is the absent key — matches a
    // freshly-created agent node and keeps workflow diffs clean.
    expect(stored.outputs).toBeUndefined();
  });

  it('hides the Agent outputs editor for HTTP-transport providers', async () => {
    // Override the default CLI claude provider with an HTTP one matching
    // the node's providerId — the editor section is gated on transport.
    mockProvidersFetch([{ id: 'claude', transport: 'http' }]);

    const wf = makeWorkflow([startNode, agentNode]);
    act(() => {
      useWorkflowStore.getState().loadWorkflow(wf);
      useWorkflowStore.getState().selectNode('agent-1');
    });

    render(<ConfigPanel />);

    // Wait a tick for the providers fetch to settle and re-render with
    // `isHttpProvider === true`. (Real fetch is sync-resolved here because
    // the mock returns immediately, but the effect that consumes it still
    // needs a microtask to flush.)
    await new Promise((r) => setTimeout(r, 0));

    expect(
      screen.queryByRole('button', { name: /\+ add output/i }),
    ).not.toBeInTheDocument();
  });

  it('pre-populates the Agent outputs editor with existing declared rows', () => {
    const agentWithOutputs: WorkflowNode = {
      ...agentNode,
      config: {
        ...(agentNode.config as Record<string, unknown>),
        outputs: [
          { name: 'PR_LINK', description: 'URL of the opened PR' },
          { name: 'PR_ID' },
        ],
      },
    };
    const wf = makeWorkflow([startNode, agentWithOutputs]);
    act(() => {
      useWorkflowStore.getState().loadWorkflow(wf);
      useWorkflowStore.getState().selectNode('agent-1');
    });

    render(<ConfigPanel />);

    const name0 = screen.getByLabelText('agent output name 0') as HTMLInputElement;
    const desc0 = screen.getByLabelText('agent output description 0') as HTMLInputElement;
    const name1 = screen.getByLabelText('agent output name 1') as HTMLInputElement;
    const desc1 = screen.getByLabelText('agent output description 1') as HTMLInputElement;
    expect(name0.value).toBe('PR_LINK');
    expect(desc0.value).toBe('URL of the opened PR');
    expect(name1.value).toBe('PR_ID');
    expect(desc1.value).toBe('');
  });

  it('warns inline when an Agent output name collides with a reserved runtime field', () => {
    clock = FakeTimers.install();
    const wf = makeWorkflow([startNode, agentNode]);
    act(() => {
      useWorkflowStore.getState().loadWorkflow(wf);
      useWorkflowStore.getState().selectNode('agent-1');
    });

    render(<ConfigPanel />);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /\+ add output/i }));
    });
    const nameField = screen.getByLabelText('agent output name 0') as HTMLInputElement;
    act(() => {
      fireEvent.change(nameField, { target: { value: 'stdout' } });
    });
    // Warning is computed from committed row state, so it appears after debounce.
    act(() => {
      clock!.tick(300);
    });

    expect(
      screen.getByText(/"stdout" is reserved by the agent runtime/i),
    ).toBeInTheDocument();
  });

  it('shows the sentinel pattern by default and switches to command on segment click', () => {
    const wf = makeWorkflow([startNode, conditionNode]);
    act(() => {
      useWorkflowStore.getState().loadWorkflow(wf);
      useWorkflowStore.getState().selectNode('cond-1');
    });

    render(<ConfigPanel />);

    expect(screen.getByLabelText('Pattern')).toBeInTheDocument();
    expect(screen.queryByLabelText('Command')).not.toBeInTheDocument();

    const commandBtn = screen.getByRole('button', { name: 'Command' });
    act(() => {
      fireEvent.click(commandBtn);
    });

    expect(screen.getByLabelText('Command')).toBeInTheDocument();
    expect(screen.queryByLabelText('Pattern')).not.toBeInTheDocument();

    // Store reflects the kind change immediately (segmented controls fire sync).
    const stored = useWorkflowStore.getState().currentWorkflow!.nodes.find(
      (n) => n.id === 'cond-1',
    )!.config as { kind: string };
    expect(stored.kind).toBe('command');
  });

  it('renders Loop max iterations and mode controls', () => {
    const wf = makeWorkflow([loopNode]);
    act(() => {
      useWorkflowStore.getState().loadWorkflow(wf);
      useWorkflowStore.getState().selectNode('loop-1');
    });

    render(<ConfigPanel />);

    expect(screen.getByLabelText('Max iterations')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Mode' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'While not met' }),
    ).toHaveAttribute('data-active', 'true');
  });

  it('Loop infinite toggle hides Max iterations and persists infinite=true', () => {
    const wf = makeWorkflow([loopNode]);
    act(() => {
      useWorkflowStore.getState().loadWorkflow(wf);
      useWorkflowStore.getState().selectNode('loop-1');
    });

    render(<ConfigPanel />);

    // Bounded by default → Max iterations input is rendered.
    expect(screen.getByLabelText('Max iterations')).toBeInTheDocument();

    const infiniteBtn = screen.getByRole('button', { name: 'Infinite ∞' });
    act(() => {
      fireEvent.click(infiniteBtn);
    });

    // Input disappears, store records infinite: true.
    expect(screen.queryByLabelText('Max iterations')).not.toBeInTheDocument();
    const stored = useWorkflowStore.getState().currentWorkflow!.nodes.find(
      (n) => n.id === 'loop-1',
    )!.config as { infinite?: boolean };
    expect(stored.infinite).toBe(true);

    // Toggle back to Bounded restores the input and flips the flag.
    const boundedBtn = screen.getByRole('button', { name: 'Bounded' });
    act(() => {
      fireEvent.click(boundedBtn);
    });
    expect(screen.getByLabelText('Max iterations')).toBeInTheDocument();
    const stored2 = useWorkflowStore.getState().currentWorkflow!.nodes.find(
      (n) => n.id === 'loop-1',
    )!.config as { infinite?: boolean };
    expect(stored2.infinite).toBe(false);
  });

  it('Start node shows the workflow inputs editor', () => {
    const wf = makeWorkflow([startNode]);
    act(() => {
      useWorkflowStore.getState().loadWorkflow(wf);
      useWorkflowStore.getState().selectNode('start-1');
    });

    render(<ConfigPanel />);

    // The inputs editor is rendered for the Begin node.
    expect(screen.getByRole('button', { name: /add input/i })).toBeInTheDocument();
    // Display name (renames the canvas card title) is shared across all node types.
    expect(screen.getByLabelText('Display name')).toBeInTheDocument();
    // With no declared inputs, no extra textboxes beyond Display name.
    expect(screen.queryAllByRole('textbox')).toHaveLength(1);
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  it('finds nodes inside Loop containers (children)', () => {
    const childAgent: WorkflowNode = {
      id: 'agent-inside-loop',
      type: 'agent',
      position: { x: 0, y: 0 },
      config: { providerId: 'claude', prompt: 'inner', cwd: '/work', timeoutMs: 30000 },
    };
    const wf = makeWorkflow([
      startNode,
      { ...loopNode, children: [childAgent] },
    ]);
    act(() => {
      useWorkflowStore.getState().loadWorkflow(wf);
      useWorkflowStore.getState().selectNode('agent-inside-loop');
    });

    render(<ConfigPanel />);

    expect(screen.getByLabelText('Prompt')).toHaveValue('inner');
    // cwd field is a read-only div now (so CSS can truncate from the start
    // and show the tail of long paths) — assert text content, not value.
    expect(screen.getByLabelText('Working directory')).toHaveTextContent(
      '/work',
    );
  });

  it('renders existing declared inputs as rows', () => {
    const inputs: WorkflowInputDecl[] = [
      { name: 'topic', type: 'string', default: 'cats' },
      { name: 'count', type: 'number' },
    ];
    const wf: Workflow = { ...makeWorkflow([startNode]), inputs };
    act(() => {
      useWorkflowStore.getState().loadWorkflow(wf);
      useWorkflowStore.getState().selectNode('start-1');
    });

    render(<ConfigPanel />);

    expect(screen.getByDisplayValue('topic')).toBeInTheDocument();
    expect(screen.getByDisplayValue('count')).toBeInTheDocument();
  });

  it('lets the user add a new input row', () => {
    const wf: Workflow = { ...makeWorkflow([startNode]), inputs: [] };
    act(() => {
      useWorkflowStore.getState().loadWorkflow(wf);
      useWorkflowStore.getState().selectNode('start-1');
    });

    render(<ConfigPanel />);

    const addBtn = screen.getByRole('button', { name: /add input/i });
    act(() => {
      fireEvent.click(addBtn);
    });

    // After clicking add, at least one name input field should exist.
    const nameInputs = screen
      .getAllByRole('textbox')
      .filter((el) => (el as HTMLInputElement).placeholder === 'name');
    expect(nameInputs.length).toBeGreaterThan(0);
  });

  it('surfaces duplicate-name validation', () => {
    const inputs: WorkflowInputDecl[] = [
      { name: 'topic', type: 'string' },
      { name: 'topic', type: 'number' },
    ];
    const wf: Workflow = { ...makeWorkflow([startNode]), inputs };
    act(() => {
      useWorkflowStore.getState().loadWorkflow(wf);
      useWorkflowStore.getState().selectNode('start-1');
    });

    render(<ConfigPanel />);

    expect(screen.getAllByText(/duplicate name/i).length).toBeGreaterThan(0);
  });
});
