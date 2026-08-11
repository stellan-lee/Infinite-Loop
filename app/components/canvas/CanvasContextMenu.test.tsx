import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  type Mock,
} from 'bun:test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import CanvasContextMenu, {
  type ContextMenuItem,
  type ContextMenuOpenAt,
} from './CanvasContextMenu';

const PROVIDERS = [
  { id: 'claude', label: 'Claude', description: 'spawn claude --print', glyph: '⟳' },
  { id: 'codex', label: 'Codex', description: 'spawn codex exec', glyph: '◈' },
];

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = mock(async (url: RequestInfo | URL) => {
    if (String(url).endsWith('/api/providers')) {
      return jsonResponse({ providers: PROVIDERS });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const at: ContextMenuOpenAt = {
  clientX: 200,
  clientY: 150,
  flowX: 50,
  flowY: 25,
};

describe('CanvasContextMenu', () => {
  it('renders nothing when `open` is null', () => {
    const { container } = render(
      <CanvasContextMenu open={null} onClose={() => {}} onPick={() => {}} />,
    );
    expect(container.querySelector('[aria-label="canvas context menu"]')).toBeNull();
  });

  it('lists static groups + provider-driven model runners', async () => {
    render(
      <CanvasContextMenu open={at} onClose={() => {}} onPick={() => {}} />,
    );
    // Static items render synchronously.
    expect(screen.getByLabelText('add start node')).toBeInTheDocument();
    expect(screen.getByLabelText('add end node')).toBeInTheDocument();
    expect(screen.getByLabelText('add loop node')).toBeInTheDocument();
    expect(screen.getByLabelText('add condition node')).toBeInTheDocument();
    expect(screen.getByLabelText('add structured-output node')).toBeInTheDocument();
    // Provider items appear after the fetch resolves.
    await waitFor(() =>
      expect(
        screen.getByLabelText('add claude agent node'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByLabelText('add codex agent node')).toBeInTheDocument();
  });

  it('positions itself at the supplied client coordinates', () => {
    render(
      <CanvasContextMenu open={at} onClose={() => {}} onPick={() => {}} />,
    );
    const root = screen.getByLabelText('canvas context menu') as HTMLElement;
    expect(root.style.left).toBe(`${at.clientX}px`);
    expect(root.style.top).toBe(`${at.clientY}px`);
  });

  it('calls onPick with the item + at-position then onClose when an item is clicked', async () => {
    const onPick = mock<(item: ContextMenuItem, at: ContextMenuOpenAt) => void>(() => {});
    const onClose = mock<() => void>(() => {});

    render(
      <CanvasContextMenu open={at} onClose={onClose} onPick={onPick} />,
    );

    const loopBtn = screen.getByLabelText('add loop node');
    fireEvent.click(loopBtn);

    expect(onPick).toHaveBeenCalledTimes(1);
    const [item, posAt] = (onPick as Mock<(...a: unknown[]) => unknown>).mock.calls[0];
    expect(item).toEqual({ type: 'loop', label: 'Loop' });
    expect(posAt).toEqual(at);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('passes providerId for agent items', async () => {
    const onPick = mock<(item: ContextMenuItem, at: ContextMenuOpenAt) => void>(() => {});
    render(
      <CanvasContextMenu open={at} onClose={() => {}} onPick={onPick} />,
    );
    const claude = await screen.findByLabelText('add claude agent node');
    fireEvent.click(claude);

    const [item] = (onPick as Mock<(...a: unknown[]) => unknown>).mock.calls[0];
    expect(item).toEqual({
      type: 'agent',
      label: 'Claude',
      providerId: 'claude',
    });
  });

  it('dismisses on Escape', () => {
    const onClose = mock<() => void>(() => {});
    render(
      <CanvasContextMenu open={at} onClose={onClose} onPick={() => {}} />,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dismisses on outside mousedown but not on inside click', () => {
    const onClose = mock<() => void>(() => {});
    render(
      <div>
        <button type="button" data-testid="outside">outside</button>
        <CanvasContextMenu open={at} onClose={onClose} onPick={() => {}} />
      </div>,
    );

    // Inside click should NOT dismiss (only the item-click + onClose should).
    fireEvent.mouseDown(screen.getByLabelText('canvas context menu'));
    expect(onClose).not.toHaveBeenCalled();

    // Outside click dismisses.
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows an error placeholder when the provider fetch fails', async () => {
    globalThis.fetch = mock(async () =>
      new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch;

    render(
      <CanvasContextMenu open={at} onClose={() => {}} onPick={() => {}} />,
    );
    await waitFor(() =>
      expect(screen.getByText(/failed to load providers/i)).toBeInTheDocument(),
    );
  });
});
