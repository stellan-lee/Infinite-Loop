'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import Canvas from './components/canvas/Canvas';
import RunInputsModal from './components/RunInputsModal';
import Palette from './components/Palette';
import ConfigPanel from './components/ConfigPanel';
import { GitHubCIDetails, latestCIOutput } from './components/github-ci-details';
import { findWorkflowNode } from '../lib/shared/workflow-graph';
import RunView from './components/RunView';
import RunHistory from './components/RunHistory';
import { useViewportPopover } from './components/useViewportPopover';
import { ActiveRunsBadge } from './components/ActiveRunsBadge';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEngineWebSocket } from '../lib/client/ws-client';
import { useWorkflowStore } from '../lib/client/workflow-store-client';
import { flushPendingWorkflow } from '../lib/client/workflow-navigation';
import type { Workflow } from '../lib/shared/workflow';

const RIGHT_WIDTH_STORAGE_KEY = 'infinite_loop:right-width';
const RIGHT_WIDTH_DEFAULT = 440;
const RIGHT_WIDTH_MIN = 280;
const CANVAS_MIN_WIDTH = 360;

export default function Workspace({ flowId }: { flowId: string }) {
  const router = useRouter();
  const currentWorkflow = useWorkflowStore((s) => s.currentWorkflow);
  const isDirty = useWorkflowStore((s) => s.isDirty);
  const activeRunId = useEngineWebSocket(currentWorkflow?.id === flowId ? flowId : null);
  const runStatus = useWorkflowStore((s) => s.runStatus);
  const wsStatus = useWorkflowStore((s) => s.connectionStatus);
  const selectedNodeId = useWorkflowStore((s) => s.selectedNodeId);
  const runEvents = useWorkflowStore((s) => s.runEvents);
  const githubCI = useWorkflowStore((s) => s.githubCI);
  const loadWorkflow = useWorkflowStore((s) => s.loadWorkflow);
  const selectNode = useWorkflowStore((s) => s.selectNode);
  const undo = useWorkflowStore((s) => s.undo);
  const redo = useWorkflowStore((s) => s.redo);
  const isRunning = runStatus === 'running';

  const [loadError, setLoadError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [navigating, setNavigating] = useState(false);
  const mounted = useRef(true);
  const navigationVersion = useRef(0);
  const navigationBlocked = useRef(false);
  const ready = currentWorkflow?.id === flowId && !loadError;

  const setNavigationBusy = useCallback((value: boolean) => {
    navigationBlocked.current = value;
    if (mounted.current) setNavigating(navigationBlocked.current);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const invalidateNavigation = () => {
      navigationVersion.current += 1;
      setNavigationBusy(false);
    };
    window.addEventListener('popstate', invalidateNavigation);
    return () => {
      mounted.current = false;
      navigationVersion.current += 1;
      window.removeEventListener('popstate', invalidateNavigation);
    };
  }, [flowId, setNavigationBusy]);

  async function navigate(href: string, replace = false) {
    if (!mounted.current) return;
    const version = ++navigationVersion.current;
    setNavigationError(null);
    setNavigationBusy(true);
    try {
      await flushPendingWorkflow();
      if (!mounted.current || version !== navigationVersion.current) return;
      if (replace) router.replace(href);
      else router.push(href);
      if (href === window.location.pathname) setNavigationBusy(false);
    } catch (err) {
      if (!mounted.current || version !== navigationVersion.current) return;
      setNavigationError(err instanceof Error ? err.message : 'Could not save changes');
      setNavigationBusy(false);
      throw err;
    }
  }

  function onNavigateLink(event: React.MouseEvent<HTMLAnchorElement>, href: string) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    void navigate(href).catch(() => {});
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sync = () => {
      if (window.location.hash.startsWith('#dispatch')) {
        void navigate(`/${window.location.hash}`, true).catch(() => {});
      }
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  // Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z = redo. Skip when focus is in an
  // editable field — let the browser's native field-level undo win there so
  // typing in the prompt textarea isn't blown away by a workflow rollback.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (navigationBlocked.current && (
        key === 'delete' || key === 'backspace' ||
        ((e.metaKey || e.ctrlKey) && (key === 'z' || key === 'y'))
      )) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== 'z' && e.key !== 'Z') return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        target?.isContentEditable
      ) {
        return;
      }
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [undo, redo]);

  const [rightWidth, setRightWidth] = useState<number>(RIGHT_WIDTH_DEFAULT);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [mobilePaletteOpen, setMobilePaletteOpen] = useState(false);
  const paletteRef = useRef<HTMLDivElement>(null);
  const paletteToggleRef = useRef<HTMLButtonElement>(null);
  const closeMobilePalette = useCallback(() => {
    setMobilePaletteOpen(false);
    paletteToggleRef.current?.focus();
  }, []);
  const openMobilePalette = useCallback(() => {
    if (window.matchMedia('(max-width: 920px)').matches) setMobilePaletteOpen(true);
  }, []);
  useEffect(() => {
    if (!mobilePaletteOpen) return;
    paletteRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMobilePalette();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobilePaletteOpen, closeMobilePalette]);
  const [runModalOpen, setRunModalOpen] = useState(false);
  const [runChevronOpen, setRunChevronOpen] = useState(false);
  const runGroupRef = useRef<HTMLDivElement | null>(null);
  const runPopover = useViewportPopover<HTMLDivElement>(runChevronOpen, runGroupRef, {
    minWidth: 180,
    maxHeight: 240,
    align: 'end',
  });
  useEffect(() => {
    if (!runChevronOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!runGroupRef.current?.contains(event.target as Node) &&
          !runPopover.panelRef.current?.contains(event.target as Node)) {
        setRunChevronOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setRunChevronOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [runChevronOpen, runPopover.panelRef]);
  const dragStateRef = useRef<{ active: boolean }>({ active: false });
  // Mirror of `rightWidth` for the resize handler to read on mouseup —
  // the React state setter is async and `getCurrentRightWidth()` used to
  // read off the DOM, which broke when the user switched views mid-drag
  // and `.workspace-tri` unmounted before the persist tick fired.
  const rightWidthRef = useRef<number>(RIGHT_WIDTH_DEFAULT);
  // The right rail is reserved for workflow-wide views. A selected node gets
  // its own canvas-layer inspector so card editing never shifts the graph or
  // replaces history/run information.
  const showGlobalPanel = isRunning || historyOpen;
  const selectedNode = selectedNodeId ? findWorkflowNode(currentWorkflow?.nodes, selectedNodeId) : null;
  const showLiveCIDetails = isRunning && selectedNode?.type === 'github-ci';

  // Hydrate the persisted width on mount (avoids SSR mismatch).
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(RIGHT_WIDTH_STORAGE_KEY);
      if (saved) {
        const n = Number(saved);
        if (Number.isFinite(n)) {
          const clamped = clampRightWidth(n);
          setRightWidth(clamped);
          rightWidthRef.current = clamped;
        }
      }
    } catch {
      // localStorage may be unavailable; fall back to default
    }
  }, []);

  useEffect(() => {
    if (useWorkflowStore.getState().currentWorkflow?.id === flowId) return;
    let cancelled = false;
    setLoadError(null);
    setMissing(false);
    (async () => {
      try {
        await flushPendingWorkflow();
        if (cancelled) return;
        const response = await fetch(`/api/workflows/${encodeURIComponent(flowId)}`);
        if (cancelled) return;
        if (response.status === 404) {
          setMissing(true);
          throw new Error('This flow could not be found.');
        }
        if (!response.ok) throw new Error(`Could not load this flow (${response.status}).`);
        const data = (await response.json()) as { workflow?: Workflow };
        if (!data.workflow || data.workflow.id !== flowId || !Array.isArray(data.workflow.nodes) || !Array.isArray(data.workflow.edges)) {
          throw new Error('Could not read this flow.');
        }
        if (!cancelled) {
          useWorkflowStore.getState().resetRun();
          useWorkflowStore.getState().setInspectedRunEvents(null);
          loadWorkflow(data.workflow);
        }
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Could not load this flow.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [flowId, loadWorkflow, loadAttempt]);

  const onResizeStart = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragStateRef.current.active = true;

    const onMove = (m: MouseEvent) => {
      if (!dragStateRef.current.active) return;
      const next = clampRightWidth(window.innerWidth - m.clientX);
      rightWidthRef.current = next;
      setRightWidth(next);
    };
    const onUp = () => {
      dragStateRef.current.active = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        // Persist the most recent dragged width from the ref so unmount of
        // .workspace-tri (e.g. user closes the right panel right after
        // releasing) doesn't strand us reading a stale DOM value.
        window.localStorage.setItem(
          RIGHT_WIDTH_STORAGE_KEY,
          String(rightWidthRef.current),
        );
      } catch {
        // localStorage may be unavailable; the next mount will fall back
        // to RIGHT_WIDTH_DEFAULT.
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  async function postRun(inputs?: Record<string, unknown>) {
    if (!currentWorkflow) return;
    // The run API deliberately loads the persisted workflow. Flush an edit
    // here instead of relying on the debounced autosave, so an immediately
    // added or reconfigured node is always part of the run being started.
    await flushPendingWorkflow();
    await fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workflowId: currentWorkflow.id,
        ...(inputs ? { inputs } : {}),
      }),
    });
  }

  function handleRun() {
    if (!currentWorkflow) return;
    const declared = currentWorkflow.inputs ?? [];
    const needsPrompt = declared.some((i) => i.default === undefined);
    if (needsPrompt) {
      setRunModalOpen(true);
    } else {
      void postRun();
    }
  }

  function handleRunWithInputs() {
    if (!currentWorkflow) return;
    setRunChevronOpen(false);
    setRunModalOpen(true);
  }

  async function handleStop() {
    if (!activeRunId) return;
    await fetch(`/api/run/stop?runId=${encodeURIComponent(activeRunId)}`, { method: 'POST' });
  }

  if (!ready) {
    return (
      <main className="flow-load-state">
        <Link href="/" className="btn btn-ghost" onClick={(event) => onNavigateLink(event, '/')}>All flows</Link>
        {navigationError && <p role="alert" className="flow-error">{navigationError}</p>}
        {loadError ? (
          <div data-testid="flow-load-error" role="alert">
            <h1>{missing ? 'Flow not found' : 'Could not open flow'}</h1>
            <p>{loadError}</p>
            {!missing && <button type="button" className="btn" onClick={() => setLoadAttempt((value) => value + 1)}>Retry</button>}
          </div>
        ) : <p role="status">Loading flow…</p>}
      </main>
    );
  }

  return (
    <div className="workflow-editor">
      {navigationError && <div role="alert" className="workflow-save-error">Could not save changes. {navigationError}</div>}
      <header className="top-bar" inert={navigating}>
        <Link href="/" className="brand" aria-label="Inf·Loop home" onClick={(event) => onNavigateLink(event, '/')}>
          <span
            className="brand-mark"
            data-ws={wsStatus}
            data-run={runStatus}
            role="status"
            aria-label={`event stream ${wsStatus}, run ${runStatus}`}
            title={`event stream ${wsStatus} · run ${runStatus}`}
          />
          <span className="brand-text">
            Inf·Loop<em>Console</em>
          </span>
        </Link>

        <div className="crumbs">
          <Link href="/" className="btn btn-ghost" onClick={(event) => onNavigateLink(event, '/')}>All flows</Link>
          <span className="workflow-title" data-testid="workflow-title">
            <span className="workflow-title-name">{currentWorkflow?.name}</span>
            {isDirty && <span className="workflow-dirty" aria-label="unsaved changes">•</span>}
          </span>
        </div>

        <div className="actions">
          <button
            ref={paletteToggleRef}
            type="button"
            className="btn btn-toggle mobile-palette-toggle"
            aria-expanded={mobilePaletteOpen}
            aria-controls="workspace-node-library"
            onClick={() => setMobilePaletteOpen((open) => !open)}
          >Nodes</button>
          <ActiveRunsBadge />
          <button
            type="button"
            className="btn btn-toggle"
            aria-label="toggle run history"
            aria-pressed={historyOpen}
            onClick={() => setHistoryOpen((v) => !v)}
            disabled={isRunning}
            title={
              isRunning
                ? 'Run history is unavailable while a run is in progress'
                : undefined
            }
          >
            History
          </button>
          {isRunning ? (
            <button
              type="button"
              onClick={handleStop}
              className="btn btn-stop"
              aria-label="stop run"
              disabled={!activeRunId}
            >
              Stop
            </button>
          ) : (
            <div ref={runGroupRef} className="run-group">
              <button
                type="button"
                onClick={handleRun}
                className="btn"
                aria-label="run workflow"
                disabled={!currentWorkflow}
                title={
                  !currentWorkflow
                    ? 'Open or create a workflow first'
                    : undefined
                }
              >
                Run
              </button>
              {(currentWorkflow?.inputs?.length ?? 0) > 0 && (
                <>
                  <button
                    type="button"
                    className="btn run-chevron"
                    aria-label="run options"
                    aria-haspopup="menu"
                    aria-expanded={runChevronOpen}
                    onClick={() => setRunChevronOpen((v) => !v)}
                  >
                    ▾
                  </button>
                  {runChevronOpen && runPopover.portal(
                    <div ref={runPopover.panelRef} style={runPopover.panelStyle} role="menu" className="run-menu">
                      <button
                        type="button"
                        role="menuitem"
                        className="btn btn-ghost run-menu-item"
                        onClick={handleRunWithInputs}
                      >
                        Run with inputs…
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </header>

      <div className="workflow-editor-content" inert={navigating}>
        <div
          className={`workspace ${showGlobalPanel ? 'workspace-tri' : 'workspace-bi'}`}
          style={{ '--right-w': `${rightWidth}px` } as CSSProperties}
        >
          <div ref={paletteRef} id="workspace-node-library" className="workspace-palette" data-open={mobilePaletteOpen}>
            <div className="mobile-palette-heading">
              <span>Nodes</span>
              <button type="button" className="btn btn-ghost" aria-label="Close nodes" onClick={closeMobilePalette}>Close</button>
            </div>
            <Palette onNodeAdded={closeMobilePalette} onSearch={openMobilePalette} />
          </div>
          <Canvas />
          {selectedNodeId && (!showGlobalPanel || showLiveCIDetails) && (
            <div className="node-inspector-layer">
              <div className="node-inspector">
                <button
                  type="button"
                  className="node-inspector-close"
                  aria-label="close node inspector"
                  onClick={() => selectNode(null)}
                >
                  ×
                </button>
                {showLiveCIDetails ? (
                  <aside className="config-stub" aria-label="live CI inspector">
                    <header className="serif config-stub-section-head">GitHub CI Gate</header>
                    <GitHubCIDetails output={githubCI[selectedNodeId] ?? latestCIOutput(runEvents, selectedNodeId)} />
                  </aside>
                ) : <ConfigPanel />}
              </div>
            </div>
          )}
          {showGlobalPanel && (
            <>
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="resize right panel"
                tabIndex={0}
                className="resize-gutter"
                onMouseDown={onResizeStart}
              />
              {isRunning ? (
                <RunView />
              ) : (
                // `showGlobalPanel` is only true for a running workflow or
                // an open history drawer, so this branch is the preserved
                // history rail rather than the card inspector.
                <RunHistory workflowId={currentWorkflow?.id} />
              )}
            </>
          )}
        </div>
      </div>
      {runModalOpen && currentWorkflow && (
        <RunInputsModal
          declared={currentWorkflow.inputs ?? []}
          onSubmit={(values) => {
            setRunModalOpen(false);
            void postRun(values);
          }}
          onCancel={() => setRunModalOpen(false)}
        />
      )}
    </div>
  );
}

function clampRightWidth(n: number): number {
  const max = Math.max(
    RIGHT_WIDTH_MIN,
    (typeof window !== 'undefined' ? window.innerWidth : 1600) -
      CANVAS_MIN_WIDTH -
      240, // palette width
  );
  return Math.min(max, Math.max(RIGHT_WIDTH_MIN, Math.floor(n)));
}
