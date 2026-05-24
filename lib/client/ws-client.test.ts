import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;

  url: string;
  readyState = FakeEventSource.CONNECTING;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  closed = false;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  triggerOpen() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.(new Event('open'));
  }
  triggerMessage(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }
  triggerError() {
    this.onerror?.(new Event('error'));
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
}

describe('useEngineWebSocket (SSE)', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    (globalThis as unknown as { EventSource: unknown }).EventSource =
      FakeEventSource as unknown;
  });
  afterEach(() => {
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
  });

  it('opens an EventSource on mount and dispatches valid events into the store', async () => {
    const { useWorkflowStore } = await import('./workflow-store-client');
    const { useEngineWebSocket } = await import('./ws-client');

    useWorkflowStore.getState().resetRun();

    const { unmount } = renderHook(() => useEngineWebSocket());
    expect(FakeEventSource.instances.length).toBe(1);
    const es = FakeEventSource.instances[0];
    expect(es.url).toContain('/api/events');

    act(() => es.triggerOpen());
    expect(useWorkflowStore.getState().connectionStatus).toBe('open');

    act(() =>
      es.triggerMessage(
        JSON.stringify({ type: 'run_started', workflowId: 'w', workflowName: 'W' }),
      ),
    );
    expect(
      useWorkflowStore.getState().runEvents.some((e) => e.type === 'run_started'),
    ).toBe(true);

    // state_snapshot now hydrates: replaces runStatus + runEvents with the
    // engine's recent buffer so a refresh restores the live view.
    act(() =>
      es.triggerMessage(
        JSON.stringify({
          type: 'state_snapshot',
          state: {
            status: 'running',
            iterationByLoopId: {},
            scope: {},
            events: [
              { type: 'node_started', nodeId: 'agent-1', nodeType: 'agent', resolvedConfig: {} },
            ],
          },
        }),
      ),
    );
    const after = useWorkflowStore.getState();
    expect(after.runStatus).toBe('running');
    expect(after.runEvents).toHaveLength(1);
    expect(after.runEvents[0].type).toBe('node_started');

    unmount();
    expect(es.closed).toBe(true);
  });

  it('admits manual-gate events (node_waiting_for_human, node_human_decided) through the allowlist', async () => {
    const { useWorkflowStore } = await import('./workflow-store-client');
    const { useEngineWebSocket } = await import('./ws-client');

    useWorkflowStore.getState().resetRun();
    renderHook(() => useEngineWebSocket());
    const es = FakeEventSource.instances[0];
    act(() => es.triggerOpen());

    act(() =>
      es.triggerMessage(
        JSON.stringify({
          type: 'node_waiting_for_human',
          nodeId: 'manual-1',
          brief: 'review',
          decisions: [{ key: 'accepted' }, { key: 'rejected' }],
        }),
      ),
    );
    act(() =>
      es.triggerMessage(
        JSON.stringify({
          type: 'node_human_decided',
          nodeId: 'manual-1',
          decision: 'accepted',
          decidedBy: 'api-token',
          decidedAt: 1730000000000,
        }),
      ),
    );

    const events = useWorkflowStore.getState().runEvents.map((e) => e.type);
    expect(events).toContain('node_waiting_for_human');
    expect(events).toContain('node_human_decided');
  });

  it('marks connection closed on transient error (EventSource auto-reconnects)', async () => {
    const { useWorkflowStore } = await import('./workflow-store-client');
    const { useEngineWebSocket } = await import('./ws-client');
    renderHook(() => useEngineWebSocket());
    const es = FakeEventSource.instances[0];
    act(() => es.triggerOpen());
    act(() => es.triggerError());
    expect(useWorkflowStore.getState().connectionStatus).toBe('closed');
  });
});
