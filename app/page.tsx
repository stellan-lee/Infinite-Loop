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
import RunView from './components/RunView';
import RunHistory from './components/RunHistory';
import WorkflowMenu from './components/WorkflowMenu';
import ThemeToggle from './components/ThemeToggle';
import { QueueBadge } from './components/QueueBadge';
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

export default function Page() {
  useEngineWebSocket();
  useAutoSave();

  const currentWorkflow = useWorkflowStore((s) => s.currentWorkflow);
  const runStatus = useWorkflowStore((s) => s.runStatus);
  const wsStatus = useWorkflowStore((s) => s.connectionStatus);
  const selectedNodeId = useWorkflowStore((s) => s.selectedNodeId);
  const loadWorkflow = useWorkflowStore((s) => s.loadWorkflow);
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
  const dragStateRef = useRef<{ active: boolean }>({ active: false });
  // Mirror of `rightWidth` for the resize handler to read on mouseup —
  // the React state setter is async and `getCurrentRightWidth()` used to
  // read off the DOM, which broke when the user switched views mid-drag
  // and `.workspace-tri` unmounted before the persist tick fired.
  const rightWidthRef = useRef<number>(RIGHT_WIDTH_DEFAULT);
  const showRightPanel = isRunning || historyOpen || !!selectedNodeId;

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
        const res = await fetch(`/api/workflows/${DEFAULT_WORKFLOW_ID}`);
        if (!res.ok) return;
        const data = await res.json();
        const wf = data?.workflow;
        if (!cancelled && wf) loadWorkflow(wf);
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
            <div className="run-group">
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
                  {runChevronOpen && (
                    <div role="menu" className="run-menu">
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
          className={`workspace ${showRightPanel ? 'workspace-tri' : 'workspace-bi'}`}
          style={{ '--right-w': `${rightWidth}px` } as CSSProperties}
        >
          <Palette />
          <Canvas />
          {showRightPanel && (
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
              ) : historyOpen ? (
                <RunHistory workflowId={currentWorkflow?.id} />
              ) : (
                <ConfigPanel />
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

