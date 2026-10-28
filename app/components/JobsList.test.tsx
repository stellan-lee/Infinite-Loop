import { afterEach, beforeEach, expect, it } from 'bun:test';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import FakeTimers from '@sinonjs/fake-timers';
import JobsList from './JobsList';
import { useHomeJobs } from '../../lib/client/home-jobs-client';

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  close() { this.closed = true; }
  emit(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
}
let history: unknown[];
let active: unknown[];
let queue: unknown[];
let historyFailure: boolean;
let calls: string[];
let signals: AbortSignal[];
const run = { runId: 'active', workflowId: 'flow', workflowName: 'Flow', status: 'running', startedAt: Date.now() - 10_000, waitingFor: { kind: 'human', nodeId: 'review' } };
const finished = { runId: 'done', workflowId: 'flow', workflowName: 'Flow', status: 'succeeded', startedAt: 1, finishedAt: 2000, durationMs: 1999 };
beforeEach(() => {
  FakeEventSource.instances = [];
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  history = []; active = []; queue = []; historyFailure = false; calls = []; signals = [];
  globalThis.fetch = (async (url, init) => {
    calls.push(String(url));
    if (init?.signal) signals.push(init.signal);
    if (url === '/api/run') return json({ runs: active });
    if (url === '/api/runs') return json({ runs: history }, historyFailure ? 503 : 200);
    if (url === '/api/triggers/queue') return json({ items: queue });
    return json({ workflow: { nodes: [{ id: 'review', type: 'manual', label: 'Approve changes' }], edges: [] } });
  }) as typeof fetch;
});
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; globalThis.EventSource = originalEventSource; });

it('renders all statuses in one ordered list, resolves waiting stages, and ticks elapsed time', async () => {
  active = [run];
  queue = [{ queueId: 'q', workflowId: 'flow', position: 1, receivedAt: 3 }];
  history = [finished, ...(['failed', 'exhausted', 'cancelled'] as const).map((status, i) => ({ ...finished, runId: status, status, finishedAt: 1900 - i }))];
  const { unmount } = render(<JobsList flows={[]} />);
  expect(await screen.findByText('Stage: Waiting for review · Approve changes')).toBeInTheDocument();
  const rows = within(screen.getByRole('list', { name: 'Jobs' })).getAllByRole('listitem');
  expect(rows.map((row) => row.getAttribute('data-status'))).toEqual(['running', 'queued', 'succeeded', 'failed', 'exhausted', 'cancelled']);
  for (const label of ['Running', 'Queued', 'Succeeded', 'Failed', 'Exhausted', 'Cancelled']) expect(screen.getByText(label, { exact: true })).toBeInTheDocument();
  const before = screen.getByLabelText('Elapsed time').textContent;
  await waitFor(() => expect(screen.getByLabelText('Elapsed time').textContent).not.toBe(before), { timeout: 1800 });
  expect(FakeEventSource.instances).toHaveLength(1);
  unmount();
  expect(FakeEventSource.instances[0].closed).toBe(true);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});

