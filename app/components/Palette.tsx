'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { IconType } from 'react-icons';
import {
  LuCode,
  LuColumns3,
  LuFilter,
  LuGitBranch,
  LuHand,
  LuLayers,
  LuPlay,
  LuRepeat,
  LuSearch,
  LuSquare,
  LuStickyNote,
} from 'react-icons/lu';
import type { NodeType } from '@/lib/shared/workflow';
import type { ProviderInfo } from '@/lib/server/providers/types';
import ProviderIcon from './icons/ProviderIcon';
import HermesConnectionsModal from './HermesConnectionsModal';
import OpenAIProvidersModal from './OpenAIProvidersModal';
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
  available?: boolean;
  healthMessage?: string;
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

const DRAG_PREVIEW_COPY: Record<NodeType, { title: string; body: string }> = {
  start: { title: 'START', body: 'begin' },
  end: { title: 'END', body: '→ succeeded' },
  agent: { title: 'AGENT', body: '(no prompt)' },
  condition: { title: 'CONDITION', body: 'sentinel · (no pattern)' },
  loop: { title: 'LOOP', body: '×5 · while-not-met' },
  branch: { title: 'BRANCH', body: '(unconfigured)' },
  parallel: { title: 'PARALLEL', body: 'wait-all · fail-fast' },
  subworkflow: { title: 'SUBWORKFLOW', body: '→ (unset)' },
  'structured-output': { title: 'OPENAI', body: '⌘ no provider · (no prompt)' },
  sidenote: { title: 'NOTE', body: '(empty note)' },
  script: { title: 'SCRIPT', body: 'run(arg1, arg2) → output1' },
  'send-webhook': { title: 'SEND WEBHOOK', body: 'POST · HTTPS endpoint' },
  'github-ci': { title: 'GITHUB CI GATE', body: 'wait for required checks' },
  manual: { title: 'MANUAL', body: '✋ 3 decisions' },
};

/**
 * The native HTML drag image would otherwise be the rectangular palette
 * button. Build a small, styled copy of the node's default card instead, so
 * the item under the pointer is the card the user will get on drop.
 */
