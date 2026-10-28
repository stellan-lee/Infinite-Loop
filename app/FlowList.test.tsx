import { afterEach, beforeEach, expect, it, mock } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import FlowList from './FlowList';
import { useWorkflowStore } from '../lib/client/workflow-store-client';

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalConfirm = window.confirm;
class FakeEventSource {
  onmessage = null;
  onopen = null;
  onerror = null;
  close() {}
}
function installFetch(handler: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const workflowFetch = mock(handler);
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) === '/api/run') return json({ runs: [] });
    if (String(url) === '/api/runs') return json({ runs: [] });
    if (String(url) === '/api/triggers/queue') return json({ size: 0, items: [] });
    return workflowFetch(url, init);
  }) as typeof fetch;
  return workflowFetch;
}
const push = mock((_href: string) => {});
const router = { push, replace: mock(() => {}), refresh: mock(() => {}), back: mock(() => {}), forward: mock(() => {}), prefetch: mock(async () => {}) };
const renderList = () => render(<AppRouterContext.Provider value={router}><FlowList /></AppRouterContext.Provider>);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  push.mockClear();
  window.location.hash = '';
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  useWorkflowStore.setState({ currentWorkflow: null, isDirty: false });
});
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; globalThis.EventSource = originalEventSource; window.confirm = originalConfirm; });

it('lists all summaries with encoded flow links and library labels', async () => {
  installFetch(async () => json({ workflows: [
    { id: 'flow one', name: 'First flow', updatedAt: 100, version: 1 },
    { id: 'library-flow', name: 'Preset', updatedAt: 50, version: 1, source: 'library' },
  ] }));
  renderList();
  expect(await screen.findByTestId('flow-row-flow one')).toHaveAttribute('href', '/flow%20one');
  expect(screen.getByRole('link', { name: 'Inf·Loop home' })).toHaveAttribute('href', '/');
  expect(screen.getByTestId('flow-row-library-flow')).toHaveTextContent('Library');
  expect(useWorkflowStore.getState().currentWorkflow).toBeNull();
});

