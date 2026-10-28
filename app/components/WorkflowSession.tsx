'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useAutoSave } from '../../lib/client/use-auto-save';
import { useWorkflowStore } from '../../lib/client/workflow-store-client';
import { flushPendingWorkflow } from '../../lib/client/workflow-navigation';

/** Lives across page changes so browser Back cannot cancel the autosave timer. */
export default function WorkflowSession() {
  useAutoSave();
  const pathname = usePathname();
  const isDirty = useWorkflowStore((s) => s.isDirty);
  const [error, setError] = useState<string | null>(null);
  const save = useCallback(async () => {
    try {
      await flushPendingWorkflow();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save changes');
    }
  }, []);

  useEffect(() => { void save(); }, [pathname, save]);
  useEffect(() => { if (!isDirty) setError(null); }, [isDirty]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!useWorkflowStore.getState().isDirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);

  if (!error) return null;
  return (
    <div className="workflow-save-error" role="alert">
      <span>Changes are still in this browser. {error}.</span>
      <button type="button" className="btn" onClick={() => void save()}>Retry save</button>
    </div>
  );
}
