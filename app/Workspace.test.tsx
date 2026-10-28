import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Workspace from './Workspace';
import type { ReactNode } from 'react';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import type { GitHubCIOutput } from '../lib/shared/github-ci';
import type { Workflow } from '../lib/shared/workflow';
import { useWorkflowStore } from '../lib/client/workflow-store-client';

const routerPush = mock((_href: string) => {});
const router = { push: routerPush, replace: mock(() => {}), refresh: mock(() => {}), back: mock(() => {}), forward: mock(() => {}), prefetch: mock(async () => {}) };
const renderWorkspace = (ui: ReactNode) => render(<AppRouterContext.Provider value={router}>{ui}</AppRouterContext.Provider>);
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalMatchMedia = window.matchMedia;

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
    githubCI: {},
    inspectedRunEvents: null,
    connectionStatus: 'connecting',
    past: [],
    future: [],
  });
}

beforeEach(() => {
  resetStore();
  routerPush.mockClear();
  router.replace.mockClear();
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
  window.matchMedia = originalMatchMedia;
});

describe('Workspace initial workflow loading', () => {
  it('loads only the addressed workflow', async () => {
    const fetchMock = mock(async (url: RequestInfo | URL) => {
      if (String(url) === '/api/workflows/wf-a') return jsonResponse({ workflow: FULL_A });
      if (String(url) === '/api/providers') return jsonResponse({ providers: [] });
      return jsonResponse({});
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    renderWorkspace(<Workspace flowId="wf-a" />);
    await waitFor(() => expect(useWorkflowStore.getState().currentWorkflow?.id).toBe('wf-a'));
    expect(fetchMock).toHaveBeenCalledWith('/api/workflows/wf-a');
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/workflows')).toBe(false);
  });

  it('does not fall back to another workflow for an unknown ID', async () => {
    globalThis.fetch = mock(async () => jsonResponse({ error: 'missing' }, { status: 404 })) as unknown as typeof fetch;
    renderWorkspace(<Workspace flowId="missing" />);
    expect(await screen.findByTestId('flow-load-error')).toHaveTextContent('Flow not found');
    expect(useWorkflowStore.getState().currentWorkflow).toBeNull();
  });

  it('ignores an obsolete detail response after navigating to another flow', async () => {
    let finish!: (response: Response) => void;
    globalThis.fetch = mock(async (url: RequestInfo | URL) => {
      if (String(url) === '/api/workflows/wf-a') return new Promise<Response>((resolve) => { finish = resolve; });
      if (String(url) === '/api/workflows/wf-b') return jsonResponse({ workflow: { ...FULL_A, id: 'wf-b', name: 'Beta' } });
      return jsonResponse({ providers: [] });
    }) as unknown as typeof fetch;
    const { rerender } = renderWorkspace(<Workspace flowId="wf-a" />);
    await waitFor(() => expect(finish).toBeDefined());
    rerender(<AppRouterContext.Provider value={router}><Workspace flowId="wf-b" /></AppRouterContext.Provider>);
    await waitFor(() => expect(useWorkflowStore.getState().currentWorkflow?.id).toBe('wf-b'));
    await act(async () => finish(jsonResponse({ workflow: FULL_A })));
    expect(useWorkflowStore.getState().currentWorkflow?.id).toBe('wf-b');
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

    renderWorkspace(<Workspace flowId="wf-a" />);
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

describe('Workspace navigation lifecycle', () => {
  it('moves an old editor Dispatch URL home after saving pending changes', async () => {
    useWorkflowStore.setState({ currentWorkflow: FULL_A, isDirty: true });
    let finishSave!: (response: Response) => void;
    globalThis.fetch = mock(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') return new Promise<Response>((resolve) => { finishSave = resolve; });
      return jsonResponse({ providers: [] });
    }) as unknown as typeof fetch;
    window.location.hash = '#dispatch?workflow=wf-a';
    renderWorkspace(<Workspace flowId="wf-a" />);
    await waitFor(() => expect(finishSave).toBeDefined());
    expect(routerPush).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    await act(async () => finishSave(jsonResponse({ workflow: FULL_A })));
    expect(router.replace).toHaveBeenCalledWith('/#dispatch?workflow=wf-a');
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('does not redirect after a pending navigation save completes on an unmounted editor', async () => {
    useWorkflowStore.setState({ currentWorkflow: FULL_A, isDirty: true });
    let finish!: (response: Response) => void;
    globalThis.fetch = mock(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') return new Promise<Response>((resolve) => { finish = resolve; });
      return jsonResponse({ providers: [] });
    }) as unknown as typeof fetch;
    const { unmount } = renderWorkspace(<Workspace flowId="wf-a" />);
    fireEvent.click(screen.getByRole('link', { name: 'All flows' }));
    await waitFor(() => expect(finish).toBeDefined());
    unmount();
    await act(async () => finish(jsonResponse({ workflow: FULL_A })));
    expect(routerPush).not.toHaveBeenCalled();
    expect(useWorkflowStore.getState().isDirty).toBe(false);
  });

  it('lets a later browser history choice supersede navigation awaiting a save', async () => {
    useWorkflowStore.setState({ currentWorkflow: FULL_A, isDirty: true });
    let finish!: (response: Response) => void;
    globalThis.fetch = mock(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') return new Promise<Response>((resolve) => { finish = resolve; });
      return jsonResponse({ providers: [] });
    }) as unknown as typeof fetch;
    renderWorkspace(<Workspace flowId="wf-a" />);
    fireEvent.click(screen.getByRole('link', { name: 'All flows' }));
    await waitFor(() => expect(finish).toBeDefined());
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    await act(async () => finish(jsonResponse({ workflow: FULL_A })));
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('shows a plain workflow title and dirty indicator without management controls', async () => {
    useWorkflowStore.setState({ currentWorkflow: FULL_A, isDirty: true });
    globalThis.fetch = mock(async () => jsonResponse({ providers: [] })) as unknown as typeof fetch;
    await act(async () => { renderWorkspace(<Workspace flowId="wf-a" />); });
    expect(screen.getByTestId('workflow-title')).toHaveTextContent('Alpha');
    expect(screen.getByLabelText('unsaved changes')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'workflow menu' })).toBeNull();
    expect(screen.queryByRole('button', { name: /rename workflow|delete workflow|new workflow/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dispatch' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Queue' })).toBeNull();
    expect(screen.queryByRole('button', { name: /switch to (dark|light) theme/ })).toBeNull();
  });

  it('saves before navigating home from the brand and blocks mutation shortcuts while waiting', async () => {
    useWorkflowStore.setState({ currentWorkflow: FULL_A, isDirty: true, past: [{ ...FULL_A, name: 'Before edit' }] });
    let finishSave!: (response: Response) => void;
    globalThis.fetch = mock(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') return new Promise<Response>((resolve) => { finishSave = resolve; });
      return jsonResponse({ providers: [] });
    }) as unknown as typeof fetch;
    renderWorkspace(<Workspace flowId="wf-a" />);
    const homeLink = screen.getByRole('link', { name: 'Inf·Loop home' });
    expect(homeLink).toHaveAttribute('href', '/');
    fireEvent.click(homeLink);
    await waitFor(() => expect(finishSave).toBeDefined());
    expect(routerPush).not.toHaveBeenCalled();
    expect(document.querySelector('header')).toHaveAttribute('inert');
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    const deleteKey = new KeyboardEvent('keydown', { key: 'Backspace', cancelable: true });
    window.dispatchEvent(deleteKey);
    expect(deleteKey.defaultPrevented).toBe(true);
    expect(useWorkflowStore.getState().currentWorkflow?.name).toBe('Alpha');
    await act(async () => finishSave(jsonResponse({ workflow: FULL_A })));
    expect(routerPush).toHaveBeenCalledWith('/');
  });
});

describe('Workspace mobile node library', () => {
  it('opens search, closes on Escape, and adds a tapped node before returning to the canvas', async () => {
    window.matchMedia = (() => ({
      matches: true, media: '(max-width: 920px)', onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    })) as typeof window.matchMedia;
    useWorkflowStore.getState().loadWorkflow(FULL_A);
    globalThis.fetch = mock(async () => jsonResponse({ providers: [] })) as unknown as typeof fetch;
    await act(async () => { renderWorkspace(<Workspace flowId="wf-a" />); });
    const toggle = screen.getByRole('button', { name: 'Nodes' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('searchbox', { name: 'Search nodes' })).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();

    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'add script node' }));
    expect(useWorkflowStore.getState().currentWorkflow?.nodes.filter((node) => node.type === 'script')).toHaveLength(1);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveFocus();
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

    const { container } = renderWorkspace(<Workspace flowId="wf-a" />);

    await waitFor(() => {
      expect(screen.getByLabelText('config panel')).toBeInTheDocument();
    });
    expect(container.querySelector('.workspace-bi')).not.toBeNull();
    expect(container.querySelector('.node-inspector-layer')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'close node inspector' }));
    expect(useWorkflowStore.getState().selectedNodeId).toBeNull();
  });
});


