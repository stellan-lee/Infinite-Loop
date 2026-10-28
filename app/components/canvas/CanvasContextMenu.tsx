'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NodeType } from '@/lib/shared/workflow';
import type { ProviderInfo } from '@/lib/server/providers/types';

export interface ContextMenuItem {
  type: NodeType;
  label: string;
  /** Required when `type === 'agent'` — selects the provider for the new node. */
  providerId?: string;
}

export interface ContextMenuOpenAt {
  /** Viewport-relative coordinates (clientX/clientY) — used for menu placement. */
  clientX: number;
  clientY: number;
  /** Flow-graph coordinates — used as the new node's position. */
  flowX: number;
  flowY: number;
}

interface Props {
  open: ContextMenuOpenAt | null;
  onClose: () => void;
  onPick: (item: ContextMenuItem, at: ContextMenuOpenAt) => void;
}

const STATIC_GROUPS: Array<{ heading: string; items: ContextMenuItem[] }> = [
  {
    heading: 'Control',
    items: [
      { type: 'start', label: 'Start' },
      { type: 'end', label: 'End' },
      { type: 'loop', label: 'Loop' },
      { type: 'branch', label: 'If' },
      { type: 'condition', label: 'Condition' },
      { type: 'manual', label: 'Manual' },
    ],
  },
  {
    heading: 'AI',
    items: [{ type: 'structured-output', label: 'OpenAI' }],
  },
  {
    heading: 'Scripts',
    items: [{ type: 'script', label: 'Script' }],
  },
  {
    heading: 'Annotations',
    items: [{ type: 'sidenote', label: 'Note' }],
  },
];

/**
 * Right-click menu for the canvas. Same node catalog as the Palette but
 * placed at the cursor and skipping the drag gesture. Loop adoption is the
 * caller's job — see Canvas.tsx onContextMenuPick.
 */
export default function CanvasContextMenu({ open, onClose, onPick }: Props) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const [providersError, setProvidersError] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [clamped, setClamped] = useState<{ top: number; left: number } | null>(null);

  // Fetch the provider list once on mount; the menu reuses it across opens.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/providers')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: { providers?: ProviderInfo[] }) => {
        if (!cancelled) {
          if (Array.isArray(data.providers)) setProviders(data.providers);
          setProvidersLoaded(true);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setProvidersError(true);
          setProvidersLoaded(true);
          console.warn('[context-menu] failed to load providers:', err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Close on click-outside / Escape. Bound only while the menu is open so
  // the rest of the app keeps its keyboard shortcuts.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      // Right-click is handled by the canvas's onContextMenu (it toggles
      // the menu open ⇆ closed). Skip it here so the same right-click
      // doesn't close-then-reopen the menu in two competing handlers.
      if (e.button !== 0) return;
      const root = rootRef.current;
      if (!root) return;
      if (!root.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    // CAPTURE PHASE — xyflow's pane handlers call stopPropagation() on
    // native mousedown, which would prevent a bubble-phase document listener
    // from ever seeing the event. Listening in capture means we run BEFORE
    // xyflow gets the chance to suppress the bubble. Clicks inside the menu
    // are filtered by `root.contains(target)` below, so this is safe.
    document.addEventListener('mousedown', onMouseDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onMouseDown, true);
    };
  }, [open, onClose]);

  // Re-clamp after provider loading and viewport changes; the menu itself
  // scrolls if the viewport is shorter than its full contents.
  useLayoutEffect(() => {
    if (!open) {
      setClamped(null);
      return;
    }
    const root = rootRef.current;
    if (!root) return;
    const update = () => {
      const viewport = window.visualViewport;
      const x = viewport?.offsetLeft ?? 0;
      const y = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      root.style.maxWidth = `${Math.max(0, width - 16)}px`;
      root.style.minWidth = `${Math.min(200, Math.max(0, width - 16))}px`;
      root.style.maxHeight = `${Math.max(0, height - 16)}px`;
      const rect = root.getBoundingClientRect();
      const top = Math.max(y + 8, Math.min(open.clientY, y + height - rect.height - 8));
      const left = Math.max(x + 8, Math.min(open.clientX, x + width - rect.width - 8));
      setClamped((previous) => previous?.top === top && previous.left === left ? previous : { top, left });
    };
    update();
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
    };
  }, [open, providers.length]);

  if (!open) return null;

  const groups = [
    ...STATIC_GROUPS,
    {
      heading: 'Model Runners',
      items: providers.map<ContextMenuItem>((p) => ({
        type: 'agent',
        label: p.label,
        providerId: p.id,
      })),
    },
  ];

  const style: React.CSSProperties = {
    position: 'fixed',
    top: clamped?.top ?? open.clientY,
    left: clamped?.left ?? open.clientX,
    zIndex: 1100,
  };

  return createPortal(
    <div
      ref={rootRef}
      role="menu"
      aria-label="canvas context menu"
      className="canvas-context-menu"
      style={style}
      // Stop xyflow + the canvas from receiving the mousedown that originated
      // inside the menu — without this, clicking an item would simultaneously
      // dismiss the canvas selection state.
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {groups.map((group) => {
        const isModelRunners = group.heading === 'Model Runners';
        const showLoading = isModelRunners && !providersLoaded;
        const showEmpty = group.items.length === 0 && !showLoading;
        return (
          <section key={group.heading} className="ccm-section">
            <h4 className="ccm-heading">{group.heading}</h4>
            {showLoading && (
              <div className="ccm-empty serif-italic">loading…</div>
            )}
            {showEmpty && (
              <div className="ccm-empty serif-italic">
                {isModelRunners && providersError
                  ? 'failed to load providers'
                  : 'none available'}
              </div>
            )}
            {!showLoading && group.items.length > 0 && (
              <ul className="ccm-list">
                {group.items.map((item) => (
                  <li key={`${item.type}:${item.providerId ?? item.type}`}>
                    <button
                      type="button"
                      role="menuitem"
                      aria-label={
                        item.providerId
                          ? `add ${item.providerId} agent node`
                          : `add ${item.type} node`
                      }
                      className="ccm-item"
                      onClick={() => {
                        onPick(item, open);
                        onClose();
                      }}
                    >
                      {item.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>,
    document.body,
  );
}
