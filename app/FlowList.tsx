'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LuCheck, LuPencil, LuTrash2, LuX } from 'react-icons/lu';
import type { Workflow, WorkflowSummary } from '../lib/shared/workflow';
import { createWorkflow } from '../lib/client/create-workflow';
import { clearCurrentWorkflow, flushPendingWorkflow, workflowPath } from '../lib/client/workflow-navigation';
import { ConsoleLayoutContext } from './components/ConsoleLayoutContext';
import ThemeToggle from './components/ThemeToggle';
import JobsList from './components/JobsList';
import { DispatchView } from './components/DispatchView';

function FlowRow({ flow, selected, compact, onLeave, onRenamed, onDeleted }: {
  flow: WorkflowSummary;
  selected: boolean;
  compact: boolean;
  onLeave: (event: React.MouseEvent<HTMLAnchorElement>, id: string) => void;
  onRenamed: (workflow: Workflow) => void;
  onDeleted: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(flow.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cancelled = useRef(false);
  const pending = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function startRename() {
    cancelled.current = false;
    setDraft(flow.name);
    setError(null);
    setEditing(true);
  }

  function cancelRename() {
    cancelled.current = true;
    setEditing(false);
  }

  async function saveRename() {
    if (cancelled.current || pending.current || !editing) return;
    const name = draft.trim();
    setEditing(false);
    if (!name || name === flow.name) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const url = `/api/workflows/${encodeURIComponent(flow.id)}`;
      const loaded = await fetch(url);
      if (!loaded.ok) throw new Error(`Could not load this flow (${loaded.status})`);
      const data = (await loaded.json()) as { workflow?: Workflow };
      if (!data.workflow || data.workflow.id !== flow.id) throw new Error('Could not read this flow');
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...data.workflow, name, updatedAt: Date.now() }),
      });
      if (!response.ok) throw new Error(`Could not rename this flow (${response.status})`);
      const saved = (await response.json()) as { workflow?: Workflow };
      if (!saved.workflow || saved.workflow.id !== flow.id) throw new Error('Could not read the saved flow');
      onRenamed(saved.workflow);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : 'Could not rename this flow');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function remove() {
    if (pending.current || !window.confirm(`Delete workflow "${flow.name}"?`)) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/workflows/${encodeURIComponent(flow.id)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(`Could not delete this flow (${response.status})`);
      onDeleted(flow.id);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : 'Could not delete this flow');
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const metadata = (
    <span className="flow-row-meta">
      <span className="flow-row-id">{flow.id}</span>
      {flow.source === 'library' && <span className="flow-source">Library</span>}
      <time className="flow-row-updated" dateTime={new Date(flow.updatedAt).toISOString()}>
        Updated {new Date(flow.updatedAt).toLocaleDateString()}
      </time>
    </span>
  );

  return (
    <li className="flow-list-item">
      {editing ? (
        <div className="flow-row flow-row-edit">
          <input
            ref={inputRef}
            className="flow-name-input"
            aria-label={`workflow name ${flow.id}`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.preventDefault(); cancelRename(); }
              if (event.key === 'Enter') { event.preventDefault(); void saveRename(); }
            }}
            onBlur={(event) => {
              // Save/Cancel buttons manage their own action. Escape/unmount
              // can also fire blur; the cancellation/pending refs guard it.
              if (event.relatedTarget instanceof Node && event.currentTarget.closest('li')?.contains(event.relatedTarget)) return;
              void saveRename();
            }}
          />
          {metadata}
        </div>
      ) : (
        <Link
          href={workflowPath(flow.id)}
          className="flow-row"
          aria-current={selected ? 'page' : undefined}
          data-testid={`flow-row-${flow.id}`}
          aria-disabled={busy || undefined}
          tabIndex={busy ? -1 : undefined}
          onClick={(event) => { if (pending.current) event.preventDefault(); else onLeave(event, flow.id); }}
        >
          <span className="flow-row-name">{flow.name}</span>
          {metadata}
        </Link>
      )}
      <div className="flow-row-actions" inert={compact}>
        {editing ? (
          <>
            <button type="button" className="flow-action" aria-label={`save workflow ${flow.id}`} title="Save name" onClick={() => void saveRename()}><LuCheck aria-hidden="true" /></button>
            <button type="button" className="flow-action" aria-label={`cancel rename ${flow.id}`} title="Cancel rename" onMouseDown={(event) => event.preventDefault()} onClick={cancelRename}><LuX aria-hidden="true" /></button>
          </>
        ) : (
          <>
            <button type="button" className="flow-action" aria-label={`rename workflow ${flow.id}`} title="Rename flow" disabled={busy} onClick={startRename}><LuPencil aria-hidden="true" /></button>
            <button type="button" className="flow-action flow-action-delete" aria-label={`delete workflow ${flow.id}`} title="Delete flow" disabled={busy} onClick={() => void remove()}><LuTrash2 aria-hidden="true" /></button>
          </>
        )}
      </div>
      {error && <p role="alert" className="flow-row-error">{error}</p>}
    </li>
  );
}

