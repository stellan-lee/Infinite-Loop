import { afterEach, beforeEach, expect, it, mock } from 'bun:test';
import { useWorkflowStore } from './workflow-store-client';
import { flushPendingWorkflow } from './workflow-navigation';
import type { Workflow } from '../shared/workflow';

const workflow: Workflow = {
  id: 'navigation-test', name: 'Navigation', version: 1,
  nodes: [], edges: [], createdAt: 1, updatedAt: 1,
};
const originalFetch = globalThis.fetch;

beforeEach(() => {
  useWorkflowStore.setState({ currentWorkflow: workflow, isDirty: true });
});
afterEach(() => { globalThis.fetch = originalFetch; });

it('does not mark newer edits clean when an earlier save completes', async () => {
  let finish!: (response: Response) => void;
  globalThis.fetch = mock(() => new Promise<Response>((resolve) => { finish = resolve; })) as unknown as typeof fetch;
  const save = useWorkflowStore.getState().saveCurrentWorkflow();
  useWorkflowStore.getState().setGlobals({ later: 'edit' });
  finish(new Response('{}'));
  await save;
  expect(useWorkflowStore.getState().isDirty).toBe(true);
});

it('flushes edits made during an in-flight save before navigation can proceed', async () => {
  let finish!: (response: Response) => void;
  const sent: Workflow[] = [];
  globalThis.fetch = mock((_url: RequestInfo | URL, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Workflow);
    if (sent.length === 1) return new Promise<Response>((resolve) => { finish = resolve; });
    return Promise.resolve(new Response('{}'));
  }) as unknown as typeof fetch;
  const flushing = flushPendingWorkflow();
  useWorkflowStore.getState().setGlobals({ later: 'edit' });
  finish(new Response('{}'));
  await flushing;
  expect(sent).toHaveLength(2);
  expect(sent[1].globals).toEqual({ later: 'edit' });
  expect(useWorkflowStore.getState().isDirty).toBe(false);
});

it('retains the dirty workflow when navigation cannot save', async () => {
  globalThis.fetch = mock(async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
  await expect(flushPendingWorkflow()).rejects.toThrow('save failed: 503');
  expect(useWorkflowStore.getState().currentWorkflow).toBe(workflow);
  expect(useWorkflowStore.getState().isDirty).toBe(true);
});
