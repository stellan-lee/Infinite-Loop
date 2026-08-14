import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { RunRecord, RunSummary } from '../../lib/shared/workflow';
import { useWorkflowStore } from '../../lib/client/workflow-store-client';
import RunHistory from './RunHistory';

const SUMMARY_A: RunSummary = {
  runId: 'r-a',
  workflowId: 'wf-1',
  workflowName: 'Demo',
  status: 'succeeded',
  startedAt: 1_700_000_000_000,
  finishedAt: 1_700_000_001_500,
  durationMs: 1500,
  eventCount: 4,
};

const LONG_PROMPT = 'a'.repeat(300);

const RECORD_A: RunRecord = {
  ...SUMMARY_A,
  scope: {
    inputs: { topic: 'demo' },
    'agent-1': { ok: true, summary: 'done' },
  },
  events: [
    { type: 'run_started', workflowId: 'wf-1', workflowName: 'Demo' },
    {
      type: 'node_started',
      nodeId: 'agent-1',
      nodeType: 'agent',
      resolvedConfig: { providerId: 'claude', prompt: LONG_PROMPT },
    },
    {
      type: 'node_finished',
      nodeId: 'agent-1',
      nodeType: 'agent',
      branch: 'next',
      outputs: { ok: true, summary: 'done' },
      durationMs: 1200,
    },
    { type: 'run_finished', status: 'succeeded', scope: {} },
  ],
};

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  // Selection state lives in the module-scoped Zustand store; clear so one
  // test's selection doesn't leak filter behaviour into the next.
  useWorkflowStore.setState({
    selectedNodeId: null,
    panRequest: null,
    inspectedRunEvents: null,
  });
});

