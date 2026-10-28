'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';

export interface QueueBadgeProps {
  /** Poll interval; default 3000 ms. */
  pollMs?: number;
  onNavigate?: (href: string) => Promise<void>;
}

export function QueueBadge({ pollMs = 3000, onNavigate }: QueueBadgeProps) {
  const [size, setSize] = useState(0);

  useEffect(() => {
    let alive = true;

    async function tick() {
      try {
        const res = await fetch('/api/triggers/queue');
        if (!res.ok) return;
        const json = (await res.json()) as { size: number };
        if (alive) setSize(json.size);
      } catch {
        /* ignore */
      }
    }

    void tick();
    const handle = setInterval(tick, pollMs);
    return () => {
      alive = false;
      clearInterval(handle);
    };
  }, [pollMs]);

  if (size === 0) return null;

  return (
    <Link href="/queue" className="queue-badge" onClick={(event) => {
      if (!onNavigate || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      void onNavigate('/queue').catch(() => {});
    }}>
      {size} queued
    </Link>
  );
}
