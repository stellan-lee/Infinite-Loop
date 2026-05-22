'use client';

/*
 * Templated text field with `{{nodeId.field}}` autocomplete.
 *
 * Wraps either an <input type="text"> or <textarea>. When the caret sits
 * inside an open `{{` … `}}` (or right after a fresh `{{` with no closing
 * brace yet), a popover appears underneath the field listing every
 * available ref filtered by the user's typed prefix. Picking a row
 * inserts the ref between the existing braces (or auto-closes if the
 * user only typed `{{`).
 *
 * The visible warning chip below the input flags any ref the lint pass
 * couldn't resolve (unknown node, self-ref, missing field).
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import type { TemplateLintWarning, TemplateRef } from '@/lib/shared/template-refs';
import { lintField } from '@/lib/shared/template-refs';
import { useWorkflowStore } from '@/lib/client/workflow-store-client';

interface BaseProps {
  value: string;
  onChange: (next: string) => void;
  /** Node id this field belongs to — used to drive lint + filter
   * self-references out of the picker. */
  selfId: string;
  refs: readonly TemplateRef[];
  /** Field name for accessibility + lint reporting. */
  fieldPath: string;
  ariaLabel?: string;
  placeholder?: string;
  /** Optional className forwarded to the underlying element. */
  className?: string;
  /** Style forwarded — used by ScriptForm to monospace the code field. */
  style?: CSSProperties;
}

interface InputProps extends BaseProps {
  multiline?: false;
}

interface TextareaProps extends BaseProps {
  multiline: true;
  rows?: number;
}

type Props = InputProps | TextareaProps;

/** Find the `{{ … }}` span the caret is currently sitting inside, if any.
 * Returns the absolute start/end of the inner content and the prefix the
 * user has typed so we can filter the picker. Returns null when the
 * caret is not inside braces.
 *
 * Rules (kept minimal so the matcher is fast and predictable):
 *  - Walk backwards from the caret for `{{`. Stop at the first one without
 *    a closing `}}` between it and the caret.
 *  - Walk forwards from the caret for `}}`. If absent, the user is still
 *    typing the closer — treat the segment as open-ended.
 */
export function findTemplateSlot(
  text: string,
  caret: number,
): { innerStart: number; innerEnd: number; prefix: string; hasClose: boolean } | null {
  if (caret < 0 || caret > text.length) return null;
  const openIdx = text.lastIndexOf('{{', caret - 1);
  if (openIdx === -1) return null;
  const innerStart = openIdx + 2;
  const closeBetween = text.indexOf('}}', innerStart);
  if (closeBetween !== -1 && closeBetween < caret) return null;
  // The runtime regex matches `[\w.-]+` between the braces — it doesn't
  // cross newlines. Bail if the user is on a different line than the
  // opener, so a stale unclosed `{{` many lines up doesn't keep the
  // picker open forever and prevent the user from typing a literal `{{`.
  if (text.slice(openIdx, caret).includes('\n')) return null;
  const closeAfter = text.indexOf('}}', caret);
  const hasClose = closeAfter !== -1;
  const innerEnd = hasClose ? closeAfter : text.length;
  const prefix = text.slice(innerStart, caret).trim();
  return { innerStart, innerEnd, prefix, hasClose };
}

const MAX_VISIBLE = 8;