it('shows Dispatch at the home hash and returns to flows from the brand', async () => {
  installFetch(async (url) => {
    if (String(url) === '/api/triggers') return json({ triggers: [] });
    if (String(url) === '/api/webhook-plugins') return json({ plugins: [] });
    return json({ workflows: [] });
  });
  window.location.hash = '#dispatch';
  renderList();
  expect(await screen.findByRole('heading', { name: 'Triggers' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Dispatch' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByTestId('flow-empty')).toBeNull();
  fireEvent.click(screen.getByRole('link', { name: 'Inf·Loop home' }));
  expect(await screen.findByTestId('flow-empty')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Dispatch' })).toHaveAttribute('aria-pressed', 'false');
});

it('distinguishes failure from an empty list and retries', async () => {
  let failure = true;
  installFetch(async () => failure ? json({}, 503) : json({ workflows: [] }));
  renderList();
  expect(await screen.findByTestId('flow-list-error')).toHaveTextContent('503');
  expect(screen.queryByTestId('flow-empty')).toBeNull();
  failure = false;
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByTestId('flow-empty')).toBeInTheDocument();
  expect(screen.getByTestId('new-flow')).toBeEnabled();
});

it('creates a persisted flow before navigating', async () => {
  const requests: string[] = [];
  installFetch(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      requests.push('created');
      return json({ workflow: { ...JSON.parse(String(init.body)), id: 'created-flow' } });
    }
    return json({ workflows: [] });
  });
  renderList();
  await screen.findByTestId('flow-empty');
  fireEvent.click(screen.getByTestId('new-flow'));
  await waitFor(() => expect(push).toHaveBeenCalledWith('/created-flow'));
  expect(requests).toEqual(['created']);
});

it('preserves an unsaved editor document when returning home cannot save', async () => {
  const workflow = { id: 'dirty', name: 'Dirty', version: 1, nodes: [], edges: [], createdAt: 1, updatedAt: 1 };
  useWorkflowStore.setState({ currentWorkflow: workflow, isDirty: true });
  const fetchMock = mock(async () => json({}, 503));
  installFetch(fetchMock);
  renderList();
  expect(await screen.findByTestId('flow-list-error')).toHaveTextContent('save failed');
  expect(useWorkflowStore.getState().currentWorkflow).toBe(workflow);
  expect(useWorkflowStore.getState().isDirty).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('keeps a created flow without redirecting after the list unmounts', async () => {
  let finishCreate!: (response: Response) => void;
  installFetch(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return new Promise<Response>((resolve) => { finishCreate = resolve; });
    return json({ workflows: [] });
  });
  const { unmount } = renderList();
  await screen.findByTestId('flow-empty');
  fireEvent.click(screen.getByTestId('new-flow'));
  await waitFor(() => expect(finishCreate).toBeDefined());
  unmount();
  await act(async () => finishCreate(json({ workflow: { id: 'created-flow' } })));
  expect(push).not.toHaveBeenCalled();
});

it('does not override a later flow selection while creation is pending', async () => {
  let finishCreate!: (response: Response) => void;
  installFetch(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return new Promise<Response>((resolve) => { finishCreate = resolve; });
    return json({ workflows: [{ id: 'other-flow', name: 'Other flow', updatedAt: 1, version: 1 }] });
  });
  renderList();
  await screen.findByTestId('flow-row-other-flow');
  fireEvent.click(screen.getByTestId('new-flow'));
  await waitFor(() => expect(finishCreate).toBeDefined());
  fireEvent.click(screen.getByTestId('flow-row-other-flow'));
  await act(async () => finishCreate(json({ workflow: { id: 'created-flow', name: 'Created', updatedAt: 2, version: 1 } })));
  expect(push.mock.calls.some(([href]) => href === '/created-flow')).toBe(false);
});

it('settles a superseded creation on the same home page and lists its saved result', async () => {
  let finishCreate!: (response: Response) => void;
  installFetch(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return new Promise<Response>((resolve) => { finishCreate = resolve; });
    return json({ workflows: [] });
  });
  renderList();
  await screen.findByTestId('flow-empty');
  fireEvent.click(screen.getByTestId('new-flow'));
  await waitFor(() => expect(finishCreate).toBeDefined());
  act(() => window.dispatchEvent(new PopStateEvent('popstate')));
  await act(async () => finishCreate(json({ workflow: { id: 'created-flow', name: 'Created', version: 1, updatedAt: 2 } })));
  expect(push).not.toHaveBeenCalled();
  expect(screen.getByTestId('new-flow')).toBeEnabled();
  expect(screen.getByTestId('new-flow')).toHaveTextContent('New flow');
  expect(screen.getByTestId('flow-row-created-flow')).toHaveTextContent('Created');
});

const fullFlow = {
  id: 'flow-a', name: 'Alpha', version: 1, createdAt: 100, updatedAt: 100,
  nodes: [{ id: 'start', type: 'start' as const, position: { x: 0, y: 0 }, config: {} }], edges: [],
};

