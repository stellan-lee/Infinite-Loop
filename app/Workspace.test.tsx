import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Workspace from './Workspace';
import type { Workflow, WorkflowSummary } from '../lib/shared/workflow';
import { useWorkflowStore } from '../lib/client/workflow-store-client';

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

const SUMMARY_A: WorkflowSummary = {
  id: 'wf-a',
  name: 'Alpha',
  version: 1,
  updatedAt: 100,
};

const FULL_A: Workflow = {
  id: 'wf-a',
  name: 'Alpha',
  version: 1,
  nodes: [
    { id: 'start-1', type: 'start', position: { x: 80, y: 200 }, config: {} },
    { id: 'end-1', type: 'end', position: { x: 520, y: 200 }, config: {} },
  ],
  edges: [{ id: 'e1', source: 'start-1', sourceHandle: 'next', target: 'end-1' }],
  createdAt: 100,
  updatedAt: 100,
};

class FakeEventSource {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  close() {}
}

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

function resetStore() {
  useWorkflowStore.setState({
    currentWorkflow: null,
    isDirty: false,
    selectedNodeId: null,
    runStatus: 'idle',
    runEvents: [],
    connectionStatus: 'connecting',
    past: [],
    future: [],
  });
}

beforeEach(() => {
  resetStore();
  window.localStorage.clear();
  window.location.hash = '';
  if (typeof globalThis.ResizeObserver === 'undefined') {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
});

describe('Workspace initial workflow loading', () => {
  it('loads the first workflow when the old default workflow id no longer exists', async () => {
    const fetchMock = mock(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u === '/api/providers') {
        return jsonResponse({ providers: [] });
      }
      if (u === '/api/workflows/loop-claude-until-condition') {
        return jsonResponse({ error: 'workflow not found' }, { status: 404 });
      }
      if (u === '/api/workflows') {
        return jsonResponse({ workflows: [SUMMARY_A] });
      }
      if (u === '/api/workflows/wf-a') {
        return jsonResponse({ workflow: FULL_A });
      }
      throw new Error(`unexpected fetch ${u}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<Workspace />);

    await waitFor(() => {
      expect(useWorkflowStore.getState().currentWorkflow?.id).toBe('wf-a');
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/workflows/loop-claude-until-condition');
    expect(fetchMock).toHaveBeenCalledWith('/api/workflows');
    expect(fetchMock).toHaveBeenCalledWith('/api/workflows/wf-a');
  });
});

describe('Workspace run persistence', () => {
  it('saves pending workflow edits before starting a run', async () => {
    useWorkflowStore.getState().loadWorkflow(FULL_A);
    useWorkflowStore.setState({ isDirty: true });
    const fetchMock = mock(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u === '/api/providers') return jsonResponse({ providers: [] });
      if (u === '/api/workflows/wf-a' && init?.method === 'PUT') return jsonResponse({ workflow: FULL_A });
      if (u === '/api/run' && init?.method === 'POST') return jsonResponse({ runId: 'run-1' }, { status: 202 });
      throw new Error(`unexpected fetch ${u}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    render(<Workspace />);
    fireEvent.click(screen.getByRole('button', { name: 'run workflow' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/run',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    const calls = fetchMock.mock.calls;
    const saveIndex = calls.findIndex(
      ([url, init]) => String(url) === '/api/workflows/wf-a' && init?.method === 'PUT',
    );
    const runIndex = calls.findIndex(
      ([url, init]) => String(url) === '/api/run' && init?.method === 'POST',
    );
    expect(saveIndex).toBeGreaterThanOrEqual(0);
    expect(runIndex).toBeGreaterThan(saveIndex);
  });
});

describe('Workspace card inspector', () => {
  it('opens selected-node details as a canvas layer without adding the global rail', async () => {
    useWorkflowStore.getState().loadWorkflow(FULL_A);
    useWorkflowStore.getState().selectNode('start-1');
    globalThis.fetch = mock(async (url: RequestInfo | URL) => {
      if (String(url) === '/api/providers') return jsonResponse({ providers: [] });
      throw new Error(`unexpected fetch ${String(url)}`);
    }) as unknown as typeof fetch;

    const { container } = render(<Workspace />);

    await waitFor(() => {
      expect(screen.getByLabelText('config panel')).toBeInTheDocument();
    });
    expect(container.querySelector('.workspace-bi')).not.toBeNull();
    expect(container.querySelector('.node-inspector-layer')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'close node inspector' }));
    expect(useWorkflowStore.getState().selectedNodeId).toBeNull();
  });
});
