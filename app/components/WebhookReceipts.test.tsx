import { afterEach, describe, expect, test } from 'bun:test';
import FakeTimers, { type InstalledClock } from '@sinonjs/fake-timers';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { WebhookReceipts } from './WebhookReceipts';
import type { WebhookReceipt, WebhookReceiptSummary } from '@/lib/shared/webhook-receipt';
import type { WebhookTrigger } from '@/lib/shared/trigger';

const originalFetch = globalThis.fetch;
let clock: InstalledClock | null = null;
afterEach(() => {
  clock?.uninstall();
  clock = null;
  globalThis.fetch = originalFetch;
});

function response(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function receipt(overrides: Partial<WebhookReceipt> = {}): WebhookReceipt {
  return {
    id: 'cid_1', receivedAt: 100, updatedAt: 100, triggerId: 'trigger-a',
    triggerName: 'Issue opened', source: 'GitHub', sender: 'alice',
    workflowId: 'wf-a', workflowName: 'Triage', state: 'running',
    body: '{"action":"opened"}', httpStatus: 202, runId: 'run-a',
    ...overrides,
  };
}

function summary(value: WebhookReceipt): WebhookReceiptSummary {
  const { body: _body, result: _result, ...rest } = value;
  return rest;
}

const triggers: WebhookTrigger[] = [
  { id: 'trigger-a', name: 'Issue opened', enabled: true, workflowId: 'wf-a', pluginId: 'github',
    match: [], inputs: {}, createdAt: 1, updatedAt: 1 },
  { id: 'trigger-b', name: 'Other', enabled: true, workflowId: 'wf-b', pluginId: 'generic',
    match: [], inputs: {}, createdAt: 1, updatedAt: 1 },
];

function ReceiptHarness({ initialFilter = null }: { initialFilter?: string | null }) {
  const [filter, setFilter] = useState(initialFilter);
  return <WebhookReceipts workflowFilter={null} triggerFilter={filter} onTriggerFilterChange={setFilter} triggers={triggers} />;
}

describe('WebhookReceipts', () => {
  test('shows an empty history when the API returns no messages', async () => {
    globalThis.fetch = (async () => response({ receipts: [], nextCursor: null })) as unknown as typeof fetch;
    render(<ReceiptHarness />);
    expect(await screen.findByText('No webhook messages received.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('shows source, sender, body and terminal result in detail', async () => {
    const complete = receipt({ state: 'succeeded', result: { finish: { answer: 42 } } });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      return url.includes('/api/webhook-receipts/')
        ? response({ receipt: complete })
        : response({ receipts: [summary(complete)], nextCursor: null });
    }) as typeof fetch;

    render(<ReceiptHarness />);
    const list = screen.getByRole('region', { name: 'Received webhook messages' });
    const row = await within(list).findByRole('button', { name: /GitHub · alice/ });
    expect(within(row).getByText('Succeeded')).toBeTruthy();
    fireEvent.click(row);
    const detail = screen.getByRole('region', { name: 'Webhook message details' });
    expect(await within(detail).findByText('{"action":"opened"}')).toBeTruthy();
    expect(within(detail).getByText(/"answer": 42/)).toBeTruthy();
    expect(within(detail).getByText('Triage')).toBeTruthy();
  });

  test('shows running without a final result and flags a partial body', async () => {
    const running = receipt({ body: '{"part":', bodyUnavailable: true, bodyTruncated: true });
    globalThis.fetch = (async (input: RequestInfo | URL) => String(input).includes('/api/webhook-receipts/')
      ? response({ receipt: running })
      : response({ receipts: [summary(running)], nextCursor: null })) as typeof fetch;

    render(<ReceiptHarness />);
    fireEvent.click(await screen.findByRole('button', { name: /GitHub · alice/ }));
    const detail = screen.getByRole('region', { name: 'Webhook message details' });
    expect(await within(detail).findByText('Workflow running…')).toBeTruthy();
    expect(within(detail).getByText('Request body unavailable.')).toBeTruthy();
    expect(within(detail).getByText('Request body truncated at the capture limit.')).toBeTruthy();
    expect(within(detail).getByText('{"part":')).toBeTruthy();
    expect(within(detail).queryByText('Workflow result')).toBeNull();
  });

  test('keeps a newer terminal detail state over a stale running list state', async () => {
    const stale = receipt({ updatedAt: 100, state: 'running' });
    const complete = receipt({ updatedAt: 101, state: 'succeeded', result: { end: { ok: true } } });
    globalThis.fetch = (async (input: RequestInfo | URL) => String(input).includes('/api/webhook-receipts/')
      ? response({ receipt: complete })
      : response({ receipts: [summary(stale)], nextCursor: null })) as typeof fetch;

    render(<ReceiptHarness />);
    fireEvent.click(await screen.findByRole('button', { name: /GitHub · alice/ }));
    const detail = screen.getByRole('region', { name: 'Webhook message details' });
    expect(await within(detail).findByText('Workflow result')).toBeTruthy();
    expect(within(detail).getByText('Succeeded')).toBeTruthy();
    expect(within(detail).queryByText('Workflow running…')).toBeNull();
  });

  test('does not mix an older page into a newly selected trigger filter', async () => {
    const a = receipt();
    const b = receipt({ id: 'cid_2', triggerId: 'trigger-b', triggerName: 'Other', source: 'Generic', sender: undefined });
    const stale = receipt({ id: 'cid_stale', triggerId: 'trigger-a', sender: 'stale' });
    let resolveOlder: ((value: ReturnType<typeof response>) => void) | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://test');
      if (url.searchParams.has('before')) return await new Promise<ReturnType<typeof response>>((resolve) => { resolveOlder = resolve; });
      if (url.searchParams.get('triggerId') === 'trigger-b') return response({ receipts: [summary(b)], nextCursor: null });
      return response({ receipts: [summary(a)], nextCursor: 'older-a' });
    }) as typeof fetch;

    render(<ReceiptHarness initialFilter="trigger-a" />);
    expect(await screen.findByText('GitHub · alice')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    await waitFor(() => expect(resolveOlder).toBeDefined());
    fireEvent.change(screen.getByLabelText('Trigger'), { target: { value: 'trigger-b' } });
    expect(await screen.findByText('Generic')).toBeTruthy();
    resolveOlder?.(response({ receipts: [summary(stale)], nextCursor: null }));
    await waitFor(() => expect(screen.queryByText('GitHub · stale')).toBeNull());
    expect(screen.queryByText('GitHub · alice')).toBeNull();
  });

  test('refreshes a running message after it falls off the newest page', async () => {
    clock = FakeTimers.install({ toFake: ['setInterval', 'clearInterval'] });
    const newest = Array.from({ length: 50 }, (_, index) => summary(receipt({
      id: `cid_new_${index}`, receivedAt: 1000 + index, state: 'succeeded',
      sender: `sender-${index}`,
    })));
    const older = receipt({ id: 'cid_old', receivedAt: 1, updatedAt: 1, source: 'Generic', sender: 'older' });
    const settled = receipt({ ...older, updatedAt: 2, state: 'succeeded', result: { end: { done: true } } });
    let detailCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://test');
      if (url.pathname.endsWith('/cid_old')) {
        detailCalls++;
        return response({ receipt: settled });
      }
      if (url.searchParams.has('before')) return response({ receipts: [summary(older)], nextCursor: null });
      return response({ receipts: newest, nextCursor: 'older-page' });
    }) as typeof fetch;

    render(<ReceiptHarness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Load older' }));
    const olderRow = await screen.findByRole('button', { name: /Generic · older/ });
    expect(within(olderRow).getByText('Running')).toBeTruthy();
    await act(async () => { await clock?.tickAsync(3000); });
    await waitFor(() => expect(within(olderRow).getByText('Succeeded')).toBeTruthy());
    expect(detailCalls).toBe(1);
  });

  test('can page through messages skipped by a burst larger than the newest page', async () => {
    clock = FakeTimers.install({ toFake: ['setInterval', 'clearInterval'] });
    const pageOf = (highest: number, lowest: number) => Array.from(
      { length: highest - lowest + 1 }, (_, index) => summary(receipt({
        id: `id${highest - index}`, receivedAt: highest - index,
        source: 'Generic', sender: `id${highest - index}`, state: 'succeeded',
      })),
    );
    const requestedCursors: string[] = [];
    let newestLoads = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://test');
      const before = url.searchParams.get('before');
      if (before) {
        requestedCursors.push(before);
        if (before === 'id102') return response({ receipts: pageOf(101, 52), nextCursor: 'id52' });
        if (before === 'id52') return response({ receipts: pageOf(51, 2), nextCursor: 'id2' });
        if (before === 'id2') return response({ receipts: pageOf(1, 1), nextCursor: null });
        throw new Error(`unexpected cursor ${before}`);
      }
      newestLoads++;
      return newestLoads === 1
        ? response({ receipts: pageOf(51, 2), nextCursor: 'id2' })
        : response({ receipts: pageOf(151, 102), nextCursor: 'id102' });
    }) as typeof fetch;

    render(<ReceiptHarness />);
    expect(await screen.findByText('Generic · id51')).toBeTruthy();
    await act(async () => { await clock?.tickAsync(3000); });
    expect(await screen.findByText('Generic · id151')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    // The click starts an async page request; verify it uses the gap boundary
    // before asserting that React has committed the returned rows.
    await waitFor(() => expect(requestedCursors).toEqual(['id102']));
    expect(await screen.findByText('Generic · id100')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    await waitFor(() => expect(requestedCursors).toEqual(['id102', 'id52']));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load older' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    expect(await screen.findByText('Generic · id1')).toBeTruthy();
    expect(requestedCursors).toEqual(['id102', 'id52', 'id2']);
  });

  test('keeps an API error visible instead of showing an empty history', async () => {
    globalThis.fetch = (async () => response({}, 503)) as unknown as typeof fetch;
    render(<ReceiptHarness />);
    expect(await screen.findByRole('alert')).toHaveTextContent('HTTP 503');
    expect(screen.queryByText('No webhook messages received.')).toBeNull();
  });
});
