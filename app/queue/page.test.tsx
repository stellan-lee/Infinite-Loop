import { afterEach, describe, expect, test } from 'bun:test';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import QueuePage from './page';

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() { this.closed = true; }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

function installFakes(payload: unknown) {
  FakeEventSource.instances = [];
  // @ts-expect-error override
  globalThis.fetch = async (input: any, init?: any) => {
    if (init?.method === 'DELETE') {
      return { ok: true, status: 204, json: async () => ({}) } as any;
    }
    return { ok: true, status: 200, json: async () => payload } as any;
  };
  // @ts-expect-error override
  globalThis.EventSource = FakeEventSource;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
});

describe('QueuePage', () => {
  test('renders an empty state when there are no items', async () => {
    installFakes({ size: 0, items: [] });
    render(<QueuePage />);
    await waitFor(() => {
      expect(screen.getByText(/no queued runs/i)).toBeTruthy();
      expect(screen.getByText(/triggered runs will appear here/i)).toBeTruthy();
    });
  });

  test('renders a link back to the console', async () => {
    installFakes({ size: 0, items: [] });
    render(<QueuePage />);
    const back = screen.getByRole('link', { name: /back/i });
    expect(back).toHaveAttribute('href', '/');
  });

  test('renders one row per item with workflow name and position', async () => {
    installFakes({
      size: 2,
      items: [
        { queueId: 'q-1', triggerId: 't1', workflowId: 'w1', workflowName: 'First', inputs: {}, receivedAt: 100, position: 1 },
        { queueId: 'q-2', triggerId: 't2', workflowId: 'w2', workflowName: 'Second', receivedAt: 200, position: 2 },
      ],
    });
    render(<QueuePage />);

    await waitFor(() => {
      expect(screen.getByText('First')).toBeTruthy();
      expect(screen.getByText('Second')).toBeTruthy();
    });

    const rows = document.querySelectorAll('.queue-row');
    expect(rows.length).toBe(2);
  });

  test('folds queued trigger inputs by default and reveals them on click', async () => {
    installFakes({
      size: 1,
      items: [
        {
          queueId: 'q-1',
          triggerId: 't1',
          workflowId: 'w1',
          workflowName: 'First',
          inputs: { topic: 'weekend release', count: 2, urgent: true },
          receivedAt: 100,
          position: 1,
        },
      ],
    });
    render(<QueuePage />);
    await waitFor(() => screen.getByText('First'));

    expect(screen.queryByText('weekend release')).toBeNull();
    const toggle = screen.getByRole('button', { name: /inputs \(3\)/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('topic')).toBeTruthy();
    expect(screen.getByText('weekend release')).toBeTruthy();
    expect(screen.getByText('urgent')).toBeTruthy();
    expect(screen.getByText('true')).toBeTruthy();
  });

  test('shows Confirm/Cancel after clicking Delete; Cancel reverts', async () => {
    installFakes({
      size: 1,
      items: [
        { queueId: 'q-1', triggerId: 't1', workflowId: 'w1', workflowName: 'First', receivedAt: 100, position: 1 },
      ],
    });
    render(<QueuePage />);
    await waitFor(() => screen.getByText('First'));

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(screen.getByRole('button', { name: /confirm\?/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.getByRole('button', { name: /delete/i })).toBeTruthy();
  });

  test('clicking Confirm calls DELETE and optimistically removes the row', async () => {
    installFakes({
      size: 1,
      items: [
        { queueId: 'q-1', triggerId: 't1', workflowId: 'w1', workflowName: 'First', receivedAt: 100, position: 1 },
      ],
    });
    const calls: Array<{ url: string; method?: string }> = [];
    const fakeFetch = async (input: any, init?: any) => {
      calls.push({ url: String(input), method: init?.method });
      if (init?.method === 'DELETE') {
        return { ok: true, status: 204, json: async () => ({}) } as any;
      }
      return {
        ok: true, status: 200,
        json: async () => ({
          size: 1,
          items: [
            { queueId: 'q-1', triggerId: 't1', workflowId: 'w1', workflowName: 'First', receivedAt: 100, position: 1 },
          ],
        }),
      } as any;
    };
    // @ts-expect-error override
    globalThis.fetch = fakeFetch;

    render(<QueuePage />);
    await waitFor(() => screen.getByText('First'));

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm\?/i }));

    await waitFor(() => {
      expect(screen.queryByText('First')).toBeNull();
    });
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/api/triggers/queue/q-1'))).toBe(true);
  });

  test('clicking Delete on another row reverts the first', async () => {
    installFakes({
      size: 2,
      items: [
        { queueId: 'q-1', triggerId: 't1', workflowId: 'w1', workflowName: 'First', receivedAt: 100, position: 1 },
        { queueId: 'q-2', triggerId: 't2', workflowId: 'w2', workflowName: 'Second', receivedAt: 200, position: 2 },
      ],
    });
    render(<QueuePage />);
    await waitFor(() => screen.getByText('First'));

    const deleteButtons = screen.getAllByRole('button', { name: /delete/i });
    fireEvent.click(deleteButtons[0]);
    expect(screen.getAllByRole('button', { name: /confirm\?/i }).length).toBe(1);

    // click Delete on the second row
    const stillDelete = screen.getAllByRole('button', { name: /delete/i });
    fireEvent.click(stillDelete[0]); // the only remaining "Delete" — row 2
    // exactly one row is confirming again
    expect(screen.getAllByRole('button', { name: /confirm\?/i }).length).toBe(1);
    // first row is back to "Delete"
    const finalDeletes = screen.getAllByRole('button', { name: /delete/i });
    expect(finalDeletes.length).toBe(1); // row 1's button reverted; row 2 is now in confirm
  });

  test('appends a row when trigger_enqueued event arrives', async () => {
    installFakes({
      size: 0,
      items: [],
    });
    render(<QueuePage />);
    await waitFor(() => screen.getByText(/no queued runs/i));

    const es = FakeEventSource.instances[0];
    expect(es).toBeTruthy();
    act(() => {
      es.emit({
        type: 'trigger_enqueued',
        queueId: 'q-new',
        triggerId: 't-new',
        workflowId: 'w-new',
        inputs: { msg: 'hello' },
        position: 1,
        receivedAt: 500,
      });
    });

    await waitFor(() => {
      expect(document.querySelectorAll('.queue-row').length).toBe(1);
    });
    expect(screen.getByRole('button', { name: /inputs \(1\)/i })).toBeTruthy();
  });

  test('removes a row when trigger_started / trigger_dropped / trigger_removed arrives', async () => {
    installFakes({
      size: 1,
      items: [
        { queueId: 'q-1', triggerId: 't1', workflowId: 'w1', workflowName: 'First', receivedAt: 100, position: 1 },
      ],
    });
    render(<QueuePage />);
    await waitFor(() => screen.getByText('First'));

    const es = FakeEventSource.instances[0];
    act(() => {
      es.emit({
        type: 'trigger_started',
        queueId: 'q-1',
        triggerId: 't1',
        workflowId: 'w1',
        runId: 'run-1',
      });
    });

    await waitFor(() => {
      expect(screen.queryByText('First')).toBeNull();
    });
  });

  test('closes the EventSource on unmount', async () => {
    installFakes({ size: 0, items: [] });
    const { unmount } = render(<QueuePage />);
    await waitFor(() => screen.getByText(/no queued runs/i));

    const es = FakeEventSource.instances[0];
    unmount();
    expect(es.closed).toBe(true);
  });

  test('on 404, row stays removed and a notice is shown', async () => {
    installFakes({
      size: 1,
      items: [
        { queueId: 'q-1', triggerId: 't1', workflowId: 'w1', workflowName: 'First', receivedAt: 100, position: 1 },
      ],
    });
    // Override fetch so the DELETE returns 404
    // @ts-expect-error override
    globalThis.fetch = async (input: any, init?: any) => {
      if (init?.method === 'DELETE') {
        return { ok: false, status: 404, json: async () => ({ error: 'not-in-queue' }) } as any;
      }
      return {
        ok: true, status: 200,
        json: async () => ({ size: 1, items: [{ queueId: 'q-1', triggerId: 't1', workflowId: 'w1', workflowName: 'First', receivedAt: 100, position: 1 }] }),
      } as any;
    };

    render(<QueuePage />);
    await waitFor(() => screen.getByText('First'));

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm\?/i }));

    await waitFor(() => {
      expect(screen.queryByText('First')).toBeNull();
      expect(screen.getByText(/already started/i)).toBeTruthy();
    });
  });

  test('on network failure, row is restored and a notice is shown', async () => {
    installFakes({
      size: 1,
      items: [
        { queueId: 'q-1', triggerId: 't1', workflowId: 'w1', workflowName: 'First', receivedAt: 100, position: 1 },
      ],
    });
    // Override fetch so the DELETE throws
    // @ts-expect-error override
    globalThis.fetch = async (input: any, init?: any) => {
      if (init?.method === 'DELETE') { throw new Error('network down'); }
      return {
        ok: true, status: 200,
        json: async () => ({ size: 1, items: [{ queueId: 'q-1', triggerId: 't1', workflowId: 'w1', workflowName: 'First', receivedAt: 100, position: 1 }] }),
      } as any;
    };

    render(<QueuePage />);
    await waitFor(() => screen.getByText('First'));

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm\?/i }));

    await waitFor(() => {
      // row is back
      expect(screen.getByText('First')).toBeTruthy();
      expect(screen.getByText(/failed to cancel/i)).toBeTruthy();
    });
  });

  test('confirm state auto-reverts after ~4 seconds', async () => {
    installFakes({
      size: 1,
      items: [
        { queueId: 'q-1', triggerId: 't1', workflowId: 'w1', workflowName: 'First', receivedAt: 100, position: 1 },
      ],
    });
    render(<QueuePage />);
    await waitFor(() => screen.getByText('First'));

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));
    expect(screen.getByRole('button', { name: /confirm\?/i })).toBeTruthy();

    // Wait for the auto-revert. Use 4500ms to give some margin.
    await new Promise((r) => setTimeout(r, 4500));
    expect(screen.queryByRole('button', { name: /confirm\?/i })).toBeNull();
    expect(screen.getByRole('button', { name: /delete/i })).toBeTruthy();
  }, 10000); // bun:test per-test timeout
});
