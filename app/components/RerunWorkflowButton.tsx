'use client';

import { useEffect, useRef, useState } from 'react';
import type { RunRecord } from '../../lib/shared/workflow';
import styles from './RerunWorkflowButton.module.css';

type Result = { status: 'idle' } | { status: 'pending' } | { status: 'error'; message: string } | { status: 'started'; runId: string };

function savedInputs(scope: RunRecord['scope']): Record<string, unknown> {
  // History contains the final execution scope. Only its input aliases may
  // seed a new run; node outputs and other final state must not be replayed.
  for (const candidate of [scope.__inputs, scope.inputs]) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>;
    }
  }
  return {};
}

async function errorMessage(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: unknown; field?: unknown; reason?: unknown } | null;
  if (body?.error === 'invalid-inputs' && typeof body.field === 'string' && typeof body.reason === 'string') {
    return `Cannot rerun: input "${body.field}" is ${body.reason}.`;
  }
  if (body && typeof body.error === 'string') return `Cannot rerun: ${body.error}`;
  return `Cannot rerun workflow (${response.status}).`;
}

export default function RerunWorkflowButton({ record }: { record: RunRecord }) {
  const inputs = savedInputs(record.scope);
  const [result, setResult] = useState<Result>({ status: 'idle' });
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const rerun = async () => {
    // A ref closes the gap before React commits the disabled button.
    if (inFlight.current) return;
    inFlight.current = true;
    setResult({ status: 'pending' });
    try {
      const response = await fetch('/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workflowId: record.workflowId, inputs }),
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      const body = await response.json().catch(() => null) as { runId?: unknown } | null;
      if (!body || typeof body.runId !== 'string' || !body.runId) {
        throw new Error('Could not confirm the new run ID. Check Jobs before trying again.');
      }
      if (mounted.current) setResult({ status: 'started', runId: body.runId });
    } catch (error) {
      if (mounted.current) setResult({ status: 'error', message: error instanceof Error ? error.message : 'Could not start the workflow.' });
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <div className={styles.rerun}>
      {Object.keys(inputs).length > 0 && (
        <section className={styles.inputs} aria-label="recorded inputs">
          <h3>Inputs</h3>
          <dl>
            {Object.entries(inputs).map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{typeof value === 'string' ? value || '""' : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value) ?? String(value)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <button type="button" className="btn" onClick={() => void rerun()} disabled={result.status === 'pending'}>Rerun workflow</button>
      <p>Starts the latest saved workflow with available inputs from this run.</p>
      {result.status === 'pending' && <p role="status">Starting new run…</p>}
      {result.status === 'error' && <p role="alert">{result.message}</p>}
      {result.status === 'started' && <p role="status">Started new run {result.runId}.</p>}
    </div>
  );
}
