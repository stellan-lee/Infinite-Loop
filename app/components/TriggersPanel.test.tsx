import { afterEach, describe, expect, test } from 'bun:test';
import { render, screen, waitFor } from '@testing-library/react';
import { TriggersPanel } from './TriggersPanel';
import type { Workflow } from '@/lib/shared/workflow';

const wf: Workflow = {
  id: 'wf-a', name: 'A', version: 1, createdAt: 0, updatedAt: 0,
  nodes: [{ id: 's', type: 'start', position: { x: 0, y: 0 }, config: {} }],
  edges: [],
};

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('TriggersPanel (summary card)', () => {
  test('shows trigger count fetched from /api/triggers?workflowId=', async () => {
    // @ts-expect-error
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ triggers: [{}, {}, {}] }) });
    render(<TriggersPanel workflow={wf} origin="http://localhost:3000" />);
    await waitFor(() => {
      expect(screen.getByText(/3 triggers route here/i)).toBeTruthy();
    });
  });

  test('singular wording for one trigger', async () => {
    // @ts-expect-error
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ triggers: [{}] }) });
    render(<TriggersPanel workflow={wf} origin="http://localhost:3000" />);
    await waitFor(() => {
      expect(screen.getByText(/1 trigger routes here/i)).toBeTruthy();
    });
  });

  test('links to home Dispatch for modified clicks and keeps the workflow filter', async () => {
    // @ts-expect-error
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ triggers: [] }) });
    render(<TriggersPanel workflow={wf} origin="http://localhost:3000" />);
    const link = screen.getByRole('link', { name: 'Manage in Dispatch →' });
    expect(link).toHaveAttribute('href', '/#dispatch?workflow=wf-a');
  });
});
