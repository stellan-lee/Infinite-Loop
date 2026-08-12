import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import Palette from './Palette';

const PROVIDERS = [
  { id: 'claude', label: 'Claude', description: 'spawn claude --print', glyph: '⟳' },
  { id: 'codex', label: 'Codex', description: 'spawn codex exec', glyph: '◈' },
];

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = mock(async (url: string | URL | Request) => {
    if (String(url).endsWith('/api/providers')) {
      return new Response(JSON.stringify({ providers: PROVIDERS }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('Palette', () => {
  it('renders the static (non-provider) draggable node items', () => {
    render(<Palette />);

    const types = ['start', 'end', 'loop', 'condition', 'structured-output'] as const;
    for (const t of types) {
      const item = screen.getByRole('button', { name: `add ${t} node` });
      expect(item).toBeInTheDocument();
      expect(item).toHaveAttribute('draggable', 'true');
    }
  });

  it('uses the OpenAI name while retaining the persisted structured-output node type', () => {
    render(<Palette />);
    expect(screen.getByRole('button', { name: 'add structured-output node' })).toHaveTextContent('OpenAI');
  });

  it('renders provider-management actions as text links, not ghost buttons', () => {
    render(<Palette />);

    for (const name of ['manage OpenAI providers', 'manage hermes connections']) {
      const action = screen.getByRole('button', { name });
      expect(action).toHaveClass('palette-manage');
      expect(action).not.toHaveClass('btn', 'btn-ghost');
    }
  });

  it('renders Control and Model Runners category headings', async () => {
    render(<Palette />);

    expect(screen.getByRole('heading', { name: /control/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /model runners/i })).toBeInTheDocument();
    // Provider list is fetched async — wait for them.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'add claude agent node' }),
      ).toBeInTheDocument();
    });
  });

  it('dragStart on the Claude provider writes type:"agent" + providerId:"claude"', async () => {
    render(<Palette />);

    const claudeItem = await waitFor(() =>
      screen.getByRole('button', { name: 'add claude agent node' }),
    );

    const dataTransfer = {
      setData: mock(),
    };

    fireEvent.dragStart(claudeItem, { dataTransfer });

    // @testing-library/dom rebuilds the dataTransfer through happy-dom's
    // DataTransfer constructor and copies our properties as non-writable
    // descriptors, so the component's later `effectAllowed = 'copy'`
    // assignment is a silent no-op under happy-dom. The setData payload —
    // the actual dnd contract — still propagates correctly.
    expect(dataTransfer.setData).toHaveBeenCalledTimes(1);
    const [mime, payload] = dataTransfer.setData.mock.calls[0];
    expect(mime).toBe('application/x-infinite-loop-node');
    expect(JSON.parse(payload)).toEqual({ type: 'agent', providerId: 'claude' });
  });

  it('labels an unavailable runner within its palette row', async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        providers: [{
          id: 'claude',
          label: 'Claude',
          description: 'spawn claude --print',
          available: false,
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ) as unknown as typeof fetch;

    render(<Palette />);

    const claudeItem = await waitFor(() =>
      screen.getByRole('button', { name: 'add claude agent node' }),
    );
    expect(claudeItem).toBeDisabled();
    expect(claudeItem).toHaveTextContent('Not available');
    expect(claudeItem).not.toHaveTextContent('missing');
  });

  it('keeps every palette item in the natural tab order', () => {
    render(<Palette />);

    const types = ['start', 'end', 'loop', 'condition'] as const;
    for (const t of types) {
      const item = screen.getByRole('button', { name: `add ${t} node` });
      const tabIndex = item.getAttribute('tabindex');
      expect(tabIndex === null || Number(tabIndex) >= 0).toBe(true);
    }
  });

  it('filters node rows and focuses search with the displayed keyboard shortcut', () => {
    render(<Palette />);

    const search = screen.getByRole('searchbox', { name: 'Search nodes' });
    fireEvent.change(search, { target: { value: 'condition' } });

    expect(screen.getByRole('button', { name: 'add condition node' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'add start node' })).toBeNull();

    (search as HTMLInputElement).blur();
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(document.activeElement).toBe(search);
  });

  it('includes Hermes-backed runners in search results', async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        providers: [{
          id: 'hermes-edge',
          label: 'Edge planner',
          description: 'plan through Hermes',
          kind: 'hermes-local',
          connectionId: 'hermes-dev',
          connectionLabel: 'Development Hermes',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ) as unknown as typeof fetch;

    render(<Palette />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'add hermes-edge agent node' })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /^Hermes$/i }));
    const search = screen.getByRole('searchbox', { name: 'Search nodes' });
    fireEvent.change(search, { target: { value: 'edge planner' } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'add hermes-edge agent node' })).toBeInTheDocument();
    });
  });
});
