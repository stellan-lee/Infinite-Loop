'use client';

import { useCallback, useEffect, useState } from 'react';
import type { IconType } from 'react-icons';
import {
  LuCode,
  LuColumns3,
  LuFilter,
  LuGitBranch,
  LuLayers,
  LuPlay,
  LuRepeat,
  LuScale,
  LuSquare,
  LuStickyNote,
} from 'react-icons/lu';
import type { NodeType } from '@/lib/shared/workflow';
import type { ProviderInfo } from '@/lib/server/providers/types';
import ProviderIcon from './icons/ProviderIcon';
import HermesConnectionsModal from './HermesConnectionsModal';
import { refreshProviders } from '@/lib/client/use-providers';

const DRAG_MIME = 'application/x-infinite-loop-node';
const ADD_NODE_EVENT = 'infinite-loop:add-node';

interface DragPayload {
  type: NodeType;
  /** Required when `type === 'agent'`; selects the provider for the new node. */
  providerId?: string;
}

interface PaletteItem {
  type: NodeType;
  name: string;
  /** Lucide icon for static (non-provider) items. Provider items don't
   * set this — they go through `ProviderIcon` so brand marks render
   * correctly. */
  Icon?: IconType;
  /** Plain unicode fallback used by provider items when their brand
   * icon isn't registered (and as a safety net for any item missing
   * `Icon`). */
  glyph: string;
  description: string;
  providerId?: string;
  /** Parent connection id, set by the loader for hermes-local manifests
   * so the palette can group profiles under their connection. */
  connectionId?: string;
  /** Display label for the parent connection (the user-typed label on
   * the `.hermes.local.json` file). */
  connectionLabel?: string;
}

interface HermesGroup {
  connectionId: string;
  connectionLabel: string;
  items: PaletteItem[];
}

interface PaletteCategory {
  /** Unique key for React + the collapse state map. */
  id: string;
  heading: string;
  items: PaletteItem[];
}

const STATIC_CATEGORIES: PaletteCategory[] = [
  {
    id: 'control',
    heading: 'Control',
    items: [
      { type: 'start', name: 'Start', Icon: LuPlay, glyph: '◇', description: 'begin a workflow' },
      { type: 'end', name: 'End', Icon: LuSquare, glyph: '◆', description: 'settle the run' },
      { type: 'loop', name: 'Loop', Icon: LuRepeat, glyph: '↻', description: 'repeat until met' },
      { type: 'branch', name: 'If', Icon: LuGitBranch, glyph: '⋔', description: 'if/else on a value' },
      { type: 'condition', name: 'Condition', Icon: LuFilter, glyph: '◷', description: 'evaluate a condition' },
    ],
  },
  {
    id: 'multi-agent',
    heading: 'Multi-agent',
    items: [
      { type: 'parallel', name: 'Parallel', Icon: LuColumns3, glyph: '⫲', description: 'fan out concurrent branches' },
      { type: 'subworkflow', name: 'Subworkflow', Icon: LuLayers, glyph: '⊞', description: 'call another workflow' },
      { type: 'judge', name: 'Judge', Icon: LuScale, glyph: '⚖', description: 'pick best of N candidates' },
    ],
  },
  {
    id: 'scripts',
    heading: 'Scripts',
    items: [
      { type: 'script', name: 'Script', Icon: LuCode, glyph: '⌨', description: 'run inline TypeScript (Bun) or Python (python3)' },
    ],
  },
  {
    id: 'annotations',
    heading: 'Annotations',
    items: [
      { type: 'sidenote', name: 'Note', Icon: LuStickyNote, glyph: '✎', description: 'pin a free-form note to the canvas' },
    ],
  },
];

function providerToItem(p: ProviderInfo): PaletteItem {
  return {
    type: 'agent',
    name: p.label,
    glyph: p.glyph ?? '⟳',
    description: p.description,
    providerId: p.id,
    connectionId: p.connectionId,
    connectionLabel: p.connectionLabel,
  };
}

