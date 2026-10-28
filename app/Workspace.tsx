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
import WorkflowMenu from './components/WorkflowMenu';
import { useViewportPopover } from './components/useViewportPopover';
import ThemeToggle from './components/ThemeToggle';
import { QueueBadge } from './components/QueueBadge';
import { ActiveRunsBadge } from './components/ActiveRunsBadge';
import { DispatchView } from './components/DispatchView';
import Link from 'next/link';
import { useEngineWebSocket } from '../lib/client/ws-client';
import { useWorkflowStore } from '../lib/client/workflow-store-client';
import { useAutoSave } from '../lib/client/use-auto-save';

const DEFAULT_WORKFLOW_ID = 'loop-claude-until-condition';
const RIGHT_WIDTH_STORAGE_KEY = 'infinite_loop:right-width';
const RIGHT_WIDTH_DEFAULT = 440;
const RIGHT_WIDTH_MIN = 280;
const CANVAS_MIN_WIDTH = 360;

export default function Workspace() {
  useEngineWebSocket();
  useAutoSave();

  const currentWorkflow = useWorkflowStore((s) => s.currentWorkflow);
  const runStatus = useWorkflowStore((s) => s.runStatus);
  const wsStatus = useWorkflowStore((s) => s.connectionStatus);
  const selectedNodeId = useWorkflowStore((s) => s.selectedNodeId);
  const runEvents = useWorkflowStore((s) => s.runEvents);
  const githubCI = useWorkflowStore((s) => s.githubCI);
  const loadWorkflow = useWorkflowStore((s) => s.loadWorkflow);
  const saveCurrentWorkflow = useWorkflowStore((s) => s.saveCurrentWorkflow);
  const selectNode = useWorkflowStore((s) => s.selectNode);
  const undo = useWorkflowStore((s) => s.undo);
  const redo = useWorkflowStore((s) => s.redo);
  const isRunning = runStatus === 'running';

  const [view, setView] = useState<'editor' | 'dispatch'>('editor');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sync = () => setView(window.location.hash.startsWith('#dispatch') ? 'dispatch' : 'editor');
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  // Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z = redo. Skip when focus is in an
  // editable field — let the browser's native field-level undo win there so
  // typing in the prompt textarea isn't blown away by a workflow rollback.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  const [rightWidth, setRightWidth] = useState<number>(RIGHT_WIDTH_DEFAULT);
  const [historyOpen, setHistoryOpen] = useState(false);
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
    if (currentWorkflow) return;
    let cancelled = false;
    (async () => {
      try {
        let wf: unknown = null;
        const defaultRes = await fetch(`/api/workflows/${DEFAULT_WORKFLOW_ID}`);
        if (defaultRes.ok) {
          const data = await defaultRes.json();
          wf = data?.workflow;
        } else if (defaultRes.status === 404) {
          const listRes = await fetch('/api/workflows');
          if (listRes.ok) {
            const data = await listRes.json();
            const first = Array.isArray(data?.workflows) ? data.workflows[0] : null;
            if (first?.id) {
              const firstRes = await fetch(`/api/workflows/${encodeURIComponent(first.id)}`);
              if (firstRes.ok) {
                const firstData = await firstRes.json();
                wf = firstData?.workflow;
              }
            }
          }
        }
        if (!cancelled && wf) loadWorkflow(wf as Parameters<typeof loadWorkflow>[0]);
      } catch {
        // leave canvas empty so the user can still create a fresh workflow
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentWorkflow, loadWorkflow]);

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
    if (useWorkflowStore.getState().isDirty) {
      await saveCurrentWorkflow();
    }
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
    await fetch('/api/run/stop', { method: 'POST' });
  }

  return (
    <>
      <header className="top-bar">
        <div className="brand">
          <span
            className="brand-mark"
            data-ws={wsStatus}
            data-run={runStatus}
            aria-label={`event stream ${wsStatus}, run ${runStatus}`}
            title={`event stream ${wsStatus} · run ${runStatus}`}
          />
          <span className="brand-text">
            Inf·Loop<em>Console</em>
          </span>
        </div>

        <div className="crumbs">
          <WorkflowMenu />
        </div>

        <div className="actions">
          <button
            type="button"
            className={`btn ${view === 'dispatch' ? 'btn-active' : ''}`}
            onClick={() => { window.location.hash = view === 'dispatch' ? '' : '#dispatch'; }}
          >
            Dispatch
          </button>
          <ThemeToggle />
          <Link href="/queue" className="btn btn-ghost">Queue</Link>
          <QueueBadge />
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
          <span className="pill" data-status={runStatus}>
            <span className="dot" /> {runStatus}
          </span>
          {isRunning ? (
            <button
              type="button"
              onClick={handleStop}
              className="btn btn-stop"
              aria-label="stop run"
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

      {view === 'dispatch' ? (
        <DispatchView origin={typeof window !== 'undefined' ? window.location.origin : ''} />
      ) : (
        <div
          className={`workspace ${showGlobalPanel ? 'workspace-tri' : 'workspace-bi'}`}
          style={{ '--right-w': `${rightWidth}px` } as CSSProperties}
        >
          <Palette />
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
      )}
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
    </>
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