describe('Workspace live CI inspector', () => {
  it('shows read-only live results alongside the run rail and resumes editing after settlement', async () => {
    const workflow: Workflow = {
      ...FULL_A,
      nodes: [...FULL_A.nodes, {
        id: 'ci', type: 'github-ci', position: { x: 300, y: 200 },
        config: { repository: 'owner/repo', pullRequest: '12', required: [{ kind: 'check', name: 'test' }], timeoutMs: 60_000 },
      }],
    };
    const output: GitHubCIOutput = {
      repository: 'owner/repo', pullRequest: 12, pullRequestUrl: 'https://github.com/owner/repo/pull/12',
      headSha: 'a'.repeat(40), status: 'Running', passed: 0, total: 1,
      required: [{ kind: 'check', name: 'test', conclusion: null, urls: [] }],
      checks: [], failed: [], pending: ['check:test'], updatedAt: 1,
    };
    useWorkflowStore.getState().loadWorkflow(workflow);
    useWorkflowStore.setState({
      selectedNodeId: 'ci', runStatus: 'running',
      runEvents: [], githubCI: { ci: output },
    });
    globalThis.fetch = mock(async (url: RequestInfo | URL) => {
      if (String(url) === '/api/providers') return jsonResponse({ providers: [] });
      throw new Error(`unexpected fetch ${String(url)}`);
    }) as unknown as typeof fetch;

    const { container } = renderWorkspace(<Workspace flowId="wf-a" />);
    const inspector = screen.getByLabelText('live CI inspector');
    expect(within(inspector).getByText('Running · 0/1 required')).toBeInTheDocument();
    expect(screen.getByLabelText('run view')).toBeInTheDocument();
    expect(container.querySelector('.workspace-tri')).not.toBeNull();
    expect(screen.queryByLabelText('config panel')).not.toBeInTheDocument();
    expect(within(inspector).queryByRole('textbox')).not.toBeInTheDocument();

    act(() => useWorkflowStore.getState().appendRunEvent({
      type: 'github_ci_updated', nodeId: 'ci', output: { ...output, status: 'Failed', errorMessage: 'test failed' },
    }));
    expect(within(inspector).getByText('Failed · 0/1 required')).toBeInTheDocument();
    expect(within(inspector).getByRole('alert')).toHaveTextContent('test failed');

    act(() => useWorkflowStore.getState().selectNode('start-1'));
    expect(screen.queryByLabelText('live CI inspector')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('config panel')).not.toBeInTheDocument();
    expect(screen.getByLabelText('run view')).toBeInTheDocument();

    act(() => useWorkflowStore.setState({ selectedNodeId: 'ci', runStatus: 'succeeded' }));
    expect(screen.getByLabelText('config panel')).toBeInTheDocument();
    expect(screen.getByLabelText('GitHub repository')).toBeInTheDocument();
    expect(screen.queryByLabelText('live CI inspector')).not.toBeInTheDocument();
  });
});
