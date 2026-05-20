import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';
import Page from './page';
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

describe('Page initial workflow loading', () => {
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

    render(<Page />);

    await waitFor(() => {
      expect(useWorkflowStore.getState().currentWorkflow?.id).toBe('wf-a');
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/workflows/loop-claude-until-condition');
    expect(fetchMock).toHaveBeenCalledWith('/api/workflows');
    expect(fetchMock).toHaveBeenCalledWith('/api/workflows/wf-a');
  });
});