export default function FlowList({ flowId = null, children }: { flowId?: string | null; children?: ReactNode }) {
  const router = useRouter();
  const [flows, setFlows] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const mounted = useRef(true);
  const createVersion = useRef(0);
  const pendingCreation = useRef<number | null>(null);
  const listVersion = useRef(0);
  const loadedList = useRef(false);
  const currentFlowId = useRef(flowId);
  currentFlowId.current = flowId;
  const [compact, setCompact] = useState(!!flowId);
  const compactRef = useRef(compact);
  const [transitioning, setTransitioning] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const navigationVersion = useRef(0);
  const [drawerMode, setDrawerMode] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerToggleRef = useRef<HTMLButtonElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const listNavRef = useRef<HTMLElement>(null);
  const restoreDrawerFocus = useRef(false);
  const modalOpen = compact && drawerMode && drawerOpen;
  const opening = !!flowId && !compact;

  const changeView = useCallback((next: boolean) => {
    if (compactRef.current === next) return;
    compactRef.current = next;
    setTransitioning(!window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    setCompact(next);
  }, []);

  const reportWorkspace = useCallback((id: string, state: 'loading' | 'ready' | 'error') => {
    if (currentFlowId.current === id && state !== 'loading') changeView(true);
  }, [changeView]);

  useLayoutEffect(() => {
    createVersion.current += 1;
    navigationVersion.current += 1;
    setNavigating(false);
    setNavigationError(null);
    setDrawerOpen(false);
    if (!flowId) changeView(false);
  }, [flowId, changeView]);

  useEffect(() => {
    if (!transitioning) return;
    // transitionend is preferred; this also settles a hidden/reduced-motion
    // layout when the browser does not dispatch a transition event.
    const timer = window.setTimeout(() => setTransitioning(false), 600);
    return () => window.clearTimeout(timer);
  }, [transitioning, compact]);

  const closeDrawer = useCallback(() => {
    restoreDrawerFocus.current = true;
    setDrawerOpen(false);
  }, []);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 1279px)');
    const sync = () => {
      setDrawerMode(query.matches);
      if (!query.matches) setDrawerOpen(false);
    };
    sync();
    query.addEventListener?.('change', sync);
    return () => query.removeEventListener?.('change', sync);
  }, []);

  useEffect(() => {
    if (!modalOpen) {
      if (restoreDrawerFocus.current) {
        restoreDrawerFocus.current = false;
        drawerToggleRef.current?.focus();
      }
      return;
    }
    drawerCloseRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeDrawer(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(listNavRef.current?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)') ?? [])
        .filter((node) => !node.closest('[inert]'));
      const first = drawerCloseRef.current;
      const last = controls[controls.length - 1] ?? first;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modalOpen, closeDrawer]);

  async function navigate(href: string, replace = false) {
    const version = ++navigationVersion.current;
    setNavigationError(null);
    setNavigating(true);
    try {
      await flushPendingWorkflow();
      if (!mounted.current || version !== navigationVersion.current) return;
      if (replace) router.replace(href);
      else router.push(href);
      if (href === window.location.pathname) setNavigating(false);
    } catch (err) {
      if (mounted.current && version === navigationVersion.current) {
        setNavigationError(err instanceof Error ? err.message : 'Could not save changes');
        setNavigating(false);
      }
      throw err;
    }
  }

  async function refreshFlows() {
    const version = ++listVersion.current;
    setRefreshError(null);
    try {
      const response = await fetch('/api/workflows');
      if (!response.ok) throw new Error(`Could not refresh flows (${response.status})`);
      const data = (await response.json()) as { workflows?: WorkflowSummary[] };
      if (!Array.isArray(data.workflows)) throw new Error('Could not read the flow list');
      if (mounted.current && version === listVersion.current) setFlows(data.workflows);
    } catch (err) {
      if (mounted.current && version === listVersion.current) setRefreshError(err instanceof Error ? err.message : 'Could not refresh flows');
    }
  }

  function onRenamed(workflow: Workflow) {
    if (!mounted.current) return;
    listVersion.current += 1;
    setFlows((previous) => previous.map((flow) => flow.id === workflow.id ? {
      id: workflow.id, name: workflow.name, version: workflow.version,
      updatedAt: workflow.updatedAt, source: 'user' as const,
    } : flow).sort((a, b) => b.updatedAt - a.updatedAt));
    void refreshFlows();
  }

  function onDeleted(id: string) {
    if (!mounted.current) return;
    setFlows((previous) => previous.filter((flow) => flow.id !== id));
    // Removing a user override can reveal a library preset with the same ID.
    void refreshFlows();
  }

  useEffect(() => {
    mounted.current = true;
    const invalidateCreation = () => { createVersion.current += 1; navigationVersion.current += 1; setNavigating(false); };
    window.addEventListener('popstate', invalidateCreation);
    return () => {
      mounted.current = false;
      createVersion.current += 1;
      navigationVersion.current += 1;
      window.removeEventListener('popstate', invalidateCreation);
    };
  }, []);

  useEffect(() => {
    const sync = () => setDispatchOpen(window.location.hash.startsWith('#dispatch'));
    sync();
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);

  function onLeave(event: React.MouseEvent<HTMLAnchorElement>) {
    if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      createVersion.current += 1;
      const href = event.currentTarget.getAttribute('href')!;
      if (href === '/') setDispatchOpen(false);
      void navigate(href).catch(() => {});
    }
  }

  function onFlowLeave(event: React.MouseEvent<HTMLAnchorElement>, id: string) {
    if (id === flowId && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      closeDrawer();
      return;
    }
    onLeave(event);
  }

  useEffect(() => {
    // Persist the same list while entering/switching editors. Returning home
    // refreshes it only after pending edits have reached storage.
    if (flowId && loadedList.current) return;
    let cancelled = false;
    const version = ++listVersion.current;
    if (!loadedList.current) setLoading(true);
    setError(null);
    (async () => {
      try {
        if (!flowId) {
          await flushPendingWorkflow();
          if (cancelled) return;
          clearCurrentWorkflow();
        }
        const res = await fetch('/api/workflows');
        if (!res.ok) throw new Error(`Could not load flows (${res.status})`);
        const data = (await res.json()) as { workflows?: WorkflowSummary[] };
        if (!Array.isArray(data.workflows)) throw new Error('Could not read the flow list');
        if (!cancelled && version === listVersion.current) { setFlows(data.workflows); loadedList.current = true; }
      } catch (err) {
        if (!cancelled && version === listVersion.current) setError(err instanceof Error ? err.message : 'Could not load flows');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [flowId === null, attempt]);

  async function onNew() {
    if (pendingCreation.current !== null) return;
    const version = ++createVersion.current;
    pendingCreation.current = version;
    setCreating(true);
    setCreateError(null);
    try {
      await flushPendingWorkflow();
      if (!mounted.current || version !== createVersion.current) return;
      const workflow = await createWorkflow();
      if (mounted.current) {
        listVersion.current += 1;
        setFlows((previous) => [{
          id: workflow.id, name: workflow.name, version: workflow.version,
          updatedAt: workflow.updatedAt, source: 'user' as const,
        }, ...previous.filter((flow) => flow.id !== workflow.id)]);
      }
      // Creation may have completed after a later choice of flow or browser
      // history entry. Keep the created flow, without redirecting that choice.
      if (!mounted.current || version !== createVersion.current) return;
      void navigate(workflowPath(workflow.id)).catch(() => {});
    } catch (err) {
      if (!mounted.current || version !== createVersion.current) return;
      setCreateError(err instanceof Error ? err.message : 'Could not create a flow');
    } finally {
      if (pendingCreation.current === version) {
        pendingCreation.current = null;
        if (mounted.current) setCreating(false);
      }
    }
  }

  return (
    <ConsoleLayoutContext.Provider value={{
      flowId, navigate, navigating, navigationError, reportWorkspace, transitioning,
      drawerOpen: modalOpen, openDrawer: () => setDrawerOpen(true), drawerToggleRef,
    }}>
    <div className="console-shell flow-home-page" data-view={compact ? 'workspace' : 'home'} data-opening={opening || undefined} data-transitioning={transitioning || undefined}>
      <header className="top-bar flow-home-bar" inert={!!flowId || navigating} aria-hidden={compact || undefined}>
        <Link href="/" className="brand" aria-label="Inf·Loop home" onClick={onLeave}>
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-text">Inf·Loop<em>Console</em></span>
        </Link>
        <div className="actions">
          <button type="button" className={`btn btn-ghost${dispatchOpen ? ' btn-active' : ''}`} aria-pressed={dispatchOpen} onClick={() => { createVersion.current += 1; setDispatchOpen(!dispatchOpen); window.location.hash = dispatchOpen ? '' : '#dispatch'; }}>Dispatch</button>
          <ThemeToggle />
          <Link href="/queue" className="btn btn-ghost" onClick={onLeave}>Queue</Link>
        </div>
      </header>
      {opening && <div role="status" className="console-opening">Opening flow…</div>}
      {navigationError && !compact && <p role="alert" className="workflow-save-error">Could not save changes. {navigationError}</p>}
      {modalOpen && <button className="workflow-switcher-backdrop" type="button" aria-hidden="true" tabIndex={-1} onClick={closeDrawer} />}
      <div className="console-body" onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && event.propertyName === 'grid-template-columns') setTransitioning(false);
      }}>
        <div className="console-home-pane" data-open={modalOpen || undefined} role={modalOpen ? 'dialog' : undefined} aria-modal={modalOpen || undefined} aria-label={modalOpen ? 'Flows' : undefined} inert={navigating}>
          <button ref={drawerCloseRef} type="button" className="workflow-switcher-close" aria-label="Close flows" onClick={closeDrawer}>×</button>
          <main className="flow-home flow-home-grid" hidden={dispatchOpen && !flowId}>
            <nav ref={listNavRef} id="workflow-switcher" className="flow-home-flows" aria-label="Workflows">
              <div className="flow-home-heading">
                <div>
                  <h1 id="flows-heading">All flows</h1>
                  <p className="flow-home-description">Choose a flow to open its workspace.</p>
                </div>
                <div className="flow-home-create" inert={!!flowId}>
                  <button type="button" className="btn" data-testid="new-flow" disabled={creating || loading || !!error || !!flowId} onClick={() => void onNew()}>
                    {creating ? 'Creating…' : 'New flow'}
                  </button>
                </div>
              </div>
          {createError && <p role="alert" className="flow-error">{createError}</p>}
          {refreshError && <div role="alert" className="flow-refresh-error"><span>{refreshError}</span><button type="button" className="btn btn-ghost" onClick={() => void refreshFlows()}>Retry flow list</button></div>}
          {loading ? <p role="status" className="flow-state">Loading flows…</p> : error ? (
            <div className="flow-state" data-testid="flow-list-error" role="alert">
              <p>{error}</p>
              <button type="button" className="btn" onClick={() => setAttempt((value) => value + 1)}>Retry</button>
            </div>
          ) : flows.length === 0 ? (
            <div className="flow-state" data-testid="flow-empty">
              <h2>No flows yet</h2>
              <p>Create a flow to start building.</p>
            </div>
          ) : (
            <ul className="flow-list" data-testid="flow-list" aria-label="Available flows">
              {flows.map((flow) => (
                <FlowRow key={flow.id} flow={flow} selected={flow.id === flowId} compact={!!flowId} onLeave={onFlowLeave} onRenamed={onRenamed} onDeleted={onDeleted} />
              ))}
            </ul>
          )}
            </nav>
            <div className="console-jobs" inert={!!flowId} aria-hidden={compact || undefined}>
              <JobsList flows={flows} active={!flowId && !dispatchOpen} />
            </div>
          </main>
          {dispatchOpen && !flowId && <main className="flow-home flow-home-dispatch"><DispatchView origin={typeof window !== 'undefined' ? window.location.origin : ''} /></main>}
        </div>
        <div className="console-editor-pane" inert={modalOpen || navigating || transitioning || !compact} aria-hidden={!compact || undefined}>
          {children}
        </div>
      </div>
    </div>
    </ConsoleLayoutContext.Provider>
  );
}
