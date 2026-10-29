import { afterEach, expect, it } from 'bun:test';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { RunRecord } from '../../lib/shared/workflow';
import { useWorkflowStore } from '../../lib/client/workflow-store-client';
import HistoryRunDrawer from './HistoryRunDrawer';

const originalFetch = globalThis.fetch;
const json = (run: unknown, status = 200) => new Response(JSON.stringify({ run }), { status });
const record: RunRecord = {
  runId: 'run /?#', workflowId: 'flow /?#', workflowName: 'Flow',
  status: 'succeeded', startedAt: 1, finishedAt: 1501, durationMs: 1500,
  scope: { inputs: { topic: 'exact run input' } },
  events: [
    { type: 'node_started', nodeId: 'task', nodeType: 'script', resolvedConfig: { code: 'input code' } },
    { type: 'node_finished', nodeId: 'task', nodeType: 'script', branch: 'next', outputs: { answer: 'exact run output' }, durationMs: 1500 },
  ],
};
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

it('fetches the exact encoded identity and shares recorded details without changing editor inspection', async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL) => { requests.push(String(url)); return json(record); }) as unknown as typeof fetch;
  const before = useWorkflowStore.getState();
  render(<HistoryRunDrawer workflowId={record.workflowId} runId={record.runId} onClose={() => {}} />);
  expect(await screen.findByLabelText('recorded run status')).toHaveTextContent('succeeded');
  expect(requests).toEqual(['/api/runs/flow%20%2F%3F%23/run%20%2F%3F%23']);
  expect(screen.getByLabelText('Workflow ID')).toHaveTextContent(record.workflowId);
  expect(screen.getByLabelText('Run ID')).toHaveTextContent(record.runId);
  expect(screen.getByText('1.5s')).toBeInTheDocument();
  const inputs = screen.getByRole('region', { name: 'recorded inputs' });
  expect(inputs).toHaveTextContent('exact run input');
  const header = screen.getByRole('dialog', { name: 'Run history detail' }).querySelector('header')!;
  expect(within(header).getByRole('button', { name: 'Rerun workflow' })).toBeInTheDocument();
  expect(within(header).getByRole('button', { name: 'Close run history' })).toBeInTheDocument();
  expect(header.compareDocumentPosition(inputs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'expand scope' }));
  expect(within(screen.getByLabelText('run scope')).getByText(/exact run input/)).toBeInTheDocument();
  expect(screen.getByLabelText('event log')).toHaveTextContent('task');
  const after = useWorkflowStore.getState();
  expect(after.inspectedRunEvents).toBe(before.inspectedRunEvents);
  expect(after.selectedNodeId).toBe(before.selectedNodeId);
  expect(after.panRequest).toBe(before.panRequest);
});

it.each(['succeeded', 'failed'] as const)('shows the persisted final output for a %s run', async (status) => {
  globalThis.fetch = (async () => json({
    ...record,
    status,
    finalOutputs: { answer: { count: 3, accepted: true }, missing: null },
  })) as unknown as typeof fetch;
  render(<HistoryRunDrawer workflowId={record.workflowId} runId={record.runId} onClose={() => {}} />);
  const output = await screen.findByLabelText('Final output');
  expect(output).toHaveTextContent('answer');
  expect(output).toHaveTextContent('count');
  expect(output).toHaveTextContent('3');
  expect(output).toHaveTextContent('true');
  expect(output).toHaveTextContent('null');
});

it('omits final output for a legacy or early-failed run', async () => {
  globalThis.fetch = (async () => json({ ...record, status: 'failed', scope: {} })) as unknown as typeof fetch;
  render(<HistoryRunDrawer workflowId={record.workflowId} runId={record.runId} onClose={() => {}} />);
  await screen.findByLabelText('recorded run status');
  expect(screen.queryByLabelText('Final output')).toBeNull();
});

it.each(['succeeded', 'failed'] as const)('reruns a %s history record from the Jobs drawer', async (status) => {
  const requests: { url: string; body?: unknown }[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (String(url) === '/api/run') return new Response(JSON.stringify({ runId: 'fresh-run' }), { status: 202 });
    return json({ ...record, status });
  }) as typeof fetch;
  render(<HistoryRunDrawer workflowId={record.workflowId} runId={record.runId} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Rerun workflow' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('fresh-run'));
  expect(requests.at(-1)).toEqual({ url: '/api/run', body: { workflowId: record.workflowId, inputs: { topic: 'exact run input' } } });
});

