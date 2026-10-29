'use client';

import { JsonView } from './RunLog';

/** Selected outputs captured when the run settled at its terminal End node. */
export default function FinalOutput({ outputs }: { outputs?: Record<string, unknown> }) {
  if (outputs === undefined) return null;

  return (
    <section className="iob iob-scope" aria-label="Final output">
      <h3 className="iob-toggle" style={{ margin: 0, cursor: 'default' }}>
        <span className="iob-toggle-label">Final output</span>
      </h3>
      <div className="iob-body">
        <JsonView value={outputs} />
      </div>
    </section>
  );
}