it('keeps partial rows on history failure and recovers through Retry', async () => {
  queue = [{ queueId: 'q', workflowId: 'flow', position: 1, receivedAt: 3 }];
  historyFailure = true;
  render(<JobsList flows={[]} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('recent jobs (503)');
  expect(screen.getByTestId('job-row-q')).toBeInTheDocument();
  expect(screen.queryByText(/No jobs yet/)).toBeNull();
  historyFailure = false; history = [finished];
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByTestId('job-row-done')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('opens only finished rows in an exact-run drawer and preserves the home location', async () => {
  active = [run];
  queue = [{ queueId: 'q', workflowId: 'flow', position: 1, receivedAt: 3 }];
  history = [finished];
  const beforeUrl = window.location.href;
  const defaultFetch = globalThis.fetch;
  globalThis.fetch = (async (url, options) => url === '/api/runs/flow/done'
    ? json({ run: { ...finished, scope: {}, events: [] } })
    : defaultFetch(url, options)) as typeof fetch;
  render(<JobsList flows={[]} />);
  const open = await screen.findByRole('button', { name: 'View run done' });
  expect(within(screen.getByTestId('job-row-active')).queryByRole('button')).toBeNull();
  expect(within(screen.getByTestId('job-row-q')).queryByRole('button')).toBeNull();
  open.focus();
  fireEvent.click(open);
  const drawer = screen.getByRole('dialog', { name: 'Run history detail' });
  expect(await within(drawer).findByLabelText('Run ID')).toHaveTextContent('done');
  expect(await within(drawer).findByLabelText('recorded run status')).toHaveTextContent('succeeded');
  expect(window.location.href).toBe(beforeUrl);
  fireEvent.click(within(drawer).getByRole('button', { name: 'Close run history' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(open).toHaveFocus();
});

it('retains completion until delayed history persistence, then stops retrying', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    active = [run];
    render(<JobsList flows={[]} />);
    await act(async () => { await clock.tickAsync(0); });
    act(() => FakeEventSource.instances[0].emit({ type: 'run_finished', runId: 'active', status: 'succeeded', scope: {} }));
    expect(screen.getByTestId('job-row-active')).toHaveAttribute('data-status', 'succeeded');
    await act(async () => { await clock.tickAsync(100); });
    expect(calls.filter((url) => url === '/api/runs')).toHaveLength(2);
    expect(screen.getByText('Final details pending')).toBeInTheDocument();
    history = [{ ...finished, runId: 'active' }];
    await act(async () => { await clock.tickAsync(500); });
    expect(screen.queryByText('Final details pending')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('job-row-active')).toHaveLength(1);
    expect(calls.filter((url) => url === '/api/runs')).toHaveLength(3);
    await act(async () => { await clock.tickAsync(60_000); });
    expect(calls.filter((url) => url === '/api/runs')).toHaveLength(3);
  } finally {
    cleanup();
    clock.uninstall();
  }
});

it('reconnects with fresh global state and ignores stale queue responses after a start event', async () => {
  let resolveQueue!: (response: Response) => void;
  const currentFetch = globalThis.fetch;
  let firstQueue = true;
  globalThis.fetch = (async (url, init) => {
    if (url === '/api/triggers/queue' && firstQueue) {
      firstQueue = false;
      return new Promise<Response>((resolve) => { resolveQueue = resolve; });
    }
    return currentFetch(url, init);
  }) as typeof fetch;
  render(<JobsList flows={[]} />);
  await waitFor(() => expect(resolveQueue).toBeDefined());
  active = [run];
  act(() => {
    FakeEventSource.instances[0].onopen?.();
    FakeEventSource.instances[0].emit({ type: 'trigger_started', queueId: 'q', workflowId: 'flow', runId: 'active' });
  });
  await act(async () => resolveQueue(json({ items: [{ queueId: 'q', workflowId: 'flow', position: 1, receivedAt: 1 }] })));
  expect(screen.queryByTestId('job-row-q')).toBeNull();
  await screen.findByTestId('job-row-active');
  act(() => FakeEventSource.instances[0].onerror?.());
  expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
  const count = calls.filter((url) => url === '/api/runs').length;
  act(() => FakeEventSource.instances[0].onopen?.());
  await waitFor(() => expect(calls.filter((url) => url === '/api/runs').length).toBe(count + 1));
  expect(screen.getByText('Live', { exact: true })).toBeInTheDocument();
});

it('recovers a missed completion after reconnect persistence lag with bounded history requests', async () => {
  const clock = FakeTimers.install({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    active = [run];
    const { result, unmount } = renderHook(() => useHomeJobs());
    const source = FakeEventSource.instances[0];
    await act(async () => {
      source.onopen?.();
      await clock.tickAsync(0);
    });
    expect(result.current.jobs.some((job) => job.kind === 'run' && job.runId === 'active')).toBe(true);
    act(() => source.onerror?.());
    // The first run finishes offline. A second run replaces the compatibility
    // snapshot before the first run's summary reaches the history store.
    const next = { ...run, runId: 'next', waitingFor: undefined };
    active = [next];
    await act(async () => {
      source.onopen?.();
      source.emit({ type: 'state_snapshot', runs: [next], state: next });
      await clock.tickAsync(200);
    });
    expect(result.current.jobs.map((job) => job.kind === 'run' ? job.runId : job.queueId)).toEqual(['next']);
    expect(calls.filter((url) => url === '/api/runs')).toHaveLength(2);
    history = [{ ...finished, runId: 'active' }];
    await act(async () => { await clock.tickAsync(500); });
    expect(result.current.jobs.map((job) => job.status)).toEqual(['running', 'succeeded']);
    await act(async () => { await clock.tickAsync(10_000); });
    expect(calls.filter((url) => url === '/api/runs')).toHaveLength(5);
    await act(async () => { await clock.tickAsync(60_000); });
    expect(calls.filter((url) => url === '/api/runs')).toHaveLength(5);
    unmount();
    expect(clock.countTimers()).toBe(0);
  } finally {
    cleanup();
    clock.uninstall();
  }
});