/** Partition providers into the flat list shown directly under Model
 * Runners and Hermes connections grouped by their parent. Split is by
 * `kind` (set by the loader for `*.hermes.local.json`), not transport —
 * so a future committed HTTP manifest still appears at the top level.
 *
 * Within Hermes, manifests are grouped by `connectionId` so the user
 * sees which profiles came from which connection file. Items with a
 * missing `connectionId` (shouldn't happen, but defensive) fall into a
 * synthetic `<orphan>` group. */
function partitionProviders(
  providers: ProviderInfo[],
): { topLevel: PaletteItem[]; hermesGroups: HermesGroup[] } {
  const topLevel: PaletteItem[] = [];
  const groupMap = new Map<string, HermesGroup>();
  const groupOrder: string[] = [];
  for (const p of providers) {
    if (p.kind !== 'hermes-local') {
      topLevel.push(providerToItem(p));
      continue;
    }
    const connectionId = p.connectionId ?? '<orphan>';
    const connectionLabel = p.connectionLabel ?? p.connectionId ?? '(unknown)';
    let g = groupMap.get(connectionId);
    if (!g) {
      g = { connectionId, connectionLabel, items: [] };
      groupMap.set(connectionId, g);
      groupOrder.push(connectionId);
    }
    g.items.push(providerToItem(p));
  }
  // Stable order: connections appear by first-seen (loader sort = by
  // label). Items within each connection also keep loader order so
  // alphabetized profiles are predictable.
  const hermesGroups = groupOrder.map((id) => groupMap.get(id) as HermesGroup);
  return { topLevel, hermesGroups };
}

function handleDragStart(
  e: React.DragEvent<HTMLButtonElement>,
  item: PaletteItem,
): void {
  const payload: DragPayload = { type: item.type };
  if (item.providerId) payload.providerId = item.providerId;
  e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
  e.dataTransfer.effectAllowed = 'copy';
  if (process.env.NODE_ENV !== 'production') {
    console.debug('[palette] dragstart', payload);
  }
}

function handlePaletteItemClick(item: PaletteItem): void {
  if (typeof window === 'undefined') return;
  const isMobileLayout = window.matchMedia('(max-width: 920px)').matches;
  if (!isMobileLayout) return;
  const payload: DragPayload = { type: item.type };
  if (item.providerId) payload.providerId = item.providerId;
  window.dispatchEvent(new CustomEvent(ADD_NODE_EVENT, { detail: payload }));
}

