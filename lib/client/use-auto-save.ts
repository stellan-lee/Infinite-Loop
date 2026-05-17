'use client';

import { useEffect } from 'react';
import { useWorkflowStore } from './workflow-store-client';

/**
 * Subscribes to the workflow store and auto-persists changes after a quiet
 * period. Replaces the explicit "Save" button — every meaningful edit
 * (move a node, change a config field, add an edge) flips `isDirty`, which
 * arms a debounced PUT to /api/workflows/{id}. If the user keeps editing,
 * the timer resets so we don't hammer the disk during a long gesture.
 *
 * Failures are logged and left on `isDirty: true` — the next mutation will
 * retry. We don't surface a toast here because the user already sees the
 * trigger label's "•" indicator while there are unsaved edits.
 */
export function useAutoSave(delayMs = 800): void {
  const isDirty = useWorkflowStore((s) => s.isDirty);
  const currentWorkflowId = useWorkflowStore((s) => s.currentWorkflow?.id);
  const save = useWorkflowStore((s) => s.saveCurrentWorkflow);

  useEffect(() => {
    if (!isDirty || !currentWorkflowId) return;
    // Capture the workflow id at schedule time. If the user switches
    // workflows before the timer fires, React clears the timer via this
    // effect's cleanup — but a switch that lands inside the timer's
    // callback ordering still needs a guard, otherwise `save()` would
    // PUT whatever workflow happens to be current and silently lose the
    // dirty edits to the original.
    const scheduledForId = currentWorkflowId;
    const t = setTimeout(() => {
      const stillCurrent = useWorkflowStore.getState().currentWorkflow?.id;
      if (stillCurrent !== scheduledForId) return;
      save().catch((err) => {
        console.warn('[autosave] failed:', err);
      });
    }, delayMs);
    return () => clearTimeout(t);
  }, [isDirty, currentWorkflowId, save, delayMs]);
}
