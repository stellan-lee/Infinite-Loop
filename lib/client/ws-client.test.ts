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

describe('GitHub CI snapshot hydration', () => {
  it('restores per-node CI details without replay events and resets them at the next run', async () => {
    const previous = globalThis.EventSource;
    (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
    FakeEventSource.instances = [];
    const { useWorkflowStore } = await import('./workflow-store-client');
    const { useEngineWebSocket } = await import('./ws-client');
    const { aggregateCI } = await import('../server/github-ci-client');
    const output = aggregateCI({ repository: 'owner/repo', pullRequest: '2', required: [{ kind: 'check', name: 'test' }], timeoutMs: 60_000 }, 'a'.repeat(40), []);
    useWorkflowStore.getState().resetRun();
    const { unmount } = renderHook(() => useEngineWebSocket());
    const es = FakeEventSource.instances[0];
    try {
      act(() => es.triggerMessage(JSON.stringify({
        type: 'state_snapshot',
        state: { status: 'running', scope: {}, iterationByLoopId: {}, events: [], githubCI: { 'left/ci': output, 'right/ci': { ...output, status: 'Running' } } },
      })));
      expect(useWorkflowStore.getState().runEvents).toHaveLength(0);
      expect(useWorkflowStore.getState().githubCI['left/ci'].headSha).toBe(output.headSha);
      expect(useWorkflowStore.getState().githubCI['right/ci'].status).toBe('Running');
      act(() => es.triggerMessage(JSON.stringify({ type: 'github_ci_updated', nodeId: 'left/ci', output: { ...output, status: 'Passed' } })));
      expect(useWorkflowStore.getState().githubCI['left/ci'].status).toBe('Passed');
      expect(useWorkflowStore.getState().githubCI['right/ci'].status).toBe('Running');
      act(() => es.triggerMessage(JSON.stringify({ type: 'run_started', workflowId: 'next', workflowName: 'Next' })));
      expect(useWorkflowStore.getState().githubCI).toEqual({});
    } finally {
      unmount();
      globalThis.EventSource = previous;
    }
  });
});

describe('workflow-scoped stream', () => {
  const original = globalThis.EventSource;
  beforeEach(() => {
    FakeEventSource.instances = [];
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  });
  afterEach(() => { globalThis.EventSource = original; });

  it('hydrates the addressed flow and ignores another flow’s live events', async () => {
    const { useWorkflowStore } = await import('./workflow-store-client');
    const { useEngineWebSocket } = await import('./ws-client');
    useWorkflowStore.getState().resetRun();
    const { result } = renderHook(() => useEngineWebSocket('flow-a'));
    const es = FakeEventSource.instances[0];
    act(() => es.triggerMessage(JSON.stringify({
      type: 'state_snapshot',
      state: { workflowId: 'flow-b', runId: 'run-b', status: 'running', events: [] },
      runs: [
        { workflowId: 'flow-a', runId: 'run-a', status: 'running', events: [{ type: 'run_started', workflowId: 'flow-a', runId: 'run-a' }] },
        { workflowId: 'flow-b', runId: 'run-b', status: 'running', events: [] },
      ],
    })));
    expect(result.current).toBe('run-a');
    act(() => es.triggerMessage(JSON.stringify({ type: 'run_started', workflowId: 'flow-b', runId: 'run-b' })));
    act(() => es.triggerMessage(JSON.stringify({ type: 'run_finished', status: 'failed', runId: 'run-b' })));
    expect(useWorkflowStore.getState().runStatus).toBe('running');
    expect(useWorkflowStore.getState().runEvents).toHaveLength(1);
    act(() => es.triggerMessage(JSON.stringify({ type: 'run_finished', status: 'succeeded', runId: 'run-a' })));
    expect(useWorkflowStore.getState().runStatus).toBe('succeeded');
  });

  it('waits for a loaded flow and rejects late frames from its previous stream', async () => {
    const { useWorkflowStore } = await import('./workflow-store-client');
    const { useEngineWebSocket } = await import('./ws-client');
    useWorkflowStore.getState().resetRun();
    const { rerender } = renderHook(({ id }: { id: string | null }) => useEngineWebSocket(id), { initialProps: { id: null as string | null } });
    expect(FakeEventSource.instances).toHaveLength(0);
    rerender({ id: 'flow-a' });
    const previous = FakeEventSource.instances[0];
    rerender({ id: 'flow-b' });
    expect(previous.closed).toBe(true);
    act(() => previous.triggerMessage(JSON.stringify({ type: 'run_started', workflowId: 'flow-a', runId: 'run-a' })));
    act(() => FakeEventSource.instances[1].triggerMessage(JSON.stringify({
      type: 'state_snapshot',
      state: { workflowId: 'flow-a', runId: 'run-a', status: 'running', events: [] },
      runs: [],
    })));
    expect(useWorkflowStore.getState().runStatus).toBe('idle');
    expect(useWorkflowStore.getState().runEvents).toEqual([]);
  });
});