export default function Palette() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  // Open by default; clicking the Hermes subgroup header toggles it.
  const [hermesOpen, setHermesOpen] = useState(true);

  // Lifted into a callback so the connections modal can ask us to re-fetch
  // after a create/update/delete and the new card shows up immediately.
  // Also invalidates the shared `useProviders` cache so any AgentNode
  // already on the canvas (which reads from that cache) refreshes its
  // icon + auto-title in lock-step.
  const loadProviders = useCallback(() => {
    let cancelled = false;
    refreshProviders();
    fetch('/api/providers')
      .then((r) => r.json())
      .then((data: { providers?: ProviderInfo[] }) => {
        if (!cancelled && Array.isArray(data.providers)) {
          setProviders(data.providers);
        }
      })
      .catch((err) => {
        console.warn('[palette] failed to load providers:', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const cancel = loadProviders();
    return cancel;
  }, [loadProviders]);

  const { topLevel: topLevelProviderItems, hermesGroups } =
    partitionProviders(providers);
  const modelRunners: PaletteCategory = {
    id: 'model-runners',
    heading: 'Model Runners',
    items: topLevelProviderItems,
  };
  const categories: PaletteCategory[] = [...STATIC_CATEGORIES, modelRunners];
  // Total count across all connections, shown next to the Hermes
  // subgroup header so it matches the flat count the user expects.
  const hermesItemCount = hermesGroups.reduce(
    (n, g) => n + g.items.length,
    0,
  );

  return (
    <>
      <style>{paletteCss}</style>
      <aside aria-label="palette" className="palette">
      {categories.map((category) => (
        <section key={category.heading} className="palette-section">
          <h3 className="section-eyebrow">{category.heading}</h3>
          <ul className="palette-list">
            {category.items.length === 0 ? (
              <li className="palette-empty serif-italic">
                no providers in /providers
              </li>
            ) : (
              category.items.map((item) => (
                <li key={`${item.type}:${item.providerId ?? ''}:${item.name}`}>
                  <button
                    type="button"
                    className="palette-item"
                    draggable
                    aria-label={
                      item.providerId
                        ? `add ${item.providerId} agent node`
                        : `add ${item.type} node`
                    }
                    // `title` carries the description so it surfaces on
                    // hover (native OS tooltip) instead of taking a row
                    // of vertical space in the card.
                    title={item.description}
                    onClick={() => handlePaletteItemClick(item)}
                    onDragStart={(e) => handleDragStart(e, item)}
                  >
                    <span className="palette-icon" aria-hidden="true">
                      {item.providerId ? (
                        <ProviderIcon
                          providerId={item.providerId}
                          fallbackGlyph={item.glyph}
                        />
                      ) : item.Icon ? (
                        <item.Icon size={16} />
                      ) : (
                        item.glyph
                      )}
                    </span>
                    <span className="palette-name">{item.name}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
          {/* Hermes connections live as a nested collapsible subgroup of
            * Model Runners. Hidden entirely from the other sections. The
            * "+ new" link sits inside this group so it belongs visually to
            * the connections it creates. */}
          {category.id === 'model-runners' && (
            <div className="palette-subgroup">
              <button
                type="button"
                className="palette-subgroup-head"
                aria-expanded={hermesOpen}
                aria-controls="palette-subgroup-hermes"
                onClick={() => setHermesOpen((v) => !v)}
              >
                <span className="palette-subgroup-caret" aria-hidden="true">
                  {hermesOpen ? '▾' : '▸'}
                </span>
                <span className="palette-subgroup-label">Hermes</span>
                {hermesItemCount > 0 && (
                  <span className="palette-subgroup-count" aria-hidden="true">
                    {hermesItemCount}
                  </span>
                )}
              </button>
              {hermesOpen && (
                <div
                  id="palette-subgroup-hermes"
                  className="palette-subgroup-body"
                >
                  {hermesGroups.length === 0 ? (
                    <p className="palette-empty serif-italic">
                      no connections yet
                    </p>
                  ) : (
                    hermesGroups.map((group) => (
                      <div
                        key={group.connectionId}
                        className="palette-conn-group"
                      >
                        {/* Sub-header for one connection. Mirrors the
                          * per-port card layout so the eye reads both as
                          * "icon + name", just at different weights —
                          * the connection icon defers to ProviderIcon
                          * with kind=hermes-local so it picks up the
                          * Hermes brand mark once one is registered. */}
                        <div
                          className="palette-conn-head"
                          title={group.connectionId}
                        >
                          <span
                            className="palette-conn-icon"
                            aria-hidden="true"
                          >
                            <ProviderIcon
                              providerId="hermes"
                              fallbackGlyph="☿"
                              size={13}
                            />
                          </span>
                          <span className="palette-conn-label">
                            {group.connectionLabel}
                          </span>
                        </div>
                        <ul className="palette-list">
                          {group.items.map((item) => (
                            <li
                              key={`${item.type}:${item.providerId ?? ''}:${item.name}`}
                            >
                              <button
                                type="button"
                                className="palette-item"
                                draggable
                                aria-label={`add ${item.providerId} agent node`}
                                title={item.description}
                                onClick={() => handlePaletteItemClick(item)}
                                onDragStart={(e) => handleDragStart(e, item)}
                              >
                                <span
                                  className="palette-icon"
                                  aria-hidden="true"
                                >
                                  {/* `providerId="hermes"` looks up the
                                    * shared Hermes brand mark instead of
                                    * the per-port id (which would never
                                    * be in the registry). The actual
                                    * provider id still rides on the
                                    * drag payload via `item.providerId`. */}
                                  <ProviderIcon
                                    providerId="hermes"
                                    fallbackGlyph={item.glyph}
                                  />
                                </span>
                                <span className="palette-name">
                                  {item.name}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))
                  )}
                  <button
                    type="button"
                    className="btn btn-ghost palette-manage"
                    onClick={() => setConnectionsOpen(true)}
                    aria-label="manage hermes connections"
                  >
                    + new hermes connection
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      ))}
      {connectionsOpen && (
        <HermesConnectionsModal
          onClose={() => setConnectionsOpen(false)}
          onConnectionsChanged={loadProviders}
        />
      )}
      </aside>
    </>
  );
}

const paletteCss = `
.palette {
  border-right: 1px solid var(--border);
  padding: 20px 14px 80px;
  height: calc(100vh - var(--top-bar-h));
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
  background: var(--bg);
}
.palette-section {
  display: flex;
  flex-direction: column;
}
.palette-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.palette-empty {
  font-family: var(--mono);
  font-size: 13px;
  color: var(--fg-muted);
  padding: 6px 12px;
  letter-spacing: 0.04em;
}
/* Each palette item reads like a shell-prompt row in a manifest:
 * "› icon  NAME  description". No card chrome, no hover-fill — just a
 * left-edge phosphor pip on hover that mimics a cursor stopping on the
 * row. */
.palette-item {
  appearance: none;
  -webkit-appearance: none;
  width: 100%;
  display: grid;
  grid-template-columns: 12px 22px 1fr;
  gap: 10px;
  align-items: center;
  background: transparent;
  border: 0;
  padding: 6px 10px 6px 6px;
  color: var(--fg-soft);
  font-family: var(--mono);
  cursor: grab;
  text-align: left;
  transition: color 120ms ease, background 120ms ease;
  position: relative;
}
.palette-item::before {
  content: '·';
  color: var(--fg-faint);
  font-size: 12.5px;
  text-align: center;
  width: 12px;
}
.palette-item:hover {
  color: var(--accent-live);
  background: var(--hover-tint);
  text-shadow: var(--crt-glow);
}
.palette-item:hover::before {
  content: '›';
  color: var(--accent-live);
  text-shadow: var(--crt-glow);
}
.palette-item:active {
  cursor: grabbing;
}
.palette-item:focus-visible {
  outline: 1px dashed var(--accent-live);
  outline-offset: -2px;
}
.palette-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--mono);
  font-size: 17px;
  line-height: 1;
  color: var(--fg-dim);
  /* Pull the icon closer to the arrow/pip column without touching the
   * uniform grid gap (which would also tighten icon→text). Negative
   * margin shifts only this column's visual edge; the grid track itself
   * stays the same width. */
  margin-left: -6px;
}
.palette-icon svg {
  display: block;
}
.provider-icon-mask {
  display: inline-block;
  background-color: currentColor;
  -webkit-mask-position: center;
  mask-position: center;
  -webkit-mask-size: contain;
  mask-size: contain;
  -webkit-mask-repeat: no-repeat;
  mask-repeat: no-repeat;
}
.palette-item:hover .palette-icon {
  color: var(--accent-live);
}
.palette-name {
  font-family: var(--mono);
  font-size: 13px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: inherit;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* "+ new hermes connection" link — small, quiet, sits below the Model
 * Runners cards. Single-line, no chrome; mirrors the palette-item type
 * style so it reads as a continuation, not a CTA. */
.palette-manage {
  margin: 6px 10px 0;
  align-self: flex-start;
  background: transparent;
  border: 0;
  padding: 4px 4px;
  font-family: var(--mono);
  font-size: 11.5px;
  letter-spacing: 0.04em;
  color: var(--fg-dim);
  cursor: pointer;
  text-align: left;
}
.palette-manage:hover {
  color: var(--accent-live);
  text-shadow: var(--crt-glow);
}
.palette-manage:focus-visible {
  outline: 1px dashed var(--accent-live);
  outline-offset: 2px;
}
/* Hermes lives as a nested subgroup under Model Runners. The header has
 * a chevron + label + item count and is the click target for the
 * expand/collapse toggle. The body inherits the palette-list styling so
 * the connection cards visually match the top-level ones, just shifted
 * inward by the body's left padding. */
.palette-subgroup {
  margin-top: 8px;
  border-top: 1px dashed var(--border);
  padding-top: 6px;
}
.palette-subgroup-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  background: transparent;
  border: 0;
  /* Pull the chevron up against the section's left edge — the chevron-
   * to-label spacing stays in the gap property above. Right padding
   * keeps the count badge / dashed rule from kissing the panel border. */
  padding: 4px 8px 4px 2px;
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--fg-soft);
  cursor: pointer;
  text-align: left;
}
.palette-subgroup-head:hover { color: var(--fg); }
.palette-subgroup-head:focus-visible {
  outline: 1px dashed var(--accent-live);
  outline-offset: 2px;
}
.palette-subgroup-caret {
  width: 10px;
  font-size: 11px;
  color: var(--fg-dim);
}
.palette-subgroup-label { flex: 1; }
.palette-subgroup-count {
  font-size: 10px;
  color: var(--fg-dim);
  letter-spacing: 0;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.palette-subgroup-body {
  /* No extra left indent — keep the connection cards in the same column
   * as the top-level Claude/Codex rows so the eye doesn't have to track
   * two different left edges. */
  display: flex;
  flex-direction: column;
}
.palette-subgroup-body .palette-empty {
  padding: 4px 12px 6px;
}
/* One block per connection inside the Hermes subgroup. The header reads
 * as a quiet caption (lowercase mono, dim color) so the profile cards
 * below it stay the dominant visual element — the user is still aiming
 * to drag a profile, not a connection. */
.palette-conn-group {
  margin-top: 4px;
}
.palette-conn-group:first-child {
  margin-top: 0;
}
.palette-conn-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px 2px;
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  color: var(--fg-dim);
  text-transform: lowercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.palette-conn-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 13px;
  height: 13px;
  color: var(--fg-dim);
  flex-shrink: 0;
}
.palette-conn-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

@media (max-width: 920px) {
  .palette {
    grid-area: palette;
    height: min(220px, 36dvh);
    min-height: 168px;
    padding: 10px 10px 12px;
    border-right: 0;
    border-top: 1px solid var(--border-strong);
    overflow-x: hidden;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 14px;
    scrollbar-width: thin;
  }
  .palette-section {
    min-width: 0;
    overflow: visible;
    padding-right: 0;
  }
  .palette .section-eyebrow {
    gap: 8px;
    margin-bottom: 8px;
    font-size: 10.5px;
    letter-spacing: 0.22em;
    line-height: 1.2;
    min-width: 0;
  }
  .palette .section-eyebrow::before {
    flex: 0 0 auto;
  }
  .palette .section-eyebrow::after {
    min-width: 24px;
  }
  .palette-list {
    gap: 1px;
  }
  .palette-item {
    min-height: 30px;
    grid-template-columns: 10px 18px minmax(0, 1fr);
    gap: 7px;
    padding: 5px 8px 5px 4px;
  }
  .palette-icon {
    font-size: 15px;
    margin-left: -4px;
  }
  .palette-name {
    font-size: 11px;
    letter-spacing: 0.12em;
  }
  .palette-empty {
    padding: 4px 8px;
    font-size: 11.5px;
  }
  .palette-subgroup {
    margin-top: 5px;
    padding-top: 4px;
  }
  .palette-subgroup-head {
    padding: 3px 6px 3px 0;
    font-size: 10px;
  }
  .palette-conn-head {
    padding: 3px 8px 1px;
    font-size: 10px;
  }
  .palette-manage {
    margin: 4px 8px 0;
    font-size: 10.5px;
  }
}
`;
