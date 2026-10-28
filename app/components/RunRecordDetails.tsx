'use client';

import { useState } from 'react';
import type { RunRecord } from '../../lib/shared/workflow';
import { GroupedEventLog, JsonView } from './RunLog';

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m${rem}s`;
}

/** Shared recorded-run content. Canvas selection remains owned by the caller. */
export default function RunRecordDetails({ record, filterNodeId, onCardActivate }: {
  record: RunRecord;
  filterNodeId?: string;
  onCardActivate?: (nodeId: string) => void;
}) {
  return (
    <>
      <div className="run-view-log-row" aria-label="run metadata">
        <span className="run-view-log-type">started</span>
        <span className="run-view-log-payload">
          {fmtTime(record.startedAt)}
        </span>
      </div>
      <div className="run-view-log-row">
        <span className="run-view-log-type">duration</span>
        <span className="run-view-log-payload">
          {fmtDuration(record.durationMs)}
        </span>
      </div>
      {record.errorMessage ? (
        <div className="run-view-log-row">
          <span className="run-view-log-type">error</span>
          <span className="run-view-log-payload">
            {record.errorMessage}
          </span>
        </div>
      ) : null}
      {record.truncated ? (
        <div className="run-view-log-row">
          <span className="run-view-log-type">notice</span>
          <span className="run-view-log-payload">
            event log truncated — earliest events were dropped
          </span>
        </div>
      ) : null}

      <ScopeBlock scope={record.scope} />

      <RecordedEventLog
        record={record}
        filterNodeId={filterNodeId}
        onCardActivate={onCardActivate}
      />
    </>
  );
}

/** Collapsible "scope" view above the event log: shows the run's entire
 * accumulated scope (node outputs + seeded `inputs`/`globals`) as pretty
 * JSON. Reuses JsonView for long-string handling. Omitted entirely when
 * scope is empty so the panel stays uncluttered for trivial runs. */
function ScopeBlock({ scope }: { scope: Record<string, Record<string, unknown>> }) {
  const [open, setOpen] = useState(false);
  const keys = Object.keys(scope);
  if (keys.length === 0) return null;
  return (
    <section className="iob iob-scope" aria-label="run scope">
      <button
        type="button"
        className="iob-toggle"
        aria-expanded={open}
        aria-label={`${open ? 'collapse' : 'expand'} scope`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="iob-toggle-label">scope</span>
        <span className="iob-toggle-hint">
          {keys.length} {keys.length === 1 ? 'key' : 'keys'}
        </span>
        <span className="iob-toggle-fold" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? (
        <div className="iob-body">
          <JsonView value={scope} />
        </div>
      ) : null}
    </section>
  );
}

function RecordedEventLog({
  record,
  filterNodeId,
  onCardActivate,
}: {
  record: RunRecord;
  filterNodeId?: string;
  onCardActivate?: (nodeId: string) => void;
}) {
  return (
    <div className="run-view-log" aria-label="event log">
      <GroupedEventLog
        events={record.events}
        filterNodeId={filterNodeId}
        onCardActivate={onCardActivate}
        showIO
      />
    </div>
  );
}
