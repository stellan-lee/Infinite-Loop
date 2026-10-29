import { afterEach, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { RunRecord } from '../../lib/shared/workflow';
import RerunWorkflowButton from './RerunWorkflowButton';

const originalFetch = globalThis.fetch;
const record = {
  workflowId: 'flow-1', runId: 'old-run', status: 'succeeded',
  scope: { __inputs: { topic: 'saved', attempts: 2 }, inputs: { topic: 'stale' }, node: { result: 'omit' } },
} as unknown as RunRecord;

afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

it.each(['succeeded', 'failed'] as const)('starts a new run from a %s record with saved inputs', async (status) => {
  let resolve!: (response: Response) => void;
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return new Promise<Response>((done) => { resolve = done; });
  }) as unknown as typeof fetch;
  render(<RerunWorkflowButton record={{ ...record, status }} />);
  const button = screen.getByRole('button', { name: 'Rerun workflow' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(requests).toHaveLength(1);
  expect(button).toBeDisabled();
  expect(requests[0].url).toBe('/api/run');
  expect(requests[0].init?.method).toBe('POST');
  expect(JSON.parse(String(requests[0].init?.body))).toEqual({ workflowId: 'flow-1', inputs: { topic: 'saved', attempts: 2 } });
  resolve(new Response(JSON.stringify({ runId: 'new-run' }), { status: 202 }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('new-run'));
  expect(button).not.toBeDisabled();
});

it('uses empty inputs when a failed record has no saved inputs', async () => {
  let body: unknown;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ runId: 'new-run' }), { status: 202 });
  }) as unknown as typeof fetch;
  render(<RerunWorkflowButton record={{ ...record, status: 'failed', scope: {} }} />);
  expect(screen.queryByRole('region', { name: 'recorded inputs' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Rerun workflow' }));
  await screen.findByRole('status');
  expect(body).toEqual({ workflowId: 'flow-1', inputs: {} });
});

it('falls back to the older input alias if the preferred alias is unusable', async () => {
  let body: unknown;
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ runId: 'new-run' }), { status: 202 });
  }) as unknown as typeof fetch;
  render(<RerunWorkflowButton record={{ ...record, scope: { __inputs: ['not an input map'], inputs: { topic: 'fallback' }, node: { output: 'omit' } } as unknown as RunRecord['scope'] }} />);
  const inputs = screen.getByRole('region', { name: 'recorded inputs' });
  expect(inputs).toHaveTextContent('fallback');
  expect(inputs).not.toHaveTextContent('omit');
  fireEvent.click(screen.getByRole('button', { name: 'Rerun workflow' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('new-run'));
  expect(body).toEqual({ workflowId: 'flow-1', inputs: { topic: 'fallback' } });
});

it('shows recorded primitive inputs above rerun without expanding the full scope', () => {
  render(<RerunWorkflowButton record={{ ...record, scope: {
    __inputs: { enabled: false, attempts: 0, empty: '', note: 'first line\nsecond line' },
    inputs: { stale: 'ignore' },
    node: { output: 'do not show' },
  } }} />);
  const inputs = screen.getByRole('region', { name: 'recorded inputs' });
  expect(within(inputs).getByText('enabled').nextElementSibling).toHaveTextContent('false');
  expect(within(inputs).getByText('attempts').nextElementSibling).toHaveTextContent('0');
  expect(within(inputs).getByText('empty').nextElementSibling).toHaveTextContent('""');
  expect(within(inputs).getByText('note').nextElementSibling?.textContent).toBe('first line\nsecond line');
  expect(inputs).not.toHaveTextContent('stale');
  expect(inputs).not.toHaveTextContent('do not show');
  expect(inputs.compareDocumentPosition(screen.getByRole('button', { name: 'Rerun workflow' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('shows validation, missing-workflow, cost, network, and malformed-response errors', async () => {
  const responses = [
    new Response(JSON.stringify({ error: 'invalid-inputs', field: 'topic', reason: 'required' }), { status: 400 }),
    new Response(JSON.stringify({ error: 'workflow not found: flow-1' }), { status: 404 }),
    new Response(JSON.stringify({ error: 'cost budget exhausted' }), { status: 503 }),
    new Error('offline'),
    new Response(JSON.stringify({}), { status: 202 }),
  ];
  globalThis.fetch = (async () => {
    const next = responses.shift()!;
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  render(<RerunWorkflowButton record={record} />);
  const button = screen.getByRole('button', { name: 'Rerun workflow' });
  for (const expected of ['topic', 'workflow not found', 'cost budget exhausted', 'offline', 'run ID']) {
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(expected));
    expect(button).not.toBeDisabled();
  }
});
