'use client';

import { useWorkflowStore } from './workflow-store-client';

export const workflowPath = (id: string) => `/${encodeURIComponent(id)}`;

const pendingEditors = new Set<() => void>();

/** Debounced fields register their existing commit callback for navigation. */
export function registerWorkflowEditor(commit: () => void): () => void {
  pendingEditors.add(commit);
  return () => { pendingEditors.delete(commit); };
}

/** Do not replace the editor's single document until every pending edit is saved. */
export async function flushPendingWorkflow(): Promise<void> {
  for (const commit of pendingEditors) commit();
  while (useWorkflowStore.getState().isDirty) {
    await useWorkflowStore.getState().saveCurrentWorkflow();
    for (const commit of pendingEditors) commit();
  }
}

export function clearCurrentWorkflow(): void {
  useWorkflowStore.setState({
    currentWorkflow: null,
    isDirty: false,
    selectedNodeId: null,
    past: [],
    future: [],
    panRequest: null,
    inspectedRunEvents: null,
  });
  useWorkflowStore.getState().resetRun();
}