export default function TemplateField(props: Props) {
  const { value, onChange, selfId, refs, fieldPath, ariaLabel, placeholder, className, style } = props;
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  // After a pick, we want the picker stamped shut for one render even if
  // the caret happens to land inside another `{{ }}` (shouldn't, but the
  // explicit suppress is robust against future edits to insertRef).
  const justPicked = useRef(false);
  const currentWorkflow = useWorkflowStore((s) => s.currentWorkflow);

  // Recompute the slot/prefix from the caret position on every value or
  // caret change. The popover is open iff `slot !== null` — no separate
  // `open` state, so there's no stale-state window after a pick.
  const slot = useMemo(() => {
    if (justPicked.current) {
      justPicked.current = false;
      return null;
    }
    if (caret == null) return null;
    return findTemplateSlot(value, caret);
  }, [value, caret]);

  // Filter the ref list against the user's in-slot prefix. Substring
  // match (case-insensitive) so they can type any part of the ref.
  const filtered = useMemo(() => {
    if (!slot) return refs;
    const needle = slot.prefix.toLowerCase();
    if (needle.length === 0) return refs;
    return refs.filter(
      (r) =>
        r.ref.toLowerCase().includes(needle) ||
        r.nodeId.toLowerCase().includes(needle),
    );
  }, [refs, slot]);

  // Keep activeIdx in range whenever the filtered list shrinks.
  useEffect(() => {
    if (activeIdx >= filtered.length) setActiveIdx(0);
  }, [filtered.length, activeIdx]);

  const insertRef = useCallback(
    (ref: TemplateRef) => {
      const el = inputRef.current;
      if (!el || !slot) return;
      const before = value.slice(0, slot.innerStart);
      const after = value.slice(slot.innerEnd);
      // Normalize spacing inside the braces and auto-append `}}` when the
      // user only typed `{{`.
      const inserted = ` ${ref.ref} `;
      const closer = slot.hasClose ? '' : '}}';
      const finalText = before + inserted + closer + after;
      const caretTarget = before.length + inserted.length + closer.length;

      // Commit the new caret position synchronously to suppress the slot
      // memo from briefly re-opening at the old position on the next
      // render. The rAF below only handles the DOM-level selection range.
      justPicked.current = true;
      setCaret(caretTarget);
      onChange(finalText);
      requestAnimationFrame(() => {
        const cur = inputRef.current;
        if (cur) {
          cur.focus();
          cur.setSelectionRange(caretTarget, caretTarget);
        }
      });
    },
    [onChange, slot, value],
  );

  const handleChange = (
    e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    onChange(e.target.value);
    setCaret(e.target.selectionStart);
  };

  const handleSelect = () => {
    const el = inputRef.current;
    if (el) setCaret(el.selectionStart);
  };

  const handleKeyDown = (
    e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    if (!slot || filtered.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % filtered.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      // Only intercept Enter / Tab while the picker is open with results.
      e.preventDefault();
      const pick = filtered[activeIdx];
      if (pick) insertRef(pick);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      // Close the picker without committing: stamp the suppress flag and
      // bump the caret memo so it re-evaluates to null.
      justPicked.current = true;
      setCaret((c) => c);
    }
  };

  // Blur is handled implicitly — the slot memo derives from caret/value,
  // and onMouseDown + preventDefault on picker rows keeps focus on the
  // input. No timeout dance needed.

  // Lint warnings for the current value. Cheap — runs on every render
  // against an in-memory regex. Shown as a small inline hint.
  const warnings: TemplateLintWarning[] = useMemo(() => {
    if (!currentWorkflow) return [];
    return lintField(currentWorkflow, selfId, fieldPath, value);
  }, [currentWorkflow, selfId, fieldPath, value]);

  const inputCommon = {
    ref: (el: HTMLInputElement | HTMLTextAreaElement | null) => {
      inputRef.current = el;
    },
    value,
    onChange: handleChange,
    onSelect: handleSelect,
    onClick: handleSelect,
    onKeyUp: handleSelect,
    onKeyDown: handleKeyDown,
    onFocus: handleSelect,
    'aria-label': ariaLabel,
    placeholder,
    className,
    style,
    autoComplete: 'off',
    spellCheck: false as const,
  };

  return (
    <div className="template-field" style={{ position: 'relative' }}>
      {props.multiline ? (
        <textarea {...inputCommon} rows={props.rows ?? 4} />
      ) : (
        <input {...inputCommon} type="text" />
      )}
      {slot && filtered.length > 0 && (
        <TemplatePickerPanel
          refs={filtered}
          activeIdx={activeIdx}
          onPick={insertRef}
          onHoverIdx={setActiveIdx}
        />
      )}
      {warnings.length > 0 && (
        <TemplateWarningChips warnings={warnings} />
      )}
    </div>
  );
}

