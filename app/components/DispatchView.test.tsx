import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DispatchView } from './DispatchView';
import type { WebhookTrigger, WebhookPlugin } from '@/lib/shared/trigger';

const triggers: WebhookTrigger[] = [
  {
    id: 'idAAAAAAAAAAAAAAAAAAAA', name: 'github-issue-opened',
    enabled: true, workflowId: 'code-review',
    pluginId: 'github', eventType: 'issues',
    match: [], inputs: {}, lastFiredAt: null, createdAt: 1, updatedAt: 1,
  },
  {
    id: 'idBBBBBBBBBBBBBBBBBBBB', name: 'generic-debug',
    enabled: false, workflowId: 'test-flow',
    pluginId: 'generic', match: [], inputs: {},
    lastFiredAt: 1_700_000_000_000, createdAt: 1, updatedAt: 1,
  },
];

const plugins: WebhookPlugin[] = [
  { id: 'generic', displayName: 'Generic', events: [{ type: 'any', displayName: 'Any', fields: [] }] },
  { id: 'github', displayName: 'GitHub', eventHeader: 'x-github-event', events: [{ type: 'issues', displayName: 'Issue', fields: [] }] },
];

const workflows = [
  { id: 'code-review', name: 'Code review', inputs: [] },
  { id: 'test-flow', name: 'Test flow', inputs: [] },
];

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalHash = window.location.hash;

beforeEach(() => { window.location.hash = ''; });
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  window.location.hash = originalHash;
});

function mockFetch(routes: Record<string, unknown>) {
  // @ts-expect-error fetch override
  globalThis.fetch = async (url: string) => {
    const path = typeof url === 'string' ? url : (url as Request).url;
    const key = Object.keys(routes).find((k) => path.includes(k));
    if (!key) throw new Error(`unexpected fetch: ${path}`);
    return { ok: true, json: async () => routes[key] };
  };
}

describe('DispatchView', () => {
  test('lists triggers fetched from the API', async () => {
    mockFetch({
      '/api/triggers': { triggers },
      '/api/webhook-plugins': { plugins },
      '/api/workflows': { workflows },
    });
    render(<DispatchView origin="http://localhost:3000" />);
    await waitFor(() => {
      expect(screen.getByText('github-issue-opened')).toBeTruthy();
      expect(screen.getByText('generic-debug')).toBeTruthy();
    });
  });

  test('renders empty state when no triggers exist', async () => {
    mockFetch({
      '/api/triggers': { triggers: [] },
      '/api/webhook-plugins': { plugins },
      '/api/workflows': { workflows },
    });
    render(<DispatchView origin="http://localhost:3000" />);
    await waitFor(() => {
      expect(screen.getByText(/No triggers yet/i)).toBeTruthy();
    });
  });

  test('filters list when hash has workflow=<id>', async () => {
    window.location.hash = '#dispatch?workflow=test-flow';
    mockFetch({
      '/api/triggers': { triggers },
      '/api/webhook-plugins': { plugins },
      '/api/workflows': { workflows },
    });
    render(<DispatchView origin="http://localhost:3000" />);
    await waitFor(() => {
      expect(screen.queryByText('github-issue-opened')).toBeNull();
      expect(screen.getByText('generic-debug')).toBeTruthy();
    });
    window.location.hash = '';
  });

  test('refreshes a trigger after its event arrives on the home stream', async () => {
    let stream: { onmessage: ((event: MessageEvent) => void) | null; close: () => void } | null = null;
    let closed = false;
    class FakeStream {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onopen: (() => void) | null = null;
      close() { closed = true; }
      constructor(public url: string) { stream = this; }
    }
    globalThis.EventSource = FakeStream as unknown as typeof EventSource;
    let lastFiredAt: number | null = null;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path === '/api/triggers') return { json: async () => ({ triggers: [{ ...triggers[0], lastFiredAt }] }) } as Response;
      if (path === '/api/webhook-plugins') return { json: async () => ({ plugins }) } as Response;
      if (path === '/api/workflows') return { json: async () => ({ workflows }) } as Response;
      if (path.startsWith('/api/workflows/')) return { json: async () => ({ workflow: { inputs: [] } }) } as Response;
      throw new Error(`Unexpected fetch ${path}`);
    }) as typeof fetch;
    const { unmount } = render(<DispatchView origin="http://localhost:3000" />);
    await waitFor(() => expect(screen.getByText('github-issue-opened')).toBeTruthy());
    fireEvent.click(screen.getByText('github-issue-opened'));
    expect(screen.getByText('Never')).toBeTruthy();
    lastFiredAt = 1_700_000_000_000;
    await act(async () => {
      stream?.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'trigger_started' }) }));
    });
    await waitFor(() => expect(screen.queryByText('Never')).toBeNull());
    unmount();
    expect(closed).toBe(true);
  });

  test('keeps a newer trigger update when an older refresh finishes last', async () => {
    let stream: { onmessage: ((event: MessageEvent) => void) | null } | null = null;
    class FakeStream {
      onmessage: ((event: MessageEvent) => void) | null = null;
      close() {}
      constructor() { stream = this; }
    }
    globalThis.EventSource = FakeStream as unknown as typeof EventSource;
    let finishOld!: (value: Response) => void;
    let reads = 0;
    const response = (value: unknown) => ({ json: async () => value }) as Response;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const path = String(url);
      if (path === '/api/triggers') {
        reads += 1;
        return reads === 1
          ? new Promise<Response>((resolve) => { finishOld = resolve; })
          : response({ triggers: [{ ...triggers[0], name: 'Newer trigger' }] });
      }
      if (path === '/api/webhook-plugins') return response({ plugins });
      if (path === '/api/workflows') return response({ workflows: [] });
      throw new Error(`Unexpected fetch ${path}`);
    }) as typeof fetch;
    const { unmount } = render(<DispatchView origin="http://localhost:3000" />);
    await waitFor(() => expect(finishOld).toBeDefined());
    await act(async () => {
      stream?.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'trigger_started' }) }));
    });
    expect(await screen.findByText('Newer trigger')).toBeTruthy();
    await act(async () => finishOld(response({ triggers: [{ ...triggers[0], name: 'Older trigger' }] })));
    expect(screen.getByText('Newer trigger')).toBeTruthy();
    expect(screen.queryByText('Older trigger')).toBeNull();
    unmount();
  });
});
