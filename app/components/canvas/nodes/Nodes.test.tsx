import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import type { ReactElement } from 'react';

import StartNode from './StartNode';
import EndNode from './EndNode';
import AgentNode from './AgentNode';
import BranchNode from './BranchNode';
import ConditionNode from './ConditionNode';
import LoopNode from './LoopNode';
import SidenoteNode from './SidenoteNode';
import StructuredOutputNode from './StructuredOutputNode';
import { refreshProviders } from '@/lib/client/use-providers';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // xyflow's <Handle> uses ResizeObserver under the hood; jsdom needs a polyfill.
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver =
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
  }
  if (!('DOMMatrixReadOnly' in globalThis)) {
    (globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly =
      class {
        m22 = 1;
        constructor() {}
      };
  }
  globalThis.fetch = (async () => ({
    json: async () => ({
      providers: [{
        id: 'northgate',
        label: 'NorthGate',
        description: 'OpenAI-compatible provider',
        transport: 'http',
        kind: 'openai-local',
        available: true,
        health: { status: 'unknown' },
      }],
    }),
  })) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Build a minimal NodeProps object. xyflow only forwards a subset of these to
 * the user component; the test components only read `data` and `selected`.
 */
function makeProps(
  data: Record<string, unknown>,
  overrides: Partial<NodeProps> = {}
): NodeProps {
  return {
    id: 'n1',
    type: 'start',
    data,
    selected: false,
    dragging: false,
    isConnectable: true,
    zIndex: 0,
    selectable: true,
    deletable: true,
    draggable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    ...overrides,
  } as NodeProps;
}

function renderWithFlow(ui: ReactElement) {
  return render(<ReactFlowProvider>{ui}</ReactFlowProvider>);
}

describe('node components', () => {
  it('StartNode renders with sample data', () => {
    renderWithFlow(<StartNode {...makeProps({ config: {} })} />);
    expect(screen.getByLabelText('start node')).toBeInTheDocument();
    expect(screen.getByText('begin')).toBeInTheDocument();
  });

  it('EndNode renders with outcome', () => {
    renderWithFlow(
      <EndNode
        {...makeProps({ config: { outcome: 'failed' } }, { type: 'end' })}
      />
    );
    expect(screen.getByLabelText('end node')).toBeInTheDocument();
    expect(screen.getByText(/→ failed/)).toBeInTheDocument();
  });

  it('AgentNode renders prompt preview truncated to 40 chars', () => {
    const longPrompt = 'a'.repeat(80);
    renderWithFlow(
      <AgentNode
        {...makeProps(
          {
            config: {
              providerId: 'claude',
              prompt: longPrompt,
              cwd: '/tmp',
              timeoutMs: 60000,
            },
          },
          { type: 'agent' }
        )}
      />
    );
    const card = screen.getByLabelText('agent node');
    expect(card).toBeInTheDocument();
    const body = card.querySelector('.wf-node-body');
    expect(body).not.toBeNull();
    // truncated -> 39 chars + ellipsis = 40 chars total.
    expect(body!.textContent!.length).toBeLessThanOrEqual(40);
    expect(body!.textContent).toContain('a');
    // The full prompt is exposed via title= so users can hover to peek
    // without opening the config panel.
    expect(body!.getAttribute('title')).toBe(longPrompt);
  });

  it('AgentNode does not set title when prompt fits without truncation', () => {
    renderWithFlow(
      <AgentNode
        {...makeProps(
          {
            config: {
              providerId: 'claude',
              prompt: 'short',
              cwd: '/tmp',
              timeoutMs: 60000,
            },
          },
          { type: 'agent' }
        )}
      />
    );
    const body = screen
      .getByLabelText('agent node')
      .querySelector('.wf-node-body');
    expect(body!.getAttribute('title')).toBeNull();
  });

  it('ConditionNode exposes full sentinel pattern via title when truncated', () => {
    const longPattern = 'X'.repeat(80);
    renderWithFlow(
      <ConditionNode
        {...makeProps(
          {
            config: {
              kind: 'sentinel',
              sentinel: { pattern: longPattern, isRegex: false },
            },
          },
          { type: 'condition' }
        )}
      />
    );
    const body = screen
      .getByLabelText('condition node')
      .querySelector('.wf-node-body');
    expect(body!.textContent!.length).toBeLessThanOrEqual(40);
    expect(body!.getAttribute('title')).toBe(`sentinel · ${longPattern}`);
  });

  it('BranchNode exposes full expression via title when truncated', () => {
    const longRhs = 'y'.repeat(80);
    renderWithFlow(
      <BranchNode
        {...makeProps(
          { config: { lhs: 'x', op: '==', rhs: longRhs } },
          { type: 'branch' }
        )}
      />
    );
    const body = screen
      .getByLabelText('branch node')
      .querySelector('.wf-node-body');
    expect(body!.textContent!.length).toBeLessThanOrEqual(40);
    expect(body!.getAttribute('title')).toBe(`x == ${longRhs}`);
  });

  it('ConditionNode does not set title when brief fits without truncation', () => {
    renderWithFlow(
      <ConditionNode
        {...makeProps(
          {
            config: {
              kind: 'sentinel',
              sentinel: { pattern: 'DONE', isRegex: false },
            },
          },
          { type: 'condition' }
        )}
      />
    );
    const body = screen
      .getByLabelText('condition node')
      .querySelector('.wf-node-body');
    expect(body!.getAttribute('title')).toBeNull();
  });

  it('AgentNode shows the providerId in the header', () => {
    renderWithFlow(
      <AgentNode
        {...makeProps(
          {
            config: {
              providerId: 'codex',
              prompt: 'hi',
              cwd: '/tmp',
              timeoutMs: 60000,
            },
          },
          { type: 'agent' }
        )}
      />
    );
    // Title is now the brand icon (a span with aria-label="<provider> agent")
    // instead of the provider name in caps.
    expect(screen.getByLabelText('codex agent')).toBeInTheDocument();
  });

  it('AgentNode defaults a global OpenAI provider title to its configured name', async () => {
    refreshProviders();
    renderWithFlow(
      <AgentNode
        {...makeProps(
          {
            config: {
              providerId: 'northgate',
              prompt: 'hi',
              cwd: '/tmp',
              timeoutMs: 60000,
            },
          },
          { type: 'agent' },
        )}
      />,
    );

    expect(await screen.findByLabelText('NorthGate (northgate agent)')).toBeInTheDocument();
  });

  it('ConditionNode renders kind brief', () => {
    renderWithFlow(
      <ConditionNode
        {...makeProps(
          {
            config: {
              kind: 'sentinel',
              sentinel: { pattern: 'DONE', isRegex: false },
            },
          },
          { type: 'condition' }
        )}
      />
    );
    expect(screen.getByText(/sentinel · DONE/)).toBeInTheDocument();
  });

  it('LoopNode renders maxIterations and mode', () => {
    renderWithFlow(
      <LoopNode
        {...makeProps(
          { config: { maxIterations: 5, mode: 'while-not-met' } },
          { type: 'loop' }
        )}
      />
    );
    expect(
      screen.getByText(/×5 · while-not-met/)
    ).toBeInTheDocument();
  });

  it('LoopNode renders ×∞ when infinite is true', () => {
    renderWithFlow(
      <LoopNode
        {...makeProps(
          { config: { maxIterations: 5, mode: 'unbounded', infinite: true } },
          { type: 'loop' }
        )}
      />
    );
    expect(
      screen.getByText(/×∞ · unbounded/)
    ).toBeInTheDocument();
  });

  it('propagates _state via data-state attribute (live)', () => {
    renderWithFlow(
      <AgentNode
        {...makeProps(
          {
            _state: 'live',
            config: { providerId: 'claude', prompt: 'p', cwd: '/tmp', timeoutMs: 60000 },
          },
          { type: 'agent' }
        )}
      />
    );
    const card = screen.getByLabelText('agent node');
    expect(card.getAttribute('data-state')).toBe('live');
    // also queryable by attribute selector
    expect(document.querySelector('[data-state="live"]')).not.toBeNull();
  });

  it('selected styling marks the card', () => {
    renderWithFlow(
      <StartNode {...makeProps({ config: {} }, { selected: true })} />
    );
    const card = screen.getByLabelText('start node');
    expect(card.getAttribute('data-selected')).toBe('true');
  });

  it('SidenoteNode renders text and exposes no connection handles', () => {
    renderWithFlow(
      <SidenoteNode
        {...makeProps(
          { config: { text: 'remember to bump max-iterations' } },
          { type: 'sidenote' }
        )}
      />
    );
    const card = screen.getByLabelText('sidenote');
    expect(card).toBeInTheDocument();
    expect(card.textContent).toContain('remember to bump max-iterations');
    // No source/target — the engine must never reach a sidenote.
    expect(card.querySelector('.react-flow__handle')).toBeNull();
  });

  it('SidenoteNode renders a placeholder when text is empty', () => {
    renderWithFlow(
      <SidenoteNode
        {...makeProps({ config: { text: '' } }, { type: 'sidenote' })}
      />
    );
    expect(screen.getByText('(empty note)')).toBeInTheDocument();
  });

  it('SidenoteNode does not propagate _state — it never runs', () => {
    renderWithFlow(
      <SidenoteNode
        {...makeProps(
          { _state: 'live', config: { text: 'x' } },
          { type: 'sidenote' }
        )}
      />
    );
    const card = screen.getByLabelText('sidenote');
    // The node doesn't render a state dot, and we don't surface
    // `data-state` because the engine cannot reach it (no handles).
    expect(card.getAttribute('data-state')).toBeNull();
  });

  it('OpenAI node previews its prompt and exposes next / error handles', () => {
    renderWithFlow(
      <StructuredOutputNode
        {...makeProps(
          { config: { providerId: 'test-http', profile: 'model-a', prompt: 'return a typed answer' } },
          { type: 'structured-output' },
        )}
      />,
    );
    const card = screen.getByLabelText('OpenAI node');
    expect(card).toHaveTextContent('OPENAI');
    expect(card).toHaveTextContent('model-a');
    expect(card).toHaveTextContent('return a typed answer');
    expect(card.querySelector('[data-handleid="next"]')).not.toBeNull();
    expect(card.querySelector('[data-handleid="error"]')).not.toBeNull();
  });

  it('ConditionNode exposes met / not_met / error handle ids', () => {
    renderWithFlow(
      <ConditionNode
        {...makeProps(
          {
            config: {
              kind: 'sentinel',
              sentinel: { pattern: 'DONE', isRegex: false },
            },
          },
          { type: 'condition' }
        )}
      />
    );
    const card = screen.getByLabelText('condition node');
    expect(card.querySelector('[data-handleid="met"]')).not.toBeNull();
    expect(card.querySelector('[data-handleid="not_met"]')).not.toBeNull();
    expect(card.querySelector('[data-handleid="error"]')).not.toBeNull();
  });
});
