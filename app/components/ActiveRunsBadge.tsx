'use client';

import React, { useEffect, useState } from 'react';

interface ActiveRunsState {
  runs: number;
  capacity: number;
  slotHolders: number;
  slotWaiters: number;
}

/**
 * Live badge showing the engine's concurrent-runs state.
 *   "running N / cap M • K waiting"
 *
 * Polls /api/run every few seconds. Stays hidden when nothing is in flight
 * and no slot pressure is building, so single-run workflows don't see new
 * chrome.
 */
export function ActiveRunsBadge({ pollMs = 3000 }: { pollMs?: number }) {
  const [state, setState] = useState<ActiveRunsState | null>(null);

  useEffect(() => {
    let alive = true;

    async function tick() {
      try {
        const res = await fetch('/api/run');
        if (!res.ok) return;
        const json = (await res.json()) as {
          runs?: Array<{ runId: string }>;
          slotPool?: { capacity: number; size: number; waiters: number };
        };
        if (!alive) return;
        const runs = json.runs?.length ?? 0;
        const cap = json.slotPool?.capacity ?? 0;
        const slotHolders = json.slotPool?.size ?? 0;
        const slotWaiters = json.slotPool?.waiters ?? 0;
        setState({ runs, capacity: cap, slotHolders, slotWaiters });
      } catch {
        /* ignore transient fetch errors */
      }
    }

    void tick();
    const handle = setInterval(tick, pollMs);
    return () => {
      alive = false;
      clearInterval(handle);
    };
  }, [pollMs]);

  if (!state || (state.runs === 0 && state.slotWaiters === 0)) return null;

  const label =
    state.slotWaiters > 0
      ? `${state.slotHolders}/${state.capacity} • ${state.slotWaiters} waiting`
      : state.runs > 1
        ? `${state.runs} runs`
        : null;

  if (!label) return null;

  return (
    <span className="active-runs-badge" title="Concurrent runs">
      {label}
    </span>
  );
}
