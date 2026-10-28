import { afterEach, expect, it, mock } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import { useDebouncedString } from './shared';
import { flushPendingWorkflow } from '../../../lib/client/workflow-navigation';
import { useWorkflowStore } from '../../../lib/client/workflow-store-client';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

it('flushes field edits before navigating and does not recommit on unmount', async () => {
  useWorkflowStore.setState({ currentWorkflow: { id: 'before', name: 'Before', version: 1, nodes: [], edges: [], createdAt: 1, updatedAt: 1 }, isDirty: false });
  const commit = mock((value: string) => useWorkflowStore.getState().setGlobals({ prompt: value }));
  const sent: unknown[] = [];
  globalThis.fetch = mock(async (_url: RequestInfo | URL, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response('{}');
  }) as unknown as typeof fetch;
  const { result, unmount } = renderHook(() => useDebouncedString('', commit, 60_000));
  act(() => result.current[1]('typed just now'));
  await act(async () => { await flushPendingWorkflow(); });
  expect(commit).toHaveBeenCalledTimes(1);
  expect(sent).toEqual([expect.objectContaining({ id: 'before', globals: { prompt: 'typed just now' } })]);
  useWorkflowStore.setState({ currentWorkflow: { id: 'after', name: 'After', version: 1, nodes: [], edges: [], createdAt: 1, updatedAt: 1 }, isDirty: false });
  unmount();
  expect(commit).toHaveBeenCalledTimes(1);
  expect(useWorkflowStore.getState().currentWorkflow?.globals).toBeUndefined();
});