function TemplatePickerPanel({
  refs,
  activeIdx,
  onPick,
  onHoverIdx,
}: {
  refs: readonly TemplateRef[];
  activeIdx: number;
  onPick: (r: TemplateRef) => void;
  onHoverIdx: (i: number) => void;
}) {
  // Scroll the active row into view when the user arrows through.
  const listRef = useRef<HTMLUListElement | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.children[activeIdx] as HTMLElement | undefined;
    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIdx]);

  return (
    <>
      <style>{pickerCss}</style>
      <ul
        ref={listRef}
        role="listbox"
        aria-label="Available template variables"
        className="template-picker-panel"
      >
        {refs.slice(0, 128).map((r, i) => (
          <li key={r.ref}>
            <button
              type="button"
              role="option"
              aria-selected={i === activeIdx}
              data-active={i === activeIdx ? 'true' : 'false'}
              data-out-of-scope={!r.inScope ? 'true' : 'false'}
              data-kind={r.kind}
              className="template-picker-row"
              title={
                !r.inScope
                  ? 'out of scope — this node runs in a branch that does not include the source. The workflow will fail to resolve this ref at run time.'
                  : r.description
              }
              onMouseDown={(e) => {
                // Stop the input from losing focus before the click hits.
                e.preventDefault();
                onPick(r);
              }}
              onMouseEnter={() => onHoverIdx(i)}
            >
              <span className="template-picker-ref">
                {!r.inScope && (
                  <span aria-hidden="true" style={{ marginRight: 4 }}>
                    ⚠
                  </span>
                )}
                {r.ref}
              </span>
              <span className="template-picker-desc">
                {r.kind === 'global'
                  ? 'global'
                  : !r.inScope
                    ? `out of scope · ${r.description}`
                    : r.description}
              </span>
            </button>
          </li>
        ))}
        {refs.length > MAX_VISIBLE && (
          <li className="template-picker-overflow">
            {refs.length} matches — keep typing to narrow
          </li>
        )}
      </ul>
    </>
  );
}

function TemplateWarningChips({
  warnings,
}: {
  warnings: readonly TemplateLintWarning[];
}) {
  return (
    <div className="template-field-warnings" role="alert">
      {warnings.map((w, i) => {
        const head = w.ref.split('.')[0];
        const reason =
          w.reason === 'unknown'
            ? `unknown node "${head}"`
            : w.reason === 'missing-field'
              ? `no such field on ${head}`
              : w.reason === 'self-ref'
                ? 'self-reference is always empty'
                : w.reason === 'out-of-scope'
                  ? `out of scope — "${head}" is not a predecessor of this node`
                  : w.reason === 'missing-input'
                    ? `no input named "${w.ref.slice('inputs.'.length)}" declared on the Begin node`
                    : `no global named "${w.ref.slice('globals.'.length)}"`;
        return (
          <span key={i} className="template-field-warning">
            ⚠ <code>{`{{${w.ref}}}`}</code> — {reason}
          </span>
        );
      })}
    </div>
  );
}

const pickerCss = `
.template-field-warnings {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 4px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--accent-err);
  letter-spacing: 0.04em;
}
.template-field-warning code {
  color: var(--accent-err);
  background: transparent;
  font-family: var(--mono);
}
.template-picker-panel {
  position: absolute;
  z-index: 40;
  left: 0;
  right: 0;
  top: 100%;
  margin-top: 4px;
  max-height: 220px;
  overflow-y: auto;
  list-style: none;
  padding: 4px 0;
  background: var(--bg-elev, var(--bg));
  border: 1px solid var(--border);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
  font-family: var(--mono);
}
.template-picker-row {
  display: grid;
  grid-template-columns: minmax(140px, 1fr) 2fr;
  gap: 12px;
  width: 100%;
  background: transparent;
  border: 0;
  padding: 5px 10px;
  text-align: left;
  cursor: pointer;
  color: var(--fg-soft);
  font-family: var(--mono);
  font-size: 12px;
  letter-spacing: 0.02em;
}
.template-picker-row[data-active='true'] {
  background: var(--hover-tint);
  color: var(--accent-live);
}
.template-picker-row[data-out-of-scope='true'] {
  color: var(--fg-faint);
}
.template-picker-row[data-out-of-scope='true'][data-active='true'] {
  color: var(--accent-err);
}
.template-picker-row[data-kind='global'] .template-picker-ref::before {
  content: '★ ';
  color: var(--accent-live);
}
.template-picker-row:focus-visible {
  outline: 1px dashed var(--accent-live);
  outline-offset: -2px;
}
.template-picker-ref {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.template-picker-desc {
  color: var(--fg-dim);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.template-picker-overflow {
  padding: 4px 10px 6px;
  font-size: 11px;
  color: var(--fg-dim);
  font-style: italic;
}
`;