function managementFetch({ failRename = false, failDelete = false, revealPreset = false } = {}) {
  let saved = { ...fullFlow };
  let deleted = false;
  return installFetch(async (url, init) => {
    if (String(url) === '/api/workflows') {
      return json({ workflows: deleted ? (revealPreset ? [{ ...fullFlow, name: 'Library original', source: 'library' }] : []) : [saved] });
    }
    if (String(url) === '/api/workflows/flow-a') {
      if (init?.method === 'PUT') {
        if (failRename) return json({ error: 'write failed' }, 503);
        saved = { ...JSON.parse(String(init.body)), version: 2 };
        return json({ workflow: saved });
      }
      if (init?.method === 'DELETE') {
        if (failDelete) return json({ error: 'delete failed' }, 503);
        deleted = true;
        return new Response(null, { status: 204 });
      }
      return json({ workflow: saved });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

it('renames a flow from home, preserving its graph and trimming the name', async () => {
  const requests = managementFetch();
  renderList();
  await screen.findByTestId('flow-row-flow-a');
  fireEvent.click(screen.getByRole('button', { name: 'rename workflow flow-a' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'workflow name flow-a' }), { target: { value: '  Renamed  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'save workflow flow-a' }));
  await waitFor(() => expect(screen.getByTestId('flow-row-flow-a')).toHaveTextContent('Renamed'));
  const write = requests.mock.calls.find(([, init]) => init?.method === 'PUT');
  expect(JSON.parse(String(write?.[1]?.body))).toMatchObject({ name: 'Renamed', nodes: fullFlow.nodes, edges: fullFlow.edges });
  expect(push).not.toHaveBeenCalled();
});

it('cancels inline rename by button and Escape without saving or navigating', async () => {
  const requests = managementFetch();
  renderList();
  await screen.findByTestId('flow-row-flow-a');
  for (const cancel of ['button', 'Escape']) {
    fireEvent.click(screen.getByRole('button', { name: 'rename workflow flow-a' }));
    const input = screen.getByRole('textbox', { name: 'workflow name flow-a' });
    fireEvent.change(input, { target: { value: 'Discarded' } });
    if (cancel === 'button') fireEvent.click(screen.getByRole('button', { name: 'cancel rename flow-a' }));
    else fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.getByTestId('flow-row-flow-a')).toHaveTextContent('Alpha');
  }
  expect(requests.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  expect(push).not.toHaveBeenCalled();
});

it('does not save blank or unchanged names', async () => {
  const requests = managementFetch();
  renderList();
  await screen.findByTestId('flow-row-flow-a');
  for (const name of ['   ', ' Alpha ']) {
    fireEvent.click(screen.getByRole('button', { name: 'rename workflow flow-a' }));
    const input = screen.getByRole('textbox', { name: 'workflow name flow-a' });
    fireEvent.change(input, { target: { value: name } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('flow-row-flow-a')).toHaveTextContent('Alpha');
  }
  expect(requests.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
});

it('keeps the persisted name and a row error after a failed rename', async () => {
  managementFetch({ failRename: true });
  renderList();
  await screen.findByTestId('flow-row-flow-a');
  fireEvent.click(screen.getByRole('button', { name: 'rename workflow flow-a' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'workflow name flow-a' }), { target: { value: 'Rejected' } });
  fireEvent.click(screen.getByRole('button', { name: 'save workflow flow-a' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not rename this flow (503)');
  expect(screen.getByTestId('flow-row-flow-a')).toHaveTextContent('Alpha');
  expect(screen.getByRole('button', { name: 'rename workflow flow-a' })).toBeEnabled();
  expect(push).not.toHaveBeenCalled();
});

it('requires confirmation before deleting and refreshes a revealed library preset', async () => {
  const requests = managementFetch({ revealPreset: true });
  window.confirm = mock(() => false);
  renderList();
  await screen.findByTestId('flow-row-flow-a');
  fireEvent.click(screen.getByRole('button', { name: 'delete workflow flow-a' }));
  expect(window.confirm).toHaveBeenCalledWith('Delete workflow "Alpha"?');
  expect(requests.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
  window.confirm = () => true;
  fireEvent.click(screen.getByRole('button', { name: 'delete workflow flow-a' }));
  await waitFor(() => expect(screen.getByTestId('flow-row-flow-a')).toHaveTextContent('Library original'));
  expect(screen.getByTestId('flow-row-flow-a')).toHaveTextContent('Library');
  expect(push).not.toHaveBeenCalled();
});

it('keeps the flow and displays a row error after a failed delete', async () => {
  managementFetch({ failDelete: true });
  window.confirm = () => true;
  renderList();
  await screen.findByTestId('flow-row-flow-a');
  fireEvent.click(screen.getByRole('button', { name: 'delete workflow flow-a' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not delete this flow (503)');
  expect(screen.getByTestId('flow-row-flow-a')).toHaveTextContent('Alpha');
  expect(screen.getByRole('button', { name: 'delete workflow flow-a' })).toBeEnabled();
});