function setNodeDragPreview(
  e: React.DragEvent<HTMLButtonElement>,
  item: PaletteItem,
): void {
  const copy = DRAG_PREVIEW_COPY[item.type];
  const preview = document.createElement('div');
  // Reuse the actual canvas-card classes rather than duplicating their
  // dimensions in the preview. This makes the drag image track card-size
  // changes automatically.
  preview.className = 'wf-node node-drag-preview';
  preview.dataset.nodeType = item.type;
  preview.dataset.state = 'idle';
  preview.dataset.selected = 'false';
  preview.innerHTML = `
    <div class="wf-node-head">
      <span class="wf-node-title">${copy.title}</span>
      <span class="wf-node-state-dot" data-state="idle"></span>
    </div>
    <div class="wf-node-body">${copy.body}</div>
  `;
  document.body.append(preview);
  try {
    e.dataTransfer.setDragImage(preview, 18, 16);
  } catch {
    // Some DOM shims (including the unit-test environment) do not provide
    // drag-image support. The browser's standard preview remains a safe
    // fallback there.
    preview.remove();
    return;
  }
  requestAnimationFrame(() => preview.remove());
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
      { type: 'github-ci', name: 'GitHub CI Gate', Icon: LuGitBranch, glyph: '✓', description: 'wait for required GitHub CI checks' },
      { type: 'manual', name: 'Manual', Icon: LuHand, glyph: '✋', description: 'pause for a human acceptance decision' },
    ],
  },
  {
    id: 'multi-agent',
    heading: 'Multi-agent',
    items: [
      { type: 'parallel', name: 'Parallel', Icon: LuColumns3, glyph: '⫲', description: 'fan out concurrent branches' },
      { type: 'subworkflow', name: 'Subworkflow', Icon: LuLayers, glyph: '⊞', description: 'call another workflow' },
    ],
  },
  {
    id: 'scripts',
    heading: 'Scripts',
    items: [
      { type: 'send-webhook', name: 'Send Webhook', Icon: LuGitBranch, glyph: '↗', description: 'send an HTTPS request when reached' },
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
    available: p.available,
    healthMessage: p.health?.message,
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
  if (item.available === false) {
    e.preventDefault();
    return;
  }
  const payload: DragPayload = { type: item.type };
  if (item.providerId) payload.providerId = item.providerId;
  e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
  e.dataTransfer.effectAllowed = 'copy';
  setNodeDragPreview(e, item);
  if (process.env.NODE_ENV !== 'production') {
    console.debug('[palette] dragstart', payload);
  }
}

function handlePaletteItemClick(item: PaletteItem): void {
  if (item.available === false) return;
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
  const [openAiProvidersOpen, setOpenAiProvidersOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
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
  const normalizedQuery = query.trim().toLowerCase();
  // Total count across all connections, shown next to the Hermes
  // subgroup header so it matches the flat count the user expects.
  const hermesItemCount = hermesGroups.reduce(
    (n, g) => n + g.items.length,
    0,
  );
  const visibleHermesGroups = normalizedQuery
    ? hermesGroups
        .map((group) => {
          const groupMatches = group.connectionLabel
            .toLowerCase()
            .includes(normalizedQuery);
          return {
            ...group,
            items: groupMatches
              ? group.items
              : group.items.filter((item) =>
                  `${item.name} ${item.description} ${item.providerId ?? ''}`
                    .toLowerCase()
                    .includes(normalizedQuery),
                ),
          };
        })
        .filter((group) => group.items.length > 0)
    : hermesGroups;
  const visibleCategories = normalizedQuery
    ? categories
        .map((category) => ({
          ...category,
          items: category.items.filter((item) =>
            `${item.name} ${item.description} ${item.type}`
              .toLowerCase()
              .includes(normalizedQuery),
          ),
        }))
        .filter(
          (category) =>
            category.items.length > 0 ||
            (category.id === 'model-runners' && visibleHermesGroups.length > 0),
        )
    : categories;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <>
      <style>{paletteCss}</style>
      <aside aria-label="palette" className="palette">
      <label className="palette-search">
        <LuSearch aria-hidden="true" size={16} />
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search nodes..."
          aria-label="Search nodes"
        />
        <kbd>⌘K</kbd>
      </label>
      {visibleCategories.length === 0 ? (
        <p className="palette-no-results">No matching nodes</p>
      ) : visibleCategories.map((category) => (
        <section key={category.heading} className="palette-section">
          <h3 className="section-eyebrow">{category.heading}</h3>
          <ul className="palette-list">
            {category.items.length === 0 ? (
              category.id === 'model-runners' && visibleHermesGroups.length > 0
                ? null
                : <li className="palette-empty serif-italic">
                    no providers in /providers
                  </li>
            ) : (
              category.items.map((item) => (
                <li key={`${item.type}:${item.providerId ?? ''}:${item.name}`}>
                  <button
                    type="button"
                    className="palette-item"
                    data-unavailable={item.available === false || undefined}
                    disabled={item.available === false}
                    draggable={item.available !== false}
                    aria-label={
                      item.providerId
                        ? `add ${item.providerId} agent node`
                        : `add ${item.type} node`
                    }
                    // `title` carries the description so it surfaces on
                    // hover (native OS tooltip) instead of taking a row
                    // of vertical space in the card.
                    title={item.available === false ? item.healthMessage ?? 'Provider unavailable' : item.description}
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
                    {item.available === false && (
                      <span className="palette-status" aria-hidden="true">
                        Not available
                      </span>
                    )}
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
            <>
            <button
              type="button"
              className="palette-manage"
              onClick={() => setOpenAiProvidersOpen(true)}
              aria-label="manage OpenAI providers"
            >
              + configure OpenAI providers
            </button>
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
              {(hermesOpen || !!normalizedQuery) && (
                <div
                  id="palette-subgroup-hermes"
                  className="palette-subgroup-body"
                >
                  {visibleHermesGroups.length === 0 ? (
                    <p className="palette-empty serif-italic">
                      {normalizedQuery ? 'no matching connections' : 'no connections yet'}
                    </p>
                  ) : (
                    visibleHermesGroups.map((group) => (
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
                                data-unavailable={item.available === false || undefined}
                                disabled={item.available === false}
                                draggable={item.available !== false}
                                aria-label={`add ${item.providerId} agent node`}
                                title={item.available === false ? item.healthMessage ?? 'Provider unavailable' : item.description}
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
                                {item.available === false && (
                                  <span
                                    className="palette-status"
                                    aria-hidden="true"
                                  >
                                    Not available
                                  </span>
                                )}
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))
                  )}
                  <button
                    type="button"
                    className="palette-manage"
                    onClick={() => setConnectionsOpen(true)}
                    aria-label="manage hermes connections"
                  >
                    + new hermes connection
                  </button>
                </div>
              )}
            </div>
            </>
          )}
        </section>
      ))}
      {connectionsOpen && (
        <HermesConnectionsModal
          onClose={() => setConnectionsOpen(false)}
          onConnectionsChanged={loadProviders}
        />
      )}
      {openAiProvidersOpen && (
        <OpenAIProvidersModal
          onClose={() => setOpenAiProvidersOpen(false)}
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
  padding: 16px 14px 32px;
  height: calc(100vh - var(--top-bar-h));
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
  background: var(--panel);
}
.palette-search {
  height: 40px;
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  background: var(--bg-input);
  color: var(--fg-muted);
}
.palette-search input {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--fg);
  font: 500 13px/1 var(--mono);
}
.palette-search input::placeholder { color: var(--fg-muted); }
.palette-search:focus-within { border-color: var(--accent-live); box-shadow: 0 0 0 3px var(--accent-soft); }
.palette-search kbd {
  padding: 3px 5px;
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--fg-muted);
  font: 600 10px/1 var(--mono);
}
.palette-no-results { margin: 0; color: var(--fg-muted); font: 500 13px/1.4 var(--mono); }
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
  grid-template-columns: 30px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  color: var(--fg-soft);
  font-family: var(--mono);
  cursor: grab;
  text-align: left;
  transition: color 120ms ease, background 120ms ease;
  position: relative;
}
.palette-item:hover {
  color: var(--accent-live);
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent-live) 45%, var(--border));
}
.palette-item:active {
  cursor: grabbing;
}
.palette-item[data-unavailable='true'] {
  cursor: not-allowed;
  color: var(--fg-faint);
  opacity: 0.58;
}
.palette-status {
  justify-self: end;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--accent-err);
}
.palette-item:focus-visible {
  outline: 2px solid var(--accent-live);
  outline-offset: 2px;
}
.palette-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--mono);
  font-size: 17px;
  line-height: 1;
  color: var(--accent-info);
  /* Pull the icon closer to the arrow/pip column without touching the
   * uniform grid gap (which would also tighten icon→text). Negative
   * margin shifts only this column's visual edge; the grid track itself
   * stays the same width. */
  margin-left: 0;
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
  font-weight: 600;
  letter-spacing: 0;
  text-transform: none;
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