describe('RunHistory', () => {
  beforeEach(() => {
    // Default fetch handles list + detail.
    globalThis.fetch = mock(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.startsWith('/api/runs?workflowId=')) {
        return jsonResponse({ runs: [SUMMARY_A] });
      }
      if (u.startsWith('/api/runs/wf-1/r-a')) {
        return jsonResponse({ run: RECORD_A });
      }
      throw new Error(`unexpected fetch ${u}`);
    }) as unknown as typeof fetch;
  });

  it('shows the no-workflow placeholder when none is loaded', async () => {
    // Override fetch to assert it isn't called when workflowId is absent.
    let called = false;
    globalThis.fetch = mock(async () => {
      called = true;
      return jsonResponse({ runs: [] });
    }) as unknown as typeof fetch;

    render(<RunHistory workflowId={undefined} />);
    await waitFor(() =>
      expect(screen.getByText(/load a workflow first/i)).toBeInTheDocument(),
    );
    expect(called).toBe(false);
  });

  it('explains how to create history when a workflow has no recorded runs', async () => {
    globalThis.fetch = mock(async () => jsonResponse({ runs: [] })) as unknown as typeof fetch;
    render(<RunHistory workflowId="wf-1" />);
    await waitFor(() =>
      expect(screen.getByText(/no recorded runs yet/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/click run to execute the current workflow/i)).toBeInTheDocument();
  });

  it('lists runs returned by /api/runs for the current workflow', async () => {
    render(<RunHistory workflowId="wf-1" />);
    await waitFor(() =>
      expect(screen.getByLabelText('run r-a')).toBeInTheDocument(),
    );
    // Status text appears, plus the event-count badge.
    const row = screen.getByLabelText('run r-a');
    expect(row).toHaveTextContent('succeeded');
    expect(row).toHaveTextContent('4 ev');
  });

  it('opens a detail view when a run row is clicked and renders the events', async () => {
    render(<RunHistory workflowId="wf-1" />);
    const row = await screen.findByLabelText('run r-a');
    fireEvent.click(row);

    await waitFor(() =>
      expect(screen.getByLabelText('event log')).toBeInTheDocument(),
    );
    const log = screen.getByLabelText('event log');
    // node_started / node_finished rows are dropped from the body now —
    // the per-node card header carries kind/branch/status instead. We can
    // still assert the card itself rendered for `agent-1`.
    expect(log).toHaveTextContent('run_started');
    expect(log).toHaveTextContent('run_finished');
    expect(screen.getByLabelText('node card agent-1')).toBeInTheDocument();
    expect(useWorkflowStore.getState().inspectedRunEvents).toEqual(RECORD_A.events);
  });

  it('back button returns to the list view', async () => {
    render(<RunHistory workflowId="wf-1" />);
    fireEvent.click(await screen.findByLabelText('run r-a'));
    await screen.findByLabelText('event log');

    fireEvent.click(screen.getByLabelText('back to history list'));
    await waitFor(() =>
      expect(screen.getByLabelText('run history')).toBeInTheDocument(),
    );
    expect(useWorkflowStore.getState().inspectedRunEvents).toBeNull();
  });

  it('filters cards to the selected node when it has events in this run', async () => {
    render(<RunHistory workflowId="wf-1" />);
    fireEvent.click(await screen.findByLabelText('run r-a'));
    await screen.findByLabelText('event log');

    // No filter yet — run_started/run_finished rows are visible.
    const logBefore = screen.getByLabelText('event log');
    expect(logBefore).toHaveTextContent('run_started');

    act(() => {
      useWorkflowStore.getState().selectNode('agent-1');
    });

    await waitFor(() =>
      expect(
        screen.getByLabelText('filtered to node agent-1'),
      ).toBeInTheDocument(),
    );
    const logAfter = screen.getByLabelText('event log');
    // Header/footer rows are suppressed in the filtered view.
    expect(logAfter).not.toHaveTextContent('run_started');
    expect(logAfter).not.toHaveTextContent('run_finished');
    expect(screen.getByLabelText('node card agent-1')).toBeInTheDocument();
  });

  it('clear chip removes the filter and restores the full log', async () => {
    render(<RunHistory workflowId="wf-1" />);
    fireEvent.click(await screen.findByLabelText('run r-a'));
    await screen.findByLabelText('event log');

    act(() => {
      useWorkflowStore.getState().selectNode('agent-1');
    });
    const clearBtn = await screen.findByLabelText('clear node filter');
    fireEvent.click(clearBtn);

    await waitFor(() =>
      expect(screen.getByLabelText('event log')).toHaveTextContent(
        'run_started',
      ),
    );
    expect(useWorkflowStore.getState().selectedNodeId).toBe(null);
  });

  it('ignores selection that has no events in the open run', async () => {
    render(<RunHistory workflowId="wf-1" />);
    fireEvent.click(await screen.findByLabelText('run r-a'));
    await screen.findByLabelText('event log');

    act(() => {
      useWorkflowStore.getState().selectNode('ghost-node');
    });

    // Filter chip should NOT appear; the full log keeps rendering.
    await waitFor(() =>
      expect(screen.getByLabelText('event log')).toHaveTextContent(
        'run_started',
      ),
    );
    expect(screen.queryByLabelText(/^filtered to node /)).toBeNull();
  });

  it('renders a scope block that expands to show the full record.scope', async () => {
    render(<RunHistory workflowId="wf-1" />);
    fireEvent.click(await screen.findByLabelText('run r-a'));
    const scopeToggle = await screen.findByLabelText('expand scope');
    expect(scopeToggle).toHaveTextContent(/2 keys/i);
    fireEvent.click(scopeToggle);

    const scopeRegion = screen.getByLabelText('run scope');
    expect(scopeRegion).toHaveTextContent('"inputs"');
    expect(scopeRegion).toHaveTextContent('"agent-1"');
    expect(scopeRegion).toHaveTextContent('"summary"');
    expect(scopeRegion).toHaveTextContent('"done"');
  });

  it('renders an i/o block that expands to show input + output JSON', async () => {
    render(<RunHistory workflowId="wf-1" />);
    fireEvent.click(await screen.findByLabelText('run r-a'));
    const card = await screen.findByLabelText('node card agent-1');

    // Open the card so the body (including the i/o toggle) is reachable.
    fireEvent.click(card.querySelector('button.event-card-head-toggle')!);
    const ioToggle = await screen.findByLabelText('expand i/o');
    fireEvent.click(ioToggle);

    expect(screen.getByLabelText('input')).toBeInTheDocument();
    expect(screen.getByLabelText('output')).toBeInTheDocument();
    // Short string from outputs renders verbatim.
    expect(screen.getByLabelText('output')).toHaveTextContent('"summary"');
    expect(screen.getByLabelText('output')).toHaveTextContent('"done"');
  });

  it('collapses long strings behind a show-more affordance', async () => {
    render(<RunHistory workflowId="wf-1" />);
    fireEvent.click(await screen.findByLabelText('run r-a'));
    const card = await screen.findByLabelText('node card agent-1');
    fireEvent.click(card.querySelector('button.event-card-head-toggle')!);
    fireEvent.click(await screen.findByLabelText('expand i/o'));

    const inputBlock = screen.getByLabelText('input');
    // Preview: first 200 chars of LONG_PROMPT, not the full 300.
    expect(inputBlock.textContent).not.toContain('a'.repeat(300));
    expect(inputBlock.textContent).toContain('a'.repeat(200));

    fireEvent.click(screen.getByLabelText('show more'));
    expect(inputBlock.textContent).toContain('a'.repeat(300));
  });

  it('clicking a node card header selects the node and requests a pan', async () => {
    render(<RunHistory workflowId="wf-1" />);
    fireEvent.click(await screen.findByLabelText('run r-a'));
    const card = await screen.findByLabelText('node card agent-1');
    // The header is rendered as a toggle button (card has body events).
    const header = card.querySelector('button.event-card-head-toggle');
    expect(header).not.toBeNull();
    fireEvent.click(header!);

    expect(useWorkflowStore.getState().selectedNodeId).toBe('agent-1');
    expect(useWorkflowStore.getState().panRequest).toMatchObject({
      nodeId: 'agent-1',
    });
  });

  it('surfaces a failure from /api/runs as an inline error', async () => {
    globalThis.fetch = mock(async () =>
      new Response('boom', { status: 500 }),
    ) as unknown as typeof fetch;

    render(<RunHistory workflowId="wf-1" />);
    await waitFor(() =>
      expect(screen.getByLabelText('run history error')).toBeInTheDocument(),
    );
  });
});