it('clears old status while switching and ignores late responses, including the same run ID in another flow', async () => {
  const pending: { resolve: (response: Response) => void; signal: AbortSignal }[] = [];
  globalThis.fetch = ((_url: RequestInfo | URL, options?: RequestInit) => new Promise<Response>((resolve) => pending.push({ resolve, signal: options!.signal! }))) as typeof fetch;
  const { rerender } = render(<HistoryRunDrawer workflowId="first" runId="same" onClose={() => {}} />);
  rerender(<HistoryRunDrawer workflowId="second" runId="same" onClose={() => {}} />);
  expect(pending[0].signal.aborted).toBe(true);
  await act(async () => pending[1].resolve(json({ ...record, workflowId: 'second', runId: 'same', status: 'failed', errorMessage: 'second failure' })));
  expect(screen.getByLabelText('recorded run status')).toHaveTextContent('failed');
  await act(async () => pending[0].resolve(json({ ...record, workflowId: 'first', runId: 'same' })));
  expect(screen.getByLabelText('recorded run status')).toHaveTextContent('failed');
  expect(screen.getByText('second failure')).toBeInTheDocument();
  rerender(<HistoryRunDrawer workflowId="third" runId="other" onClose={() => {}} />);
  expect(screen.queryByLabelText('recorded run status')).toBeNull();
  expect(screen.queryByText('second failure')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('Loading run details');
});

it.each([404, 200])('allows retry when the completed record is not persisted (%s)', async (status) => {
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return requests === 1 ? json({ workflowId: record.workflowId, runId: record.runId, status: 'succeeded', scope: {} }, status) : json(record);
  }) as unknown as typeof fetch;
  render(<HistoryRunDrawer workflowId={record.workflowId} runId={record.runId} onClose={() => {}} />);
  expect(await screen.findByRole('alert')).toHaveTextContent(/sav/);
  expect(screen.queryByLabelText('recorded run status')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByLabelText('recorded run status')).toHaveTextContent('succeeded');
  expect(requests).toBe(2);
});

it('rejects a response for a different run instead of displaying it', async () => {
  globalThis.fetch = (async () => json({ ...record, runId: 'wrong' })) as unknown as typeof fetch;
  render(<HistoryRunDrawer workflowId={record.workflowId} runId={record.runId} onClose={() => {}} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('does not match');
  expect(screen.queryByLabelText('event log')).toBeNull();
});

it('focuses Close, dismisses through the native Escape cancel event, restores focus, and ignores completion after close', async () => {
  let resolve!: (response: Response) => void;
  let signal!: AbortSignal;
  globalThis.fetch = ((_url: RequestInfo | URL, options?: RequestInit) => { signal = options!.signal!; return new Promise<Response>((done) => { resolve = done; }); }) as unknown as typeof fetch;
  const opener = document.createElement('button');
  document.body.append(opener);
  opener.focus();
  let closes = 0;
  const { unmount } = render(<HistoryRunDrawer workflowId={record.workflowId} runId={record.runId} onClose={() => { closes++; unmount(); }} />);
  const dialog = screen.getByRole('dialog', { name: 'Run history detail' });
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  expect(screen.getByRole('button', { name: 'Close run history' })).toHaveFocus();
  fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }));
  expect(closes).toBe(1);
  expect(signal.aborted).toBe(true);
  expect(opener).toHaveFocus();
  await act(async () => resolve(json(record)));
  expect(screen.queryByRole('dialog')).toBeNull();
  opener.remove();
});

it('dismisses only backdrop clicks and does not refetch or refocus on a parent rerender', async () => {
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return json(record); }) as unknown as typeof fetch;
  let closes = 0;
  const props = { workflowId: record.workflowId, runId: record.runId, onClose: () => { closes++; } };
  const { rerender } = render(<HistoryRunDrawer {...props} />);
  const scope = await screen.findByRole('button', { name: 'expand scope' });
  scope.focus();
  fireEvent.click(scope);
  expect(closes).toBe(0);
  rerender(<HistoryRunDrawer {...props} />);
  expect(scope).toHaveFocus();
  expect(requests).toBe(1);
  fireEvent.click(screen.getByRole('dialog'));
  await waitFor(() => expect(closes).toBe(1));
});
