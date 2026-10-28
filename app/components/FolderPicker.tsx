'use client';

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type RefObject } from 'react';
import { useViewportPopover } from './useViewportPopover';

const PATH_DEBOUNCE_MS = 280;

interface ListResponse {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; isDir: boolean }>;
  error?: string;
}

interface Props {
  anchorRef?: RefObject<HTMLElement | null>;
  /** Absolute path to start the picker at. Falls back to the server's home
   * directory if empty / not provided. */
  initialPath?: string;
  /** Called with the absolute path when the user clicks "Use this folder". */
  onSelect: (path: string) => void;
  /** Called when the user dismisses the picker without selecting. */
  onClose: () => void;
}

/**
 * Server-backed folder picker. Talks to `/api/fs/list` to walk the server's
 * filesystem because browsers don't expose absolute paths from their native
 * directory pickers (security sandbox), and the agent CLIs spawn server-side
 * — they need a real path the *server* can `cd` into.
 *
 * Renders as a popover anchored by the caller; click outside or Escape to
 * close. Keyboard: Enter on a row navigates into it, Backspace navigates up.
 */
export default function FolderPicker({
  anchorRef,
  initialPath,
  onSelect,
  onClose,
}: Props) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState(initialPath ?? '');
  const fallbackAnchorRef = useRef<HTMLSpanElement | null>(null);
  const { panelRef, panelStyle, portal } = useViewportPopover<HTMLDivElement>(true, anchorRef ?? fallbackAnchorRef, { minWidth: 280, maxHeight: 360 });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest in-flight request id — older responses are dropped so a slow
  // listing can't overwrite a fresher one when the user types fast.
  const inflightRef = useRef(0);

  const load = useCallback(async (path: string) => {
    const ticket = ++inflightRef.current;
    setLoading(true);
    setError(null);
    try {
      const url = path
        ? `/api/fs/list?path=${encodeURIComponent(path)}`
        : '/api/fs/list';
      const res = await fetch(url);
      if (ticket !== inflightRef.current) return; // stale
      const body = (await res.json()) as ListResponse;
      if (!res.ok) {
        setError(body.error ?? `list failed: ${res.status}`);
        // On a load error keep the user's typed text intact so they can fix
        // it without retyping; we just don't update `data`.
        return;
      }
      setData(body);
      // Sync the text input with the canonical path the server resolved
      // (drops trailing slashes, collapses `..`, etc.). That's what makes
      // tree-click → input and input → tree feel like a single source.
      setPathInput(body.path);
    } catch (err) {
      if (ticket !== inflightRef.current) return;
      setError(err instanceof Error ? err.message : 'list failed');
    } finally {
      if (ticket === inflightRef.current) setLoading(false);
    }
  }, []);

  // Initial load — uses initialPath if given, otherwise the API picks $HOME.
  useEffect(() => {
    void load(initialPath ?? '');
  }, [load, initialPath]);

  // Cleanup any pending debounce on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  /** Live-syncs typing in the path input with the tree listing. We debounce
   * so a fast typist doesn't fire a request per keystroke; the tree
   * follows once the input settles for ~280ms on an absolute path. */
  const onPathInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    setPathInput(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!next.startsWith('/')) return;
    debounceRef.current = setTimeout(() => {
      void load(next);
    }, PATH_DEBOUNCE_MS);
  };

  // Dismiss on outside click / Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDocClick = (e: MouseEvent) => {
      const node = panelRef.current;
      if (node && !node.contains(e.target as Node) && !anchorRef?.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDocClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDocClick);
    };
  }, [onClose, anchorRef]);

  /** Cancel any pending debounced load — used when the tree handles a click
   * directly so a stale typed path can't fire after the navigation. */
  const cancelDebounce = () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  };

  const goUp = () => {
    if (!data?.parent) return;
    cancelDebounce();
    void load(data.parent);
  };

  const goInto = (name: string) => {
    if (!data) return;
    cancelDebounce();
    const sep = data.path.endsWith('/') ? '' : '/';
    void load(`${data.path}${sep}${name}`);
  };

  const confirm = () => {
    if (data?.path) onSelect(data.path);
  };

  return (
    <>
      {!anchorRef && <span ref={fallbackAnchorRef} aria-hidden="true" />}
      {portal(<div
      ref={panelRef}
      style={panelStyle}
      className="folder-picker"
      role="dialog"
      aria-label="folder picker"
    >
      <div className="folder-picker-path">
        <input
          aria-label="folder path"
          type="text"
          value={pathInput}
          onChange={onPathInputChange}
          placeholder="/Users/you/projects"
          spellCheck={false}
          autoFocus
        />
        <button
          type="button"
          className="folder-picker-up"
          aria-label="go to parent directory"
          onClick={goUp}
          disabled={!data?.parent || loading}
        >
          ↑
        </button>
      </div>

      <div className="folder-picker-list" aria-label="subdirectories">
        {loading && (
          <div className="folder-picker-empty">loading…</div>
        )}
        {error && !loading && (
          <div
            className="folder-picker-empty folder-picker-error"
            aria-label="folder picker error"
          >
            {error}
          </div>
        )}
        {!loading && !error && data && data.entries.length === 0 && (
          <div className="folder-picker-empty">no subdirectories</div>
        )}
        {!loading && !error && data && data.entries.map((entry) => (
          <button
            key={entry.name}
            type="button"
            className="folder-picker-row"
            onClick={() => goInto(entry.name)}
          >
            <span className="folder-picker-row-icon" aria-hidden="true">▸</span>
            <span className="folder-picker-row-name">{entry.name}</span>
          </button>
        ))}
      </div>

      <div className="folder-picker-actions">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          onClick={confirm}
          disabled={!data || loading}
          aria-label="use this folder"
        >
          Use this folder
        </button>
      </div>
    </div>)}
    </>
  );
}
