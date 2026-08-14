'use client';

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import { Input as HeroInput, TextArea as HeroTextArea } from '@heroui/react';
import { useWorkflowStore } from '@/lib/client/workflow-store-client';
import Checkbox from './Checkbox';
import FolderPicker from './FolderPicker';
import ProviderIcon from './icons/ProviderIcon';
import SelectMenu from './SelectMenu';
import TemplateField from './TemplateField';
import { TriggersPanel } from './TriggersPanel';
import {
  Segmented,
  TIMEOUT_UNIT_MS,
  TIMEOUT_UNITS,
  pickInitialTimeoutUnit,
  useDebouncedString,
  type TimeoutUnit,
} from './config/shared';
import {
  availableVariables,
  type TemplateRef,
} from '@/lib/shared/template-refs';
import {
  collectWorkflowNodeIdList,
  findWorkflowNode,
} from '@/lib/shared/workflow-graph';
import type { ProviderInfo } from '@/lib/server/providers/types';
import type {
  AgentConfig,
  AgentMessage,
  AgentMessageRole,
  AgentOutputDecl,
  BranchConfig,
  BranchOp,
  ConditionConfig,
  ConditionKind,
  EndConfig,
  LoopConfig,
  ManualConfig,
  ManualDecisionDecl,
  ManualDecisionKey,
  ParallelConfig,
  ParallelMode,
  ParallelOnError,
  ScriptConfig,
  ScriptLanguage,
  SidenoteConfig,
  StructuredOutputConfig,
  SubworkflowConfig,
  Workflow,
  WorkflowInputDecl,
  WorkflowNode,
  WorkflowSummary,
} from '@/lib/shared/workflow';
import {
  AGENT_RESERVED_OUTPUT_NAMES,
  MANUAL_DECISION_KEYS,
} from '@/lib/shared/workflow';

/** Available `{{nodeId.stdout}}` template refs for a given node id. */
function availableRefs(workflow: Workflow | null, selfId: string): string[] {
  if (!workflow) return [];
  return collectWorkflowNodeIdList(workflow.nodes)
    .filter((id) => id !== selfId)
    .map((id) => `{{${id}.stdout}}`);
}

/** Keyboard-accessible explanatory copy, shown beside a control's title. */
function FieldHelp({ label, children }: { label: string; children: ReactNode }) {
  const tooltipId = useId();
  return (
    <span className="field-label-help">
      <button
        type="button"
        className="field-label-help-trigger"
        aria-label={`More information about ${label}`}
        aria-describedby={tooltipId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.currentTarget.blur();
          }
        }}
      >
        ?
      </button>
      <span id={tooltipId} role="tooltip" className="field-label-tooltip">
        {children}
      </span>
    </span>
  );
}

/** A compact field title with keyboard-accessible explanatory copy. */
function FieldLabel({
  children,
  help,
  required = false,
}: {
  children: string;
  help?: ReactNode;
  required?: boolean;
}) {
  return (
    <span className="field-label">
      {children}
      {required ? (
        <span className="field-label-required" aria-label="required">
          *
        </span>
      ) : null}
      {help ? <FieldHelp label={children}>{help}</FieldHelp> : null}
    </span>
  );
}

/* ─── display-name field ────────────────────────────────────── */
/* Lets the user rename the canvas card's title independent of the node's
 * underlying id/type. Empty / whitespace-only commits clear the label so
 * the per-type fallback ("START", brand icon for agents, etc.) is used. */
function DisplayNameField({
  value,
  fallback,
  onCommit,
}: {
  value: string;
  fallback: string;
  onCommit: (next: string) => void;
}) {
  const [v, setV] = useDebouncedString(value, onCommit);
  return (
    <div className="field">
      <FieldLabel help="Shown on the canvas card. Leave blank to use the default.">
        Display name
      </FieldLabel>
      <HeroInput
        variant="secondary"
        aria-label="Display name"
        type="text"
        value={v}
        placeholder={fallback}
        onChange={(e) => setV(e.target.value)}
      />
    </div>
  );
}

/* ─── chips listing available template refs ────────────────── */
function RefChips({ refs }: { refs: string[] }) {
  if (refs.length === 0) return null;
  return (
    <div className="field-hint" aria-label="available template refs">
      {refs.length === 1 ? 'Available ref: ' : 'Available refs: '}
      {refs.join('  ·  ')}
    </div>
  );
}

/* ─── per-type forms ───────────────────────────────────────── */

function StartForm({ workflow }: { workflow: Workflow | null }) {
  const setWorkflowInputs = useWorkflowStore((s) => s.setWorkflowInputs);
  const setWorkflowCwd = useWorkflowStore((s) => s.setWorkflowCwd);
  const declared = workflow?.inputs ?? [];

  const update = (next: WorkflowInputDecl[]) => {
    setWorkflowInputs(next);
  };

  const addRow = () => {
    const used = new Set(declared.map((d) => d.name));
    let i = 1;
    let name = `input${i}`;
    while (used.has(name)) {
      i += 1;
      name = `input${i}`;
    }
    update([...declared, { name, type: 'string' }]);
  };

  const removeRow = (idx: number) => {
    update(declared.filter((_, i) => i !== idx));
  };

  const patchRow = (idx: number, patch: Partial<WorkflowInputDecl>) => {
    update(declared.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  };

  const nameCounts = new Map<string, number>();
  for (const d of declared) {
    nameCounts.set(d.name, (nameCounts.get(d.name) ?? 0) + 1);
  }
  const idRe = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

  return (
    <div className="bni-panel" aria-label="workflow inputs">
      <CwdField
        value={workflow?.cwd ?? ''}
        onChange={setWorkflowCwd}
        label="Global working directory"
        help="Used by every agent without its own working-directory override. If blank, agents run in /tmp."
        emptyDisplay="/tmp (fallback — click to choose)"
      />
      <p className="field-hint bni-blurb">
        Inputs supplied per run. Reference them in templates as{' '}
        <code className="bni-code">{'{{inputs.NAME}}'}</code>
        . An input with no default is required at run time.
      </p>

      {declared.length === 0 && (
        <p className="field-hint">
          No inputs declared. The workflow will run with no parameters.
        </p>
      )}

      {declared.map((row, idx) => {
        const dup = (nameCounts.get(row.name) ?? 0) > 1;
        const badId = !idRe.test(row.name);
        const defaultBad = row.default !== undefined && !validDefault(row);
        return (
          <fieldset key={idx} className="bni-row">
            <div className="bni-row-head">
              <label className="bni-name">
                name
                <HeroInput
        variant="secondary"
                  type="text"
                  value={row.name}
                  placeholder="name"
                  onChange={(e) => patchRow(idx, { name: e.target.value })}
                />
              </label>
              <div className="bni-type">
                <span className="bni-type-label">type</span>
                <SelectMenu<WorkflowInputDecl['type']>
                  value={row.type}
                  ariaLabel={`type for input ${row.name || idx}`}
                  options={[
                    { value: 'string', label: 'string' },
                    { value: 'text', label: 'text' },
                    { value: 'number', label: 'number' },
                    { value: 'boolean', label: 'boolean' },
                  ]}
                  onChange={(next) =>
                    patchRow(idx, { type: next, default: undefined })
                  }
                />
              </div>
              <button
                type="button"
                className="btn btn-ghost bni-remove"
                onClick={() => removeRow(idx)}
                aria-label={`remove input ${row.name}`}
              >
                ×
              </button>
            </div>

            <label className="bni-default">
              default (empty = required)
              <DefaultEditor row={row} onChange={(d) => patchRow(idx, { default: d })} />
            </label>

            <label className="bni-description">
              description
              <HeroInput
        variant="secondary"
                type="text"
                value={row.description ?? ''}
                placeholder="optional"
                onChange={(e) =>
                  patchRow(idx, { description: e.target.value || undefined })
                }
              />
            </label>

            {dup && <p className="field-error">duplicate name</p>}
            {badId && (
              <p className="field-error">
                name must match /^[a-zA-Z_][a-zA-Z0-9_]*$/
              </p>
            )}
            {defaultBad && (
              <p className="field-error">default does not parse as {row.type}</p>
            )}
          </fieldset>
        );
      })}

      <button type="button" className="btn btn-ghost bni-add" onClick={addRow}>
        + add input
      </button>
    </div>
  );
}

function validDefault(row: WorkflowInputDecl): boolean {
  if (row.default === undefined) return true;
  switch (row.type) {
    case 'string':
    case 'text':
      return typeof row.default === 'string';
    case 'number':
      return typeof row.default === 'number' && Number.isFinite(row.default);
    case 'boolean':
      return typeof row.default === 'boolean';
  }
}

function DefaultEditor({
  row,
  onChange,
}: {
  row: WorkflowInputDecl;
  onChange: (next: WorkflowInputDecl['default']) => void;
}) {
  switch (row.type) {
    case 'string':
      return (
        <HeroInput
        variant="secondary"
          type="text"
          value={typeof row.default === 'string' ? row.default : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        />
      );
    case 'text':
      return (
        <HeroTextArea
        variant="secondary"
          value={typeof row.default === 'string' ? row.default : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        />
      );
    case 'number': {
      const v = typeof row.default === 'number' ? row.default : '';
      return (
        <HeroInput
        variant="secondary"
          type="number"
          value={v}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') return onChange(undefined);
            const n = Number(raw);
            onChange(Number.isFinite(n) ? n : undefined);
          }}
        />
      );
    }
    case 'boolean': {
      const v: 'unset' | 'true' | 'false' =
        row.default === true ? 'true' : row.default === false ? 'false' : 'unset';
      return (
        <SelectMenu<'unset' | 'true' | 'false'>
          value={v}
          ariaLabel="default value"
          options={[
            { value: 'unset', label: '(unset)' },
            { value: 'true', label: 'true' },
            { value: 'false', label: 'false' },
          ]}
          onChange={(next) =>
            onChange(next === 'true' ? true : next === 'false' ? false : undefined)
          }
        />
      );
    }
  }
}

function EndForm({
  config,
  onPatch,
}: {
  config: EndConfig;
  onPatch: (next: EndConfig) => void;
}) {
  const outcome: NonNullable<EndConfig['outcome']> = config.outcome ?? 'succeeded';
  return (
    <Segmented<NonNullable<EndConfig['outcome']>>
      label="Outcome"
      value={outcome}
      options={[
        { value: 'succeeded', label: 'Succeeded' },
        { value: 'failed', label: 'Failed' },
      ]}
      onChange={(next) => onPatch({ ...config, outcome: next })}
    />
  );
}

function SidenoteForm({
  config,
  onPatch,
}: {
  config: SidenoteConfig;
  onPatch: (next: SidenoteConfig) => void;
}) {
  const [text, setText] = useDebouncedString(config.text ?? '', (next) =>
    onPatch({ ...config, text: next }),
  );
  return (
    <div className="field">
      <FieldLabel help="Static text. No templating, no execution — purely for documentation.">
        Note
      </FieldLabel>
      <HeroTextArea
        variant="secondary"
        aria-label="Note text"
        rows={6}
        value={text}
        placeholder="Write a free-form note — pinned to the canvas, not run by the engine."
        onChange={(e) => setText(e.target.value)}
      />
    </div>
  );
}

/** Mirror of the server-side CliAgent shape (kept local so the client
 * doesn't import from `lib/server/...`). Only `name` is required by the
 * UI; the rest decorates the dropdown option text. */
interface AgentChoice {
  name: string;
  model?: string;
  group?: 'user' | 'project' | 'builtin';
}

/**
 * Custom-styled agent picker. Wraps a free-text input with a popover list
 * of discovered agents — terminal-aesthetic, not the browser's native
 * `<datalist>` (which renders inconsistently across browsers and breaks
 * the visual language of the rest of the app). The user can still type
 * a name that isn't in the list.
 */
function AgentPicker({
  value,
  onChange,
  choices,
}: {
  value: string;
  onChange: (next: string) => void;
  choices: AgentChoice[];
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click + Esc, but only while open. We listen in capture
  // phase so xyflow / global handlers can't swallow the event before us.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const root = wrapRef.current;
      if (!root) return;
      if (!root.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Filter against the current input value (case-insensitive substring),
  // keeping the original order so users see groups clustered as the CLI
  // returned them.
  const needle = value.trim().toLowerCase();
  const filtered = needle.length
    ? choices.filter((a) => a.name.toLowerCase().includes(needle))
    : choices;

  return (
    <div ref={wrapRef} className="agent-picker">
      <input
        aria-label="Agent"
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder="(optional — leave blank for default)"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
      />
      {open && filtered.length > 0 && (
        <ul role="listbox" aria-label="Available agents" className="agent-picker-panel">
          {filtered.map((a) => {
            const groupLabel =
              a.group === 'user'
                ? 'user'
                : a.group === 'project'
                  ? 'project'
                  : a.group === 'builtin'
                    ? 'built-in'
                    : '';
            const meta = [groupLabel, a.model].filter(Boolean).join(' · ');
            return (
              <li key={a.name}>
                <button
                  type="button"
                  role="option"
                  aria-selected={a.name === value}
                  className="agent-picker-row"
                  onMouseDown={(e) => {
                    // mousedown (not click) so the input's blur doesn't fire
                    // first and unmount the panel before the click lands.
                    e.preventDefault();
                    onChange(a.name);
                    setOpen(false);
                  }}
                >
                  <span className="agent-picker-name">{a.name}</span>
                  {meta && <span className="agent-picker-meta">{meta}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Custom single-select dropdown — used in places where a native `<select>`
 * would be visually inconsistent with the rest of the terminal UI. Reads
 * as a button + popover, same family as AgentPicker and wf-menu.
 */
function WorkflowPicker({
  value,
  choices,
  onChange,
}: {
  value: string;
  choices: WorkflowSummary[];
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const root = wrapRef.current;
      if (root && !root.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selected = value ? choices.find((c) => c.id === value) : null;
  const buttonLabel = selected
    ? `${selected.id} (${selected.name})${selected.source === 'library' ? ' [library]' : ''}`
    : '(none — pick a workflow)';

  return (
    <div ref={wrapRef} className="agent-picker">
      <button
        type="button"
        className="custom-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className={selected ? 'custom-select-value' : 'custom-select-placeholder'}
        >
          {buttonLabel}
        </span>
        <span className="custom-select-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label="Available workflows"
          className="agent-picker-panel"
        >
          <li>
            <button
              type="button"
              role="option"
              aria-selected={value === ''}
              className="agent-picker-row"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange('');
                setOpen(false);
              }}
            >
              <span className="agent-picker-name">(none)</span>
              <span className="agent-picker-meta">clear</span>
            </button>
          </li>
          {choices.length === 0 && (
            <li>
              <div className="agent-picker-row agent-picker-row--inert">
                <span className="agent-picker-meta">no other workflows</span>
              </div>
            </li>
          )}
          {choices.map((w) => (
            <li key={w.id}>
              <button
                type="button"
                role="option"
                aria-selected={value === w.id}
                className="agent-picker-row"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(w.id);
                  setOpen(false);
                }}
              >
                <span className="agent-picker-name">{w.id}</span>
                <span className="agent-picker-meta">
                  {[w.name, w.source === 'library' ? 'library' : null]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ─── working-directory field ───────────────────────────────
 * Shared by workflow settings, AgentForm (CLI providers), and ScriptForm. Renders the
 * read-only tail-truncated preview backed by FolderPicker. The truncation
 * math + invalid-path warning live here so any future cwd consumer gets
 * the same behavior without re-implementing it. */
function CwdField({
  value,
  onChange,
  label = 'Working directory',
  required = false,
  help,
  emptyDisplay = '(no folder selected — click to choose)',
}: {
  value: string;
  onChange: (next: string) => void;
  label?: string;
  required?: boolean;
  help?: ReactNode;
  emptyDisplay?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const [display, setDisplay] = useState(value);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !value) {
      setDisplay(value);
      return;
    }
    const recompute = () => {
      const cs = getComputedStyle(el);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const usable = el.clientWidth - padX;
      if (usable <= 0) return;
      const probe = document.createElement('span');
      probe.style.font = cs.font;
      probe.style.visibility = 'hidden';
      probe.style.position = 'absolute';
      probe.style.whiteSpace = 'pre';
      probe.textContent = 'M';
      document.body.appendChild(probe);
      const charW = probe.getBoundingClientRect().width;
      document.body.removeChild(probe);
      if (charW <= 0) return;
      const fits = Math.floor(usable / charW);
      if (value.length <= fits) {
        setDisplay(value);
      } else {
        setDisplay('…' + value.slice(value.length - (fits - 1)));
      }
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [value]);

  const invalid = value.length > 0 && !value.startsWith('/');

  return (
    <div className="field field--relative">
      <FieldLabel required={required} help={help}>{label}</FieldLabel>
      <div
        ref={ref}
        role="button"
        tabIndex={0}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-required={required || undefined}
        aria-invalid={invalid || undefined}
        title={value || undefined}
        data-tooltip={value || undefined}
        className={`field-readonly cwd-preview${value ? '' : ' is-empty'}`}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {value ? display : emptyDisplay}
      </div>
      {invalid && (
        <span className="field-hint field-hint--error">
          Must start with /
        </span>
      )}
      {open && (
        <FolderPicker
          initialPath={value && value.startsWith('/') ? value : undefined}
          onSelect={(picked) => {
            onChange(picked);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/* ── Agent outputs editor ─────────────────────────────────────
 * Declared outputs are `AgentOutputDecl[]` (order-preserving array of
 * `{ name, description? }`) — distinct from SubworkflowForm's KvRow editor
 * which works on `Record<string, string>`. The agent calls
 * `set_output({key, value})` against the injected SetOutput MCP server; on
 * exit the engine flat-merges the recorded values into this node's outputs,
 * so downstream nodes read them as `{{<node-id>.<name>}}`.
 *
 * Per-row debounced buffers (same pattern as KvRow) keep keystrokes out of
 * the workflow store. Reserved-name / duplicate-name warnings are surfaced
 * inline as a UX assist; the server still validates on save
 * (lib/server/workflow-store.ts validateNodeConfig). */
interface AgentOutputRowData {
  rowId: string;
  name: string;
  description: string;
}

function agentOutputsToRows(
  decls: AgentOutputDecl[] | undefined,
): AgentOutputRowData[] {
  if (!decls) return [];
  return decls.map((d, i) => ({
    rowId: `aor-${i}-${d.name}`,
    name: d.name,
    description: d.description ?? '',
  }));
}

/** Drop empty-name rows; trim; omit `description` when blank so the saved
 * shape matches what a hand-written workflow.json would look like (avoids
 * `description: ""` cluttering the file and the validator's expectations). */
function rowsToAgentOutputs(rows: AgentOutputRowData[]): AgentOutputDecl[] {
  const out: AgentOutputDecl[] = [];
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    const desc = row.description.trim();
    out.push(desc ? { name, description: desc } : { name });
  }
  return out;
}

function nextAgentOutputRowId(): string {
  return `aor-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

const AGENT_RESERVED_OUTPUT_SET = new Set<string>(AGENT_RESERVED_OUTPUT_NAMES);

/** UX-side validation — server still re-checks on save. Returns `null` for
 * blank names so a freshly-added empty row doesn't shout at the user. */
function agentOutputRowWarning(
  name: string,
  allRows: readonly AgentOutputRowData[],
  selfRowId: string,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (AGENT_RESERVED_OUTPUT_SET.has(trimmed)) {
    return `"${trimmed}" is reserved by the agent runtime`;
  }
  const dup = allRows.some(
    (r) => r.rowId !== selfRowId && r.name.trim() === trimmed,
  );
  if (dup) return `duplicate name "${trimmed}"`;
  return null;
}

function AgentOutputRow({
  row,
  index,
  warning,
  onCommit,
  onRemove,
}: {
  row: AgentOutputRowData;
  index: number;
  warning: string | null;
  onCommit: (patch: Partial<AgentOutputRowData>) => void;
  onRemove: () => void;
}) {
  const [name, setName] = useDebouncedString(row.name, (next) =>
    onCommit({ name: next }),
  );
  const [description, setDescription] = useDebouncedString(
    row.description,
    (next) => onCommit({ description: next }),
  );
  return (
    <div className="kv-row">
      <HeroInput
        variant="secondary"
        aria-label={`agent output name ${index}`}
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="PR_LINK"
      />
      <div className="kv-row-value">
        <HeroInput
        variant="secondary"
          aria-label={`agent output description ${index}`}
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="what the agent should put here (optional)"
        />
        {warning ? (
          <span className="field-hint field-hint--error">{warning}</span>
        ) : null}
      </div>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={onRemove}
        aria-label={`remove agent output ${index}`}
      >
        ✕
      </button>
    </div>
  );
}

function AgentOutputsEditor({
  config,
  onPatch,
}: {
  config: AgentConfig;
  onPatch: (next: AgentConfig) => void;
}) {
  const [rows, setRows] = useState<AgentOutputRowData[]>(() =>
    agentOutputsToRows(config.outputs),
  );
  // `rowsRef` mirrors `rows` synchronously so mutating ops (commit / addRow /
  // updateRow / removeRow) always read the latest list — without it, two
  // debounced field commits firing in the same tick (e.g. user types into
  // name and description, then 200ms passes) both close over the same stale
  // pre-commit `rows`, and the second one clobbers the first. The ref-based
  // read makes the editor commute under batched updates.
  const rowsRef = useRef(rows);
  // Re-sync from upstream only when the parent-provided array reference
  // changes (node-switch / undo / external mutation). Our own commits
  // re-assign the ref ourselves and skip via the equality check.
  const lastDecls = useRef(config.outputs);
  useEffect(() => {
    if (config.outputs !== lastDecls.current) {
      lastDecls.current = config.outputs;
      const next = agentOutputsToRows(config.outputs);
      rowsRef.current = next;
      setRows(next);
    }
  }, [config.outputs]);

  const commit = (next: AgentOutputRowData[]) => {
    rowsRef.current = next;
    setRows(next);
    const decls = rowsToAgentOutputs(next);
    // Canonicalize: undefined when empty so a cleared editor matches a
    // freshly-created agent node (no `outputs` key at all).
    const patched = decls.length > 0 ? decls : undefined;
    lastDecls.current = patched;
    onPatch({ ...config, outputs: patched });
  };

  const updateRow = (rowId: string, patch: Partial<AgentOutputRowData>) =>
    commit(
      rowsRef.current.map((r) =>
        r.rowId === rowId ? { ...r, ...patch } : r,
      ),
    );
  const removeRow = (rowId: string) =>
    commit(rowsRef.current.filter((r) => r.rowId !== rowId));
  const addRow = () =>
    commit([
      ...rowsRef.current,
      { rowId: nextAgentOutputRowId(), name: '', description: '' },
    ]);

  return (
    <div className="kv-rows">
      {rows.map((row, i) => (
        <AgentOutputRow
          key={row.rowId}
          row={row}
          index={i}
          warning={agentOutputRowWarning(row.name, rows, row.rowId)}
          onCommit={(patch) => updateRow(row.rowId, patch)}
          onRemove={() => removeRow(row.rowId)}
        />
      ))}
      <button
        type="button"
        className="btn btn-ghost kv-add"
        onClick={addRow}
      >
        + add output
      </button>
    </div>
  );
}

const AGENT_MESSAGE_ROLE_OPTIONS: Array<{ value: AgentMessageRole; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'user', label: 'User' },
  { value: 'assistant', label: 'Assistant' },
];

type AgentMessageFilter = 'all' | AgentMessageRole;
const AGENT_MESSAGE_FILTER_OPTIONS: Array<{ value: AgentMessageFilter; label: string }> = [
  { value: 'all', label: 'All roles' },
  ...AGENT_MESSAGE_ROLE_OPTIONS,
];

function messageRoleOptions(index: number) {
  return index === 0
    ? AGENT_MESSAGE_ROLE_OPTIONS
    : AGENT_MESSAGE_ROLE_OPTIONS.filter(({ value }) => value !== 'system');
}

function editorMessages(config: AgentConfig): AgentMessage[] {
  if (Array.isArray(config.messages) && config.messages.length > 0) {
    return config.messages;
  }
  return [{ role: 'user', content: config.prompt ?? '' }];
}

function AgentMessagesEditor({
  config,
  refs,
  selfId,
  onPatch,
}: {
  config: AgentConfig;
  refs: readonly TemplateRef[];
  selfId: string;
  onPatch: (next: AgentConfig) => void;
}) {
  const messages = editorMessages(config);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<AgentMessageFilter>('all');
  const [detailCollapsed, setDetailCollapsed] = useState(false);
  useEffect(() => {
    setSelectedIndex(0);
  }, [selfId]);
  useEffect(() => {
    setSelectedIndex((index) => Math.min(index, messages.length - 1));
  }, [messages.length]);
  const commit = (next: AgentMessage[]) => onPatch({ ...config, messages: next });
  const update = (index: number, patch: Partial<AgentMessage>) => {
    commit(messages.map((message, i) => i === index ? { ...message, ...patch } : message));
  };
  const selectedMessage = messages[selectedIndex] ?? messages[0];
  const visibleMessages = messages
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => {
      const matchingRole = filter === 'all' || message.role === filter;
      const matchingSearch = search.trim() === '' ||
        message.content.toLowerCase().includes(search.trim().toLowerCase());
      return matchingRole && matchingSearch;
    });
  const preview = (content: string) => {
    const line = content.replace(/\s+/g, ' ').trim();
    return line || 'Empty message';
  };
  const duplicate = (index: number) => {
    const next = [...messages];
    next.splice(index + 1, 0, {
      ...messages[index],
      // System instructions belong only at the start of the conversation.
      role: messages[index].role === 'system' ? 'user' : messages[index].role,
    });
    commit(next);
    setSelectedIndex(index + 1);
  };
  const remove = (index: number) => {
    if (messages.length === 1) return;
    const next = messages.filter((_, i) => i !== index);
    commit(next);
    setSelectedIndex((current) => {
      if (index < current) return current - 1;
      if (index === current) return Math.min(index, next.length - 1);
      return current;
    });
  };

  return (
    <div className="agent-messages">
      <div className="agent-messages-toolbar">
        <span className="agent-messages-title">Messages <b>{messages.length}</b></span>
        <div className="agent-messages-tools">
          <label className="agent-message-search">
            <span aria-hidden="true">⌕</span>
            <input
              aria-label="Search messages"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search"
            />
          </label>
          <SelectMenu<AgentMessageFilter>
            ariaLabel="Filter messages"
            value={filter}
            options={AGENT_MESSAGE_FILTER_OPTIONS}
            onChange={setFilter}
            className="agent-message-filter"
          />
          <button
            type="button"
            className="agent-message-collapse"
            onClick={() => setDetailCollapsed((collapsed) => !collapsed)}
          >
            {detailCollapsed ? 'Expand detail' : 'Collapse all'}
          </button>
        </div>
      </div>
      <div className="agent-message-list" aria-label="Messages">
        {visibleMessages.map(({ message, index }) => (
          <div
            key={index}
            className="agent-message-summary"
            data-selected={index === selectedIndex}
            data-role={message.role}
          >
            <div
              className="agent-message-summary-main"
              onClick={() => {
                setSelectedIndex(index);
                setDetailCollapsed(false);
              }}
            >
              <button
                type="button"
                className="agent-message-summary-select"
                aria-label={`select message ${index + 1}`}
                onClick={() => {
                  setSelectedIndex(index);
                  setDetailCollapsed(false);
                }}
              >
              <span className="agent-message-grip" aria-hidden="true">⠿</span>
              <span className="agent-message-index">{index + 1}</span>
              </button>
              <button
                type="button"
                className="agent-message-role-badge"
                onClick={() => {
                  setSelectedIndex(index);
                  setDetailCollapsed(false);
                }}
              >
                {message.role}
              </button>
              <button
                type="button"
                className="agent-message-preview"
                onClick={() => {
                  setSelectedIndex(index);
                  setDetailCollapsed(false);
                }}
              >
                {preview(message.content)}
              </button>
            </div>
            <div className="agent-message-summary-actions">
              <button
                type="button"
                className="agent-message-action"
                aria-label={`duplicate message ${index + 1}`}
                title="Duplicate message"
                onClick={() => duplicate(index)}
              >
                ⧉
              </button>
              {messages.length > 1 ? (
                <button
                  type="button"
                  className="agent-message-action"
                  aria-label={`remove message ${index + 1}`}
                  title="Remove message"
                  onClick={() => remove(index)}
                >
                  ×
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {visibleMessages.length === 0 ? (
        <p className="agent-message-empty">No messages match this filter.</p>
      ) : null}
      {!detailCollapsed ? <section className="agent-message-detail" data-role={selectedMessage.role}>
        <div className="agent-message-detail-head">
          <span>Message {selectedIndex + 1} of {messages.length}</span>
        </div>
        <SelectMenu<AgentMessageRole>
          ariaLabel={`Role for message ${selectedIndex + 1}`}
          value={selectedMessage.role}
          options={messageRoleOptions(selectedIndex)}
          onChange={(role) => update(selectedIndex, { role })}
        />
        <TemplateField
          multiline
          rows={3}
          ariaLabel={`${selectedMessage.role} message ${selectedIndex + 1}`}
          value={selectedMessage.content}
          onChange={(content) => update(selectedIndex, { content })}
          selfId={selfId}
          refs={refs}
          fieldPath={`messages.${selectedIndex}.content`}
          required
        />
      </section> : null}
      <button
        type="button"
        className="agent-message-add"
        onClick={() => {
          commit([...messages, { role: 'user', content: '' }]);
          setSelectedIndex(messages.length);
          setDetailCollapsed(false);
        }}
      >
        + Add message
      </button>
    </div>
  );
}

function AgentForm({
  config,
  refs,
  templateRefs,
  selfId,
  workflowCwd,
  providerInfo,
  onPatch,
}: {
  config: AgentConfig;
  refs: string[];
  templateRefs: readonly TemplateRef[];
  selfId: string;
  workflowCwd?: string;
  /** Provider metadata for `config.providerId`, fetched once at the panel
   * level. `null` while the panel-level fetch is in flight, or if the id
   * doesn't match any known provider. */
  providerInfo: ProviderInfo | null;
  onPatch: (next: AgentConfig) => void;
}) {
  const [cwd, setCwd] = useDebouncedString(config.cwd ?? '', (next) =>
    onPatch({ ...config, cwd: next }),
  );
  const [agent, setAgent] = useDebouncedString(config.agent ?? '', (next) =>
    onPatch({ ...config, agent: next.trim() ? next.trim() : undefined }),
  );
  const [profile, setProfile] = useDebouncedString(config.profile ?? '', (next) =>
    onPatch({ ...config, profile: next.trim() ? next.trim() : undefined }),
  );
  const [model, setModel] = useDebouncedString(config.model ?? '', (next) =>
    onPatch({ ...config, model: next.trim() ? next.trim() : undefined }),
  );
  const onProfileChange = (e: ChangeEvent<HTMLInputElement>) => {
    setProfile(e.target.value);
  };
  const onModelChange = (e: ChangeEvent<HTMLInputElement>) => {
    setModel(e.target.value);
  };
  const [worktreeRef, setWorktreeRef] = useDebouncedString(
    config.worktreeRef ?? '',
    (next) =>
      onPatch({
        ...config,
        worktreeRef: next.trim() ? next.trim() : undefined,
      }),
  );

  const providerId = config.providerId ?? 'claude';
  const isHttpProvider = providerInfo?.transport === 'http';
  const supportsCliProfile = providerInfo?.manifestSupportsProfile === true;
  const supportsCliModel = providerInfo?.manifestSupportsModel === true;
  // Keep the field visible while provider metadata is loading. Once a CLI
  // manifest is known, it is shown only when that manifest accepts {agent}.
  const supportsCliAgent =
    providerInfo === null || providerInfo.manifestSupportsAgent === true;
  const useWorktree = config.useWorktree === true;
  const effectiveCwd = cwd || workflowCwd || '/tmp';

  // Fetch the CLI provider's available agents so the Agent field can
  // suggest them. The cwd is part of the probe because `claude agents`
  // resolves project-scoped agents from the working directory's settings
  // stack — change the cwd, and the listing changes too. When the new
  // listing no longer contains the currently-selected agent (a project-
  // level agent from the old directory), we clear the field so the user
  // has to re-pick; built-in / user-global agents survive the change.
  const [agentChoices, setAgentChoices] = useState<AgentChoice[]>([]);
  useEffect(() => {
    if (isHttpProvider || !supportsCliAgent) {
      setAgentChoices([]);
      return;
    }
    // Only probe once an absolute cwd is set; relative cwds would resolve
    // against the server, not the workflow's intended directory.
    if (!effectiveCwd.startsWith('/')) {
      setAgentChoices([]);
      return;
    }
    let cancelled = false;
    fetch(
      `/api/providers/${encodeURIComponent(providerId)}/agents?cwd=${encodeURIComponent(effectiveCwd)}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { agents?: AgentChoice[] } | null) => {
        if (cancelled || !data || !Array.isArray(data.agents)) return;
        setAgentChoices(data.agents);
        const current = (config.agent ?? '').trim();
        if (
          current.length > 0 &&
          data.agents.length > 0 &&
          !data.agents.some((a) => a.name === current)
        ) {
          // The previously-selected agent doesn't exist in the new cwd's
          // listing. Clear it so the user has to re-select.
          setAgent('');
          onPatch({ ...config, agent: undefined });
        }
      })
      .catch(() => {
        // Silent: not every CLI provider exposes a listing. The input still works.
      });
    return () => {
      cancelled = true;
    };
    // We intentionally exclude `config` and `onPatch` from deps: this effect
    // is keyed to the (providerId, cwd, transport) triplet — re-running it
    // on every config keystroke would thrash. We read `config.agent` once
    // when the new listing arrives, which is the only place it's needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, isHttpProvider, supportsCliAgent, effectiveCwd]);

  // Timeout: millisecond is the wire format (kept as `timeoutMs` on the
  // workflow), but a human entering "60000" was a paper cut. We let the
  // user pick a unit (s / min / hr) and convert at the field boundary.
  // Initial unit is auto-picked so an existing 5-min timeout reads as
  // "5 min" not "300 s".
  const timeoutMsRaw = config.timeoutMs ?? 60000;
  const [timeoutUnit, setTimeoutUnit] = useState<TimeoutUnit>(() =>
    pickInitialTimeoutUnit(timeoutMsRaw),
  );
  // Round display to 2 decimals so a value that doesn't divide cleanly into
  // the chosen unit (e.g. 1,000,000 ms shown as minutes = 16.6666…) renders
  // as `16.67` instead of a wall of repeating digits. Number() drops the
  // trailing zero so a clean value still reads as `60`, not `60.00`.
  const timeoutDisplay = Number(
    (timeoutMsRaw / TIMEOUT_UNIT_MS[timeoutUnit]).toFixed(2),
  );

  const onTimeoutChange = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (raw === '') return;
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) {
      const ms = Math.max(1000, Math.round(value * TIMEOUT_UNIT_MS[timeoutUnit]));
      onPatch({ ...config, timeoutMs: ms });
    }
  };

  return (
    <>
      {supportsCliProfile && (
        <div className="field">
          <FieldLabel help="Optional CLI profile passed through the provider manifest. Leave blank to omit it.">
            Profile
          </FieldLabel>
          <HeroInput
        variant="secondary"
            aria-label="Profile"
            type="text"
            value={profile}
            onChange={onProfileChange}
            placeholder="optional profile"
          />
        </div>
      )}

      {supportsCliModel && (
        <div className="field">
          <FieldLabel help="Optional CLI model passed through the provider manifest. Leave blank to omit it.">
            Model
          </FieldLabel>
          <HeroInput
        variant="secondary"
            aria-label="Model"
            type="text"
            value={model}
            onChange={onModelChange}
            placeholder="optional model"
          />
        </div>
      )}

      <div className="field">
        <AgentMessagesEditor
          config={config}
          selfId={selfId}
          refs={templateRefs}
          onPatch={onPatch}
        />
        <RefChips refs={refs} />
      </div>

      {!isHttpProvider && (
        <CwdField
          value={cwd}
          onChange={setCwd}
          label="Working directory override"
          help="Optional. Overrides the workflow-wide working directory; when both are blank, this agent runs in /tmp."
          emptyDisplay="(uses global workdir or /tmp — click to choose)"
        />
      )}

      {!isHttpProvider && supportsCliAgent && (
        <div className="field">
          <FieldLabel
            help={
              <>
                Adds <code>--agent &lt;name&gt;</code> to the spawned command. Leave blank to omit the flag.
              </>
            }
          >
            Agent
          </FieldLabel>
          <AgentPicker
            value={agent}
            onChange={setAgent}
            choices={agentChoices}
          />
        </div>
      )}

      {!isHttpProvider && (
        <div className="field">
          <div className="checkbox-row-with-help">
            <Checkbox
              className="checkbox-row"
              label="Run in isolated git worktree"
              checked={useWorktree}
              onChange={(next) =>
                onPatch({
                  ...config,
                  useWorktree: next ? true : undefined,
                  ...(next ? {} : { worktreeRef: undefined }),
                })
              }
            />
            <FieldHelp label="Run in isolated git worktree">
              Creates a fresh worktree off <code>cwd</code> so parallel agents don&apos;t collide. Uncommitted edits in <code>cwd</code> are NOT included — commit or stash first.
            </FieldHelp>
          </div>
          {useWorktree && (
            <div className="field" style={{ marginTop: 8 }}>
              <FieldLabel
                help={
                  <>
                    Branch, tag, or commit. Blank = HEAD of <code>cwd</code>. Supports <code>{'{{…}}'}</code> templating.
                  </>
                }
              >
                Worktree base ref
              </FieldLabel>
              <HeroInput
        variant="secondary"
                aria-label="Worktree base ref"
                type="text"
                value={worktreeRef}
                onChange={(e) => setWorktreeRef(e.target.value)}
                placeholder="HEAD"
              />
            </div>
          )}
        </div>
      )}

      {!isHttpProvider && (
        <div className="field">
          <div className="checkbox-row-with-help">
            <Checkbox
              className="checkbox-row"
              label="Skip permission prompts (dangerous)"
              checked={config.dangerouslySkipPermissions === true}
              onChange={(next) =>
                onPatch({
                  ...config,
                  dangerouslySkipPermissions: next ? true : undefined,
                })
              }
            />
            <FieldHelp label="Skip permission prompts (dangerous)">
              Runs the agent with every tool-permission prompt disabled — full autonomous file, shell, and network access. Leave off unless you trust the prompt and run inside the sandboxed container. Applies to providers that support it (Claude).
            </FieldHelp>
          </div>
        </div>
      )}

      <div className="field">
        <FieldLabel required>Iteration timeout</FieldLabel>
        <div className="field-row">
          <HeroInput
        variant="secondary"
            aria-label="Iteration timeout"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            required
            value={timeoutDisplay}
            onChange={onTimeoutChange}
            className="no-spin"
          />
          <div
            className="seg-tight"
            role="group"
            aria-label="Iteration timeout unit"
          >
            {TIMEOUT_UNITS.map((u) => (
              <button
                key={u}
                type="button"
                data-active={timeoutUnit === u}
                aria-pressed={timeoutUnit === u}
                onClick={() => setTimeoutUnit(u)}
              >
                {u}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Outputs are CLI-only: the engine injects a SetOutput MCP server via
       * `--mcp-config`, which HTTP providers don't accept. Hidden for HTTP
       * to match the Cwd / Agent / Worktree gating above; existing
       * `config.outputs` is preserved on the wire so toggling provider
       * back doesn't drop the user's declared list. */}
      {!isHttpProvider && (
        <div className="field">
          <FieldLabel
            help={
              <>
                Declared keys the agent emits via the injected <code>set_output</code> MCP tool. Reference downstream as{' '}
                <code>{'{{'}{selfId || '<node>'}.&lt;name&gt;{'}}'}</code>.
              </>
            }
          >
            Outputs
          </FieldLabel>
          <AgentOutputsEditor config={config} onPatch={onPatch} />
        </div>
      )}
    </>
  );
}

function isJsonSchema(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function formatSchema(schema: Record<string, unknown> | undefined): string {
  return JSON.stringify(schema ?? {}, null, 2);
}

function StructuredOutputForm({
  config,
  providers,
  refs,
  templateRefs,
  selfId,
  onPatch,
}: {
  config: StructuredOutputConfig;
  providers: ProviderInfo[];
  refs: string[];
  templateRefs: readonly TemplateRef[];
  selfId: string;
  onPatch: (next: StructuredOutputConfig) => void;
}) {
  const httpProviders = providers.filter((provider) => provider.transport === 'http');
  const currentProvider = config.providerId ?? '';
  const providerOptions = httpProviders.map((provider) => ({ value: provider.id, label: provider.label }));
  const providerValue = providerOptions.some((option) => option.value === currentProvider)
    ? currentProvider
    : '';
  const [profiles, setProfiles] = useState<Array<{ id: string; label?: string }>>([]);
  const [profilesError, setProfilesError] = useState<string | null>(null);

  useEffect(() => {
    if (!providerValue) {
      setProfiles([]);
      setProfilesError(null);
      return;
    }
    let cancelled = false;
    setProfiles([]);
    setProfilesError(null);
    fetch(`/api/providers/${encodeURIComponent(providerValue)}/profiles`)
      .then(async (response) => {
        const body = await response.json() as { profiles?: Array<{ id?: unknown; label?: unknown }>; error?: string };
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        return Array.isArray(body.profiles)
          ? body.profiles.filter((profile): profile is { id: string; label?: string } =>
              typeof profile?.id === 'string' && profile.id.length > 0,
            )
          : [];
      })
      .then((next) => {
        if (!cancelled) setProfiles(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setProfilesError(err instanceof Error ? err.message : 'failed to load models');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [providerValue]);

  const [prompt, setPrompt] = useDebouncedString(config.prompt ?? '', (next) =>
    onPatch({ ...config, prompt: next }),
  );
  const [schemaText, setSchemaText] = useState(() => formatSchema(config.schema));
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const schemaTextRef = useRef(schemaText);
  useEffect(() => {
    const next = formatSchema(config.schema);
    if (next !== schemaTextRef.current) {
      schemaTextRef.current = next;
      setSchemaText(next);
      setSchemaError(null);
    }
  }, [config.schema]);

  const commitSchema = (next: string) => {
    schemaTextRef.current = next;
    setSchemaText(next);
    try {
      const parsed: unknown = JSON.parse(next);
      if (!isJsonSchema(parsed)) throw new Error('JSON Schema must be an object');
      setSchemaError(null);
      onPatch({ ...config, schema: parsed });
    } catch (err) {
      setSchemaError(err instanceof Error ? err.message : 'invalid JSON Schema');
    }
  };

  const onImportSchema = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!isJsonSchema(parsed)) throw new Error('JSON Schema must be an object');
      commitSchema(JSON.stringify(parsed, null, 2));
    } catch (err) {
      setSchemaError(err instanceof Error ? err.message : 'invalid JSON Schema file');
    }
  };

  const timeoutMs = config.timeoutMs ?? 30 * 60 * 1000;
  const [timeoutUnit, setTimeoutUnit] = useState<TimeoutUnit>(() =>
    pickInitialTimeoutUnit(timeoutMs),
  );
  const timeoutDisplay = Number((timeoutMs / TIMEOUT_UNIT_MS[timeoutUnit]).toFixed(2));
  const onTimeoutChange = (event: ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value);
    if (Number.isFinite(value) && value > 0) {
      onPatch({ ...config, timeoutMs: Math.max(1000, Math.round(value * TIMEOUT_UNIT_MS[timeoutUnit])) });
    }
  };

  const profileOptions = [
    { value: '', label: 'Provider default' },
    ...profiles.map((profile) => ({ value: profile.id, label: profile.label ?? profile.id })),
  ];
  const profileValue = profileOptions.some((option) => option.value === (config.profile ?? ''))
    ? config.profile ?? ''
    : '';

  return (
    <>
      <div className="field">
        <FieldLabel required>Provider</FieldLabel>
        {providerOptions.length > 0 ? (
          <SelectMenu
            ariaLabel="Provider"
            value={providerValue}
            options={providerOptions}
            onChange={(providerId) => onPatch({ ...config, providerId, profile: undefined })}
          />
        ) : (
          <p className="field-hint" role="alert">No OpenAI-compatible providers are configured. Use “configure OpenAI providers” in the palette, or add an HTTP manifest.</p>
        )}
        {currentProvider && !httpProviders.some((provider) => provider.id === currentProvider) ? (
          <p className="field-hint" role="alert">
            The saved provider is unavailable or does not support OpenAI-compatible structured output. Choose an HTTP provider.
          </p>
        ) : null}
      </div>

      <div className="field">
        <FieldLabel help="Leave blank to use the provider's configured default model.">Model</FieldLabel>
        {profiles.length > 0 ? (
          <SelectMenu
            ariaLabel="Model"
            value={profileValue}
            options={profileOptions}
            onChange={(profile) => onPatch({ ...config, profile: profile || undefined })}
          />
        ) : (
          <HeroInput
            variant="secondary"
            aria-label="Model"
            type="text"
            value={config.profile ?? ''}
            onChange={(event) => onPatch({ ...config, profile: event.target.value.trim() || undefined })}
            placeholder="provider default"
          />
        )}
        {profilesError ? <p className="field-hint">Model discovery unavailable: {profilesError}</p> : null}
      </div>

      <div className="field">
        <FieldLabel required>Prompt</FieldLabel>
        <TemplateField
          multiline
          rows={5}
          ariaLabel="Prompt"
          value={prompt}
          onChange={setPrompt}
          selfId={selfId}
          refs={templateRefs}
          fieldPath="prompt"
          required
        />
        <RefChips refs={refs} />
      </div>

      <div className="field">
        <FieldLabel required>JSON Schema</FieldLabel>
        <HeroTextArea
          variant="secondary"
          aria-label="JSON Schema"
          value={schemaText}
          onChange={(event) => commitSchema(event.target.value)}
          rows={8}
        />
        {schemaError ? <p className="field-hint" role="alert">{schemaError}</p> : null}
        <label className="btn btn-ghost" style={{ display: 'inline-flex', marginTop: 8 }}>
          Import JSON Schema
          <input
            aria-label="Import JSON Schema"
            type="file"
            accept="application/json,.json"
            onChange={onImportSchema}
            style={{ display: 'none' }}
          />
        </label>
      </div>

      <div className="field">
        <FieldLabel required>Iteration timeout</FieldLabel>
        <div className="field-row">
          <HeroInput
            variant="secondary"
            aria-label="Iteration timeout"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            required
            value={timeoutDisplay}
            onChange={onTimeoutChange}
            className="no-spin"
          />
          <div className="seg-tight" role="group" aria-label="Iteration timeout unit">
            {TIMEOUT_UNITS.map((unit) => (
              <button
                key={unit}
                type="button"
                data-active={timeoutUnit === unit}
                aria-pressed={timeoutUnit === unit}
                onClick={() => setTimeoutUnit(unit)}
              >
                {unit}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function ConditionForm({
  config,
  refs,
  templateRefs,
  selfId,
  onPatch,
}: {
  config: ConditionConfig;
  refs: string[];
  templateRefs: readonly TemplateRef[];
  selfId: string;
  onPatch: (next: ConditionConfig) => void;
}) {
  const kind: ConditionKind = config.kind ?? 'sentinel';

  const [against, setAgainst] = useDebouncedString(
    config.against ?? '',
    (next) => onPatch({ ...config, against: next }),
  );
  const [pattern, setPattern] = useDebouncedString(
    config.sentinel?.pattern ?? '',
    (next) =>
      onPatch({
        ...config,
        sentinel: { ...(config.sentinel ?? { isRegex: false }), pattern: next },
      }),
  );
  const [cmd, setCmd] = useDebouncedString(config.command?.cmd ?? '', (next) =>
    onPatch({ ...config, command: { cmd: next } }),
  );
  const [rubric, setRubric] = useDebouncedString(
    config.judge?.rubric ?? '',
    (next) =>
      onPatch({
        ...config,
        judge: { ...(config.judge ?? {}), rubric: next },
      }),
  );
  const [model, setModel] = useDebouncedString(config.judge?.model ?? '', (next) =>
    onPatch({
      ...config,
      judge: { ...(config.judge ?? { rubric: '' }), model: next || undefined },
    }),
  );

  return (
    <>
      <Segmented<ConditionKind>
        label="Kind"
        value={kind}
        options={[
          { value: 'sentinel', label: 'Sentinel' },
          { value: 'command', label: 'Command' },
          { value: 'judge', label: 'Judge' },
        ]}
        onChange={(next) => onPatch({ ...config, kind: next })}
      />

      {kind === 'sentinel' && (
        <>
          <div className="field">
            <span className="field-label">Pattern</span>
            <HeroInput
        variant="secondary"
              aria-label="Pattern"
              type="text"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
            />
          </div>
          <Checkbox
            className="checkbox-row"
            label="Treat as regex"
            checked={config.sentinel?.isRegex ?? false}
            onChange={(next) =>
              onPatch({
                ...config,
                sentinel: {
                  pattern: config.sentinel?.pattern ?? '',
                  isRegex: next,
                  caseInsensitive: config.sentinel?.caseInsensitive,
                },
              })
            }
          />
          <Checkbox
            className="checkbox-row"
            label="Case-insensitive"
            checked={config.sentinel?.caseInsensitive ?? false}
            onChange={(next) =>
              onPatch({
                ...config,
                sentinel: {
                  pattern: config.sentinel?.pattern ?? '',
                  isRegex: config.sentinel?.isRegex ?? false,
                  caseInsensitive: next,
                },
              })
            }
          />
        </>
      )}

      {kind === 'command' && (
        <div className="field">
          <span className="field-label">Command</span>
          <HeroInput
        variant="secondary"
            aria-label="Command"
            type="text"
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
          />
        </div>
      )}

      {kind === 'judge' && (
        <>
          <div className="field">
            <span className="field-label">Rubric</span>
            <HeroTextArea
        variant="secondary"
              aria-label="Rubric"
              rows={4}
              value={rubric}
              onChange={(e) => setRubric(e.target.value)}
            />
          </div>
          <div className="field">
            <FieldLabel help="Leave blank to use the Claude Code default.">
              Model
            </FieldLabel>
            <HeroInput
        variant="secondary"
              aria-label="Model"
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </div>
        </>
      )}

      <div className="field">
        <span className="field-label">Against</span>
        <TemplateField
          ariaLabel="Against"
          value={against}
          onChange={setAgainst}
          selfId={selfId}
          refs={templateRefs}
          fieldPath="against"
          placeholder="{{<previous-node>.stdout}}"
        />
        <RefChips refs={refs} />
      </div>
    </>
  );
}

function LoopForm({
  config,
  onPatch,
}: {
  config: LoopConfig;
  onPatch: (next: LoopConfig) => void;
}) {
  const onMaxChange = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (raw === '') return;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(100, Math.max(1, Math.floor(parsed)));
    onPatch({ ...config, maxIterations: clamped });
  };

  const infinite = config.infinite === true;

  return (
    <>
      <Segmented<'bounded' | 'infinite'>
        label="Iteration limit"
        value={infinite ? 'infinite' : 'bounded'}
        options={[
          { value: 'bounded', label: 'Bounded' },
          { value: 'infinite', label: 'Infinite ∞' },
        ]}
        onChange={(next) => onPatch({ ...config, infinite: next === 'infinite' })}
      />

      {!infinite && (
        <div className="field">
          <span className="field-label">Max iterations</span>
          <HeroInput
        variant="secondary"
            aria-label="Max iterations"
            type="number"
            min={1}
            max={100}
            value={config.maxIterations ?? 5}
            onChange={onMaxChange}
          />
        </div>
      )}

      <Segmented<LoopConfig['mode']>
        label="Mode"
        value={config.mode ?? 'while-not-met'}
        options={[
          { value: 'while-not-met', label: 'While not met' },
          { value: 'unbounded', label: 'Unbounded' },
        ]}
        onChange={(next) => onPatch({ ...config, mode: next })}
      />
    </>
  );
}

function BranchForm({
  config,
  refs,
  templateRefs,
  selfId,
  onPatch,
}: {
  config: BranchConfig;
  refs: string[];
  templateRefs: readonly TemplateRef[];
  selfId: string;
  onPatch: (next: BranchConfig) => void;
}) {
  const [lhs, setLhs] = useDebouncedString(config.lhs ?? '', (next) =>
    onPatch({ ...config, lhs: next }),
  );
  const [rhs, setRhs] = useDebouncedString(config.rhs ?? '', (next) =>
    onPatch({ ...config, rhs: next }),
  );
  const op: BranchOp = config.op ?? '==';

  return (
    <>
      <div className="field">
        <span className="field-label">Left</span>
        <TemplateField
          ariaLabel="Left"
          value={lhs}
          onChange={setLhs}
          selfId={selfId}
          refs={templateRefs}
          fieldPath="lhs"
          placeholder="{{claude-1.stdout}}"
        />
        <RefChips refs={refs} />
      </div>

      <Segmented<BranchOp>
        label="Operator"
        value={op}
        options={[
          { value: '==', label: '==' },
          { value: '!=', label: '!=' },
          { value: 'contains', label: 'contains' },
          { value: 'matches', label: 'matches' },
        ]}
        onChange={(next) => onPatch({ ...config, op: next })}
      />

      <div className="field">
        <span className="field-label">Right</span>
        <TemplateField
          ariaLabel="Right"
          value={rhs}
          onChange={setRhs}
          selfId={selfId}
          refs={templateRefs}
          fieldPath="rhs"
          placeholder={op === 'matches' ? '^DONE' : 'DONE'}
        />
        <RefChips refs={refs} />
      </div>

      <Checkbox
        className="checkbox-row"
        label="Case-insensitive"
        checked={config.caseInsensitive ?? false}
        onChange={(next) => onPatch({ ...config, caseInsensitive: next })}
      />
    </>
  );
}

/* ─── multi-agent forms (U4) ───────────────────────────────── */

function ParallelForm({
  config,
  onPatch,
}: {
  config: ParallelConfig;
  onPatch: (next: ParallelConfig) => void;
}) {
  const mode: ParallelMode = config.mode ?? 'wait-all';
  const onError: ParallelOnError = config.onError ?? 'fail-fast';

  // QuorumN's wire format is `number | undefined`. We carry a debounced string
  // mirror so the user can clear / edit without us snapping their cursor.
  const [quorumStr, setQuorumStr] = useDebouncedString(
    config.quorumN != null ? String(config.quorumN) : '',
    (next) => {
      const trimmed = next.trim();
      if (trimmed === '') {
        onPatch({ ...config, quorumN: undefined });
        return;
      }
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed) && parsed >= 1) {
        onPatch({ ...config, quorumN: Math.floor(parsed) });
      }
    },
  );

  return (
    <>
      <Segmented<ParallelMode>
        label="Mode"
        value={mode}
        options={[
          { value: 'wait-all', label: 'Wait all' },
          { value: 'race', label: 'Race' },
          { value: 'quorum', label: 'Quorum' },
        ]}
        onChange={(next) => onPatch({ ...config, mode: next })}
      />

      {mode === 'quorum' && (
        <div className="field">
          <FieldLabel help="Must be between 1 and the number of children.">
            Quorum N
          </FieldLabel>
          <HeroInput
        variant="secondary"
            aria-label="Quorum N"
            type="number"
            min={1}
            value={quorumStr}
            onChange={(e) => setQuorumStr(e.target.value)}
          />
        </div>
      )}

      <Segmented<ParallelOnError>
        label="On error"
        value={onError}
        options={[
          { value: 'fail-fast', label: 'Fail-fast' },
          { value: 'best-effort', label: 'Best-effort' },
        ]}
        onChange={(next) => onPatch({ ...config, onError: next })}
      />
    </>
  );
}

/* ── shared dynamic key/value row helpers ─────────────────────
 * SubworkflowForm needs two near-identical "name → templated string" grids
 * (inputs and outputs). They differ only in the label/description on the
 * value field. We keep a local rowId so React can identify rows across
 * renames without re-mounting their inputs (which would lose focus). */
interface KvRowData {
  rowId: string;
  name: string;
  value: string;
}

function recordToRows(
  rec: Record<string, string> | undefined,
): KvRowData[] {
  if (!rec) return [];
  return Object.entries(rec).map(([name, value], i) => ({
    rowId: `r-${i}-${name}`,
    name,
    value,
  }));
}

/** Drop empty-name rows on commit and let later duplicates win — matches the
 * normal "last write wins" Record semantics so renames behave predictably. */
function rowsToRecord(rows: KvRowData[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const key = row.name.trim();
    if (!key) continue;
    out[key] = row.value;
  }
  return out;
}

function nextRowId(): string {
  // Date.now is fine — rows are appended one at a time on user click.
  return `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

interface KvRowsEditorProps {
  rows: KvRowData[];
  onChange: (next: KvRowData[]) => void;
  nameLabel: string;
  valueLabel: string;
  valuePlaceholder?: string;
  valueDescription?: string;
  addLabel: string;
  /** When set, the value cell uses TemplateField with autocomplete + lint
   * driven by these args. Leave undefined for plain text values (e.g.
   * subworkflow output paths). */
  template?: { selfId: string; refs: readonly TemplateRef[]; fieldPath: (name: string) => string };
}

/* Per-row component so each cell carries its own debounced text buffer —
 * keystrokes don't slam the workflow store / undo history. */
function KvRow({
  row,
  index,
  isLast,
  nameLabel,
  valueLabel,
  valuePlaceholder,
  valueDescription,
  template,
  onCommit,
  onRemove,
}: {
  row: KvRowData;
  index: number;
  isLast: boolean;
  nameLabel: string;
  valueLabel: string;
  valuePlaceholder?: string;
  valueDescription?: string;
  template?: KvRowsEditorProps['template'];
  onCommit: (patch: Partial<KvRowData>) => void;
  onRemove: () => void;
}) {
  const [name, setName] = useDebouncedString(row.name, (next) =>
    onCommit({ name: next }),
  );
  const [value, setValue] = useDebouncedString(row.value, (next) =>
    onCommit({ value: next }),
  );
  return (
    <div className="kv-row">
      <HeroInput
        variant="secondary"
        aria-label={`${nameLabel} ${index}`}
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={nameLabel}
      />
      <div className="kv-row-value">
        {template ? (
          <TemplateField
            ariaLabel={`${valueLabel} ${index}`}
            value={value}
            onChange={setValue}
            selfId={template.selfId}
            refs={template.refs}
            fieldPath={template.fieldPath(name)}
            placeholder={valuePlaceholder}
          />
        ) : (
          <HeroInput
        variant="secondary"
            aria-label={`${valueLabel} ${index}`}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={valuePlaceholder}
          />
        )}
        {isLast && valueDescription ? (
          <span className="field-hint">{valueDescription}</span>
        ) : null}
      </div>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={onRemove}
        aria-label={`remove ${nameLabel} ${index}`}
      >
        ✕
      </button>
    </div>
  );
}

function KvRowsEditor({
  rows,
  onChange,
  nameLabel,
  valueLabel,
  valuePlaceholder,
  valueDescription,
  addLabel,
  template,
}: KvRowsEditorProps) {
  const updateRow = (rowId: string, patch: Partial<KvRowData>) => {
    onChange(
      rows.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)),
    );
  };
  const removeRow = (rowId: string) => {
    onChange(rows.filter((r) => r.rowId !== rowId));
  };
  const addRow = () => {
    onChange([...rows, { rowId: nextRowId(), name: '', value: '' }]);
  };

  return (
    <div className="kv-rows">
      {rows.map((row, i) => (
        <KvRow
          key={row.rowId}
          row={row}
          index={i}
          isLast={i === rows.length - 1}
          nameLabel={nameLabel}
          valueLabel={valueLabel}
          valuePlaceholder={valuePlaceholder}
          valueDescription={valueDescription}
          template={template}
          onCommit={(patch) => updateRow(row.rowId, patch)}
          onRemove={() => removeRow(row.rowId)}
        />
      ))}
      <button
        type="button"
        className="btn btn-ghost kv-add"
        onClick={addRow}
      >
        + {addLabel}
      </button>
    </div>
  );
}

function SubworkflowForm({
  config,
  templateRefs,
  selfId,
  onPatch,
}: {
  config: SubworkflowConfig;
  templateRefs: readonly TemplateRef[];
  selfId: string;
  onPatch: (next: SubworkflowConfig) => void;
}) {
  const currentWorkflowId = useWorkflowStore(
    (s) => s.currentWorkflow?.id ?? null,
  );

  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/workflows')
      .then((r) => r.json())
      .then((data: { workflows?: WorkflowSummary[] }) => {
        if (!cancelled && Array.isArray(data.workflows)) {
          setWorkflows(data.workflows);
        }
      })
      .catch((err: unknown) => {
        console.warn('[subworkflow-form] failed to load workflows:', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Local rows carry stable rowIds so cell text edits don't re-key the entry
  // on every keystroke. We re-sync from upstream when the parent-provided
  // record reference changes (only happens on node-switch / undo / external
  // mutation — our own commits assign the ref ourselves so we skip).
  const [inputRows, setInputRows] = useState<KvRowData[]>(() =>
    recordToRows(config.inputs),
  );
  const [outputRows, setOutputRows] = useState<KvRowData[]>(() =>
    recordToRows(config.outputs),
  );
  const lastInputs = useRef(config.inputs);
  const lastOutputs = useRef(config.outputs);
  useEffect(() => {
    if (config.inputs !== lastInputs.current) {
      lastInputs.current = config.inputs;
      setInputRows(recordToRows(config.inputs));
    }
  }, [config.inputs]);
  useEffect(() => {
    if (config.outputs !== lastOutputs.current) {
      lastOutputs.current = config.outputs;
      setOutputRows(recordToRows(config.outputs));
    }
  }, [config.outputs]);

  const commitInputs = (rows: KvRowData[]) => {
    setInputRows(rows);
    const rec = rowsToRecord(rows);
    lastInputs.current = rec;
    onPatch({ ...config, inputs: rec });
  };
  const commitOutputs = (rows: KvRowData[]) => {
    setOutputRows(rows);
    const rec = rowsToRecord(rows);
    lastOutputs.current = rec;
    onPatch({ ...config, outputs: rec });
  };

  // Hide self-reference; cycle detection beyond direct self lives in the
  // engine. If currentWorkflowId is null (e.g. unsaved), just show all.
  const choices = workflows.filter((w) => w.id !== currentWorkflowId);

  return (
    <>
      <div className="field">
        <span className="field-label">Workflow</span>
        <WorkflowPicker
          value={config.workflowId ?? ''}
          choices={choices}
          onChange={(next) => onPatch({ ...config, workflowId: next })}
        />
      </div>

      <div className="field">
        <span className="field-label">Inputs</span>
        <KvRowsEditor
          rows={inputRows}
          onChange={commitInputs}
          nameLabel="name"
          valueLabel="value template"
          valuePlaceholder="{{claude-1.stdout}}"
          addLabel="add input"
          template={{
            selfId,
            refs: templateRefs,
            fieldPath: (name) => `inputs.${name || '?'}`,
          }}
        />
      </div>

      <div className="field">
        <FieldLabel help="Maps each exposed output name to a dotted path in the child workflow's terminal scope, for example agent-1.stdout.">
          Outputs
        </FieldLabel>
        <KvRowsEditor
          rows={outputRows}
          onChange={commitOutputs}
          nameLabel="name"
          valueLabel="child path"
          valuePlaceholder="agent-1.stdout"
          addLabel="add output"
        />
      </div>
    </>
  );
}

/* ─── manual / human-acceptance form ───────────────────────── */

const MANUAL_DECISION_DEFAULT_LABELS: Record<ManualDecisionKey, string> = {
  accepted: 'Accept',
  needs_changes: 'Needs changes',
  rejected: 'Reject',
};

function ManualForm({
  config,
  refs,
  templateRefs,
  selfId,
  onPatch,
}: {
  config: ManualConfig;
  refs: string[];
  templateRefs: readonly TemplateRef[];
  selfId: string;
  onPatch: (next: ManualConfig) => void;
}) {
  const [brief, setBrief] = useDebouncedString(
    config.brief ?? '',
    (next) => onPatch({ ...config, brief: next }),
  );
  const [reviewerHint, setReviewerHint] = useDebouncedString(
    config.reviewerHint ?? '',
    (next) =>
      onPatch({
        ...config,
        reviewerHint: next.trim() ? next : undefined,
      }),
  );

  // Decisions: at least one entry is required at save-time. Render every
  // conventional key as a row with an enable toggle so the author opts in
  // by checkbox rather than typing key strings. The 'rejected' branch is
  // the default fallback for timeouts; the form encourages keeping it on
  // by labelling it the "timeout fallback" when timeoutMs > 0.
  const declared = config.decisions ?? [];
  const byKey = new Map(declared.map((d) => [d.key, d]));
  const hasAny = declared.length > 0;

  const timeoutMsCurrent = config.timeoutMs ?? 0;
  const toggleDecision = (key: ManualDecisionKey) => {
    if (byKey.has(key)) {
      // Don't allow removing the last decision — the executor would have
      // nothing to route to. Also don't allow removing `rejected` while a
      // timeout is configured: the timeout path fabricates a `rejected`
      // decision and needs that handle present (also enforced server-side
      // in workflow-store validation). The checkbox is visually disabled
      // when either guard would apply.
      if (declared.length <= 1) return;
      if (key === 'rejected' && timeoutMsCurrent > 0) return;
      const next = declared.filter((d) => d.key !== key);
      onPatch({ ...config, decisions: next });
    } else {
      const next = [...declared, { key }];
      onPatch({ ...config, decisions: next });
    }
  };

  const patchDecision = (key: ManualDecisionKey, patch: Partial<ManualDecisionDecl>) => {
    const next = declared.map((d) => (d.key === key ? { ...d, ...patch } : d));
    onPatch({ ...config, decisions: next });
  };

  const timeoutMsRaw = config.timeoutMs ?? 0;
  const [timeoutUnit, setTimeoutUnit] = useState<TimeoutUnit>(() =>
    pickInitialTimeoutUnit(timeoutMsRaw > 0 ? timeoutMsRaw : 60_000),
  );
  const timeoutDisplay =
    timeoutMsRaw > 0
      ? Number((timeoutMsRaw / TIMEOUT_UNIT_MS[timeoutUnit]).toFixed(2))
      : 0;
  const onTimeoutChange = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (raw === '') {
      onPatch({ ...config, timeoutMs: undefined });
      return;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return;
    if (value === 0) {
      onPatch({ ...config, timeoutMs: undefined });
      return;
    }
    const ms = Math.max(1000, Math.round(value * TIMEOUT_UNIT_MS[timeoutUnit]));
    // Auto-add the `rejected` decision when setting a timeout, since the
    // timeout path fabricates a rejected decision and the workflow
    // validator requires that handle to exist whenever timeoutMs > 0.
    // Saves the user a save-time error round-trip.
    const next: ManualConfig = { ...config, timeoutMs: ms };
    const list = next.decisions ?? declared;
    if (!list.some((d) => d.key === 'rejected')) {
      next.decisions = [...list, { key: 'rejected' }];
    }
    onPatch(next);
  };

  return (
    <>
      <div className="field">
        <FieldLabel help="Shown to the reviewer above the decision buttons. Templated against upstream outputs.">
          Acceptance brief
        </FieldLabel>
        <TemplateField
          multiline
          rows={5}
          ariaLabel="Acceptance brief"
          value={brief}
          onChange={setBrief}
          selfId={selfId}
          refs={templateRefs}
          fieldPath="brief"
          placeholder="Summarize what to review, e.g. Approve PR {{agent-1.stdout}}?"
        />
        <RefChips refs={refs} />
      </div>

      <div className="field">
        <FieldLabel help="Free-form operator guidance — Infinite Loop is single-tenant so this is descriptive, not an identity check.">
          Reviewer hint
        </FieldLabel>
        <TemplateField
          ariaLabel="Reviewer hint"
          value={reviewerHint}
          onChange={setReviewerHint}
          selfId={selfId}
          refs={templateRefs}
          fieldPath="reviewerHint"
          placeholder="who is expected to decide (e.g. on-call SRE)"
        />
      </div>

      <div className="field">
        <FieldLabel help="Each enabled decision becomes an outgoing edge on the canvas (handles match the key).">
          Decisions
        </FieldLabel>
        <div className="kv-rows">
          {MANUAL_DECISION_KEYS.map((key) => {
            const decl = byKey.get(key);
            const enabled = decl !== undefined;
            const onlyOne = enabled && declared.length <= 1;
            const requiredByTimeout =
              key === 'rejected' && timeoutMsCurrent > 0 && enabled;
            const fallback = MANUAL_DECISION_DEFAULT_LABELS[key];
            return (
              <ManualDecisionRow
                key={key}
                decisionKey={key}
                enabled={enabled}
                onlyOne={onlyOne || requiredByTimeout}
                label={decl?.label ?? ''}
                description={decl?.description ?? ''}
                fallback={fallback}
                isTimeoutFallback={
                  key === 'rejected' && timeoutMsCurrent > 0
                }
                onToggle={() => toggleDecision(key)}
                onPatch={(patch) => patchDecision(key, patch)}
              />
            );
          })}
        </div>
        {!hasAny && (
          <span className="field-hint field-hint--error">
            at least one decision must be enabled
          </span>
        )}
      </div>

      <div className="field">
        <FieldLabel help={<>0 (or blank) waits indefinitely. When set, an elapsed gate routes through <code>rejected</code> with <code>timedOut: true</code> in its scope outputs.</>}>
          Timeout (optional)
        </FieldLabel>
        <div className="field-row">
          <HeroInput
        variant="secondary"
            aria-label="Timeout"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={timeoutDisplay}
            onChange={onTimeoutChange}
            className="no-spin"
          />
          <div className="seg-tight" role="group" aria-label="Timeout unit">
            {TIMEOUT_UNITS.map((u) => (
              <button
                key={u}
                type="button"
                data-active={timeoutUnit === u}
                aria-pressed={timeoutUnit === u}
                onClick={() => setTimeoutUnit(u)}
              >
                {u}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function ManualDecisionRow({
  decisionKey,
  enabled,
  onlyOne,
  label,
  description,
  fallback,
  isTimeoutFallback,
  onToggle,
  onPatch,
}: {
  decisionKey: ManualDecisionKey;
  enabled: boolean;
  onlyOne: boolean;
  label: string;
  description: string;
  fallback: string;
  isTimeoutFallback: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<ManualDecisionDecl>) => void;
}) {
  const [labelBuf, setLabelBuf] = useDebouncedString(label, (next) =>
    onPatch({ label: next.trim() ? next : undefined }),
  );
  const [descBuf, setDescBuf] = useDebouncedString(description, (next) =>
    onPatch({ description: next.trim() ? next : undefined }),
  );
  return (
    <div className="kv-row" aria-label={`decision ${decisionKey}`}>
      <Checkbox
        className="checkbox-row"
        label={
          <>
            <code>{decisionKey}</code>
            {isTimeoutFallback && (
              <span className="field-hint">(timeout fallback)</span>
            )}
          </>
        }
        checked={enabled}
        disabled={onlyOne}
        onChange={onToggle}
        ariaLabel={`enable decision ${decisionKey}`}
      />
      <div className="kv-row-value">
        <HeroInput
        variant="secondary"
          aria-label={`label for ${decisionKey}`}
          type="text"
          value={labelBuf}
          onChange={(e) => setLabelBuf(e.target.value)}
          placeholder={fallback}
          disabled={!enabled}
        />
        <HeroInput
        variant="secondary"
          aria-label={`description for ${decisionKey}`}
          type="text"
          value={descBuf}
          onChange={(e) => setDescBuf(e.target.value)}
          placeholder="optional one-liner shown to the reviewer"
          disabled={!enabled}
        />
      </div>
    </div>
  );
}

/* ─── script form ──────────────────────────────────────────── */

/** Per-output-name row. Local debounced buffer so cell edits don't slam
 * the store on every keystroke. */
function OutputNameRow({
  index,
  value,
  onCommit,
  onRemove,
}: {
  index: number;
  value: string;
  onCommit: (next: string) => void;
  onRemove: () => void;
}) {
  const [v, setV] = useDebouncedString(value, onCommit);
  return (
    <div className="script-output-row">
      <HeroInput
        variant="secondary"
        aria-label={`agent output name ${index}`}
        type="text"
        value={v}
        placeholder="output name"
        onChange={(e) => setV(e.target.value)}
      />
      <button
        type="button"
        className="btn btn-ghost"
        onClick={onRemove}
        aria-label={`remove agent output ${index}`}
      >
        ✕
      </button>
    </div>
  );
}

function ScriptForm({
  config,
  refs,
  templateRefs,
  selfId,
  onPatch,
}: {
  config: ScriptConfig;
  refs: string[];
  templateRefs: readonly TemplateRef[];
  selfId: string;
  onPatch: (next: ScriptConfig) => void;
}) {
  const language: ScriptLanguage = config.language ?? 'ts';
  const [code, setCode] = useDebouncedString(config.code ?? '', (next) =>
    onPatch({ ...config, code: next }),
  );
  const [cwd, setCwd] = useDebouncedString(config.cwd ?? '', (next) =>
    onPatch({ ...config, cwd: next || undefined }),
  );

  // Inputs are a name → templated-value Record; UI mirrors subworkflow.inputs.
  // Local KvRow state carries stable rowIds so cell edits don't re-key the
  // entry on every keystroke. Re-sync from upstream when the upstream
  // reference changes (node switch / undo).
  const [inputRows, setInputRows] = useState<KvRowData[]>(() =>
    recordToRows(config.inputs),
  );
  const lastInputs = useRef(config.inputs);
  useEffect(() => {
    if (config.inputs !== lastInputs.current) {
      lastInputs.current = config.inputs;
      setInputRows(recordToRows(config.inputs));
    }
  }, [config.inputs]);
  const commitInputs = (rows: KvRowData[]) => {
    setInputRows(rows);
    const rec = rowsToRecord(rows);
    lastInputs.current = rec;
    onPatch({ ...config, inputs: rec });
  };

  // Outputs are an ordered list of names. The user implements `run(...)`
  // returning an object; each declared name is pulled into scope.
  const outputs = Array.isArray(config.outputs) ? config.outputs : [];
  const updateOutput = (idx: number, next: string) => {
    const arr = outputs.slice();
    arr[idx] = next;
    onPatch({ ...config, outputs: arr });
  };
  const removeOutput = (idx: number) => {
    const arr = outputs.slice();
    arr.splice(idx, 1);
    onPatch({ ...config, outputs: arr });
  };
  const addOutput = () => {
    onPatch({ ...config, outputs: [...outputs, ''] });
  };

  const timeoutMsRaw = config.timeoutMs ?? 60_000;
  const [timeoutUnit, setTimeoutUnit] = useState<TimeoutUnit>(() =>
    pickInitialTimeoutUnit(timeoutMsRaw),
  );
  const timeoutDisplay = Number(
    (timeoutMsRaw / TIMEOUT_UNIT_MS[timeoutUnit]).toFixed(2),
  );
  const onTimeoutChange = (e: ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (raw === '') return;
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0) {
      const ms = Math.max(1000, Math.round(value * TIMEOUT_UNIT_MS[timeoutUnit]));
      onPatch({ ...config, timeoutMs: ms });
    }
  };

  // Show the user the function signature their `run(...)` should match,
  // derived from the input names. Updates as they rename inputs.
  const argList = Object.keys(config.inputs ?? {}).join(', ') || '/* no inputs */';
  const sigHint =
    language === 'ts'
      ? `function run(${argList}) { return { ${(outputs[0] ?? 'output1')}: "…" } }`
      : `def run(${argList}):\n    return { "${(outputs[0] ?? 'output1')}": "…" }`;

  return (
    <>
      <Segmented<ScriptLanguage>
        label="Language"
        value={language}
        options={[
          { value: 'ts', label: 'TypeScript (Bun)' },
          { value: 'py', label: 'Python (python3)' },
        ]}
        onChange={(next) => onPatch({ ...config, language: next })}
      />

      <div className="field">
        <span className="field-label">Inputs</span>
        <KvRowsEditor
          rows={inputRows}
          onChange={commitInputs}
          nameLabel="arg name"
          valueLabel="value template"
          valuePlaceholder="{{claude-1.stdout}}"
          addLabel="add input"
          template={{
            selfId,
            refs: templateRefs,
            fieldPath: (name) => `inputs.${name || '?'}`,
          }}
        />
        <RefChips refs={refs} />
      </div>

      <div className="field">
        <FieldLabel help="The function returns an object; each declared name is copied into this node’s scope under the same key.">
          Outputs
        </FieldLabel>
        <div className="script-output-list">
          {outputs.map((name, i) => (
            <OutputNameRow
              key={i}
              index={i}
              value={name}
              onCommit={(next) => updateOutput(i, next)}
              onRemove={() => removeOutput(i)}
            />
          ))}
          <button
            type="button"
            className="btn btn-ghost kv-add"
            onClick={addOutput}
          >
            + add output
          </button>
        </div>
      </div>

      <div className="field">
        <FieldLabel
          help={
            <>
              <code>{sigHint}</code>
              <br />
              Not templated. Define <code>run(…)</code> taking the inputs as positional args; return an object with the declared output keys.
            </>
          }
        >
          Code
        </FieldLabel>
        <HeroTextArea
        variant="secondary"
          aria-label="Code"
          rows={12}
          spellCheck={false}
          className="code-textarea"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </div>

      <CwdField value={cwd} onChange={setCwd} />

      <div className="field">
        <span className="field-label">Timeout</span>
        <div className="field-row">
          <HeroInput
        variant="secondary"
            aria-label="Timeout"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={timeoutDisplay}
            onChange={onTimeoutChange}
            className="no-spin"
          />
          <div className="seg-tight" role="group" aria-label="Timeout unit">
            {TIMEOUT_UNITS.map((u) => (
              <button
                key={u}
                type="button"
                data-active={timeoutUnit === u}
                aria-pressed={timeoutUnit === u}
                onClick={() => setTimeoutUnit(u)}
              >
                {u}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

/* ─── globals panel ────────────────────────────────────────── */

/** Shown in the right-hand pane when no node is selected. Lets the user
 * define `{{globals.NAME}}` variables that any node in the workflow can
 * reference. Values are literal strings — NOT templated, since globals
 * have no scope to template against. */
function GlobalsPanel({ workflow }: { workflow: Workflow | null }) {
  const setGlobals = useWorkflowStore((s) => s.setGlobals);
  const [rows, setRows] = useState<KvRowData[]>(() =>
    recordToRows(workflow?.globals),
  );
  const lastGlobals = useRef(workflow?.globals);
  useEffect(() => {
    if (workflow?.globals !== lastGlobals.current) {
      lastGlobals.current = workflow?.globals;
      setRows(recordToRows(workflow?.globals));
    }
  }, [workflow?.globals]);

  const commit = (next: KvRowData[]) => {
    setRows(next);
    const rec = rowsToRecord(next);
    lastGlobals.current = rec;
    setGlobals(rec);
  };

  if (!workflow) {
    return (
      <aside aria-label="config panel" className="config-stub">
        <p className="config-empty">
          <span className="config-empty-prompt">›</span> open a workflow to
          configure<span className="crt-cursor" aria-hidden="true" />
        </p>
      </aside>
    );
  }

  return (
    <aside aria-label="config panel" className="config-stub">
      <header className="serif config-stub-section-head">
        workflow · globals
      </header>
      <form className="task-form" onSubmit={(e) => e.preventDefault()}>
        <p className="field-hint field-hint--dim-pad">
          Workflow-level variables available to every node as{' '}
          <code className="inline-mono">
            {'{{globals.NAME}}'}
          </code>
          . Values are literal strings — they aren&apos;t templated.
        </p>
        <KvRowsEditor
          rows={rows}
          onChange={commit}
          nameLabel="name"
          valueLabel="value"
          valuePlaceholder="literal value"
          addLabel="add global"
        />
        <p className="field-hint field-hint--bottom">
          Select a node on the canvas to edit its config.
        </p>
      </form>
      <section className="trg-section">
        <header className="trg-section-head">workflow · triggers</header>
        <TriggersPanel
          workflow={workflow}
          origin={typeof window === 'undefined' ? '' : window.location.origin}
        />
      </section>
    </aside>
  );
}

/* ─── main component ───────────────────────────────────────── */

export default function ConfigPanel() {
  const selectedNodeId = useWorkflowStore((s) => s.selectedNodeId);
  const currentWorkflow = useWorkflowStore((s) => s.currentWorkflow);
  const updateNode = useWorkflowStore((s) => s.updateNode);

  const node = useMemo(
    () =>
      selectedNodeId && currentWorkflow
        ? findWorkflowNode(currentWorkflow.nodes, selectedNodeId)
        : null,
    [selectedNodeId, currentWorkflow],
  );

  // Provider list is needed by AgentForm to decide whether to show the
  // profile/model fields. We fetch it once at the panel level (instead of
  // per-AgentForm-mount) so a rapid provider switch can't race two separate
  // fetches mid-render. /api/providers is in-process cached on the server.
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/providers')
      .then((r) => r.json())
      .then((data: { providers?: ProviderInfo[] }) => {
        if (!cancelled && Array.isArray(data.providers)) {
          setProviders(data.providers);
        }
      })
      .catch((err: unknown) => {
        console.warn('[config-panel] failed to load providers:', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refs = useMemo(
    () => (node ? availableRefs(currentWorkflow, node.id) : []),
    [currentWorkflow, node],
  );

  // Structured ref list for the TemplateField autocomplete dropdown.
  // `refs` (string[]) remains for the lightweight RefChips hint line —
  // both stay in sync because both derive from the workflow + selfId.
  const templateRefs: TemplateRef[] = useMemo(
    () => (node ? availableVariables(currentWorkflow, node.id) : []),
    [currentWorkflow, node],
  );

  if (!node) {
    return <GlobalsPanel workflow={currentWorkflow} />;
  }

  const patchConfig = (nextConfig: WorkflowNode['config']) => {
    updateNode(node.id, { config: nextConfig });
  };

  return (
    <aside aria-label="config panel" className="config-stub">
      <header className="serif config-stub-section-head">
        {node.type === 'agent' ? (
          <ProviderIcon
            providerId={(node.config as AgentConfig).providerId ?? 'claude'}
            size={22}
          />
        ) : null}
        <span>{node.id} · {node.type === 'structured-output' ? 'OpenAI' : node.type}</span>
      </header>

      <form className="task-form" onSubmit={(e) => e.preventDefault()}>
        {/* Display name applies to every node type — overrides the default
         * "START" / "CLAUDE" / etc. title on the canvas card. Empty value
         * (or whitespace) falls back to the type-default. */}
        <DisplayNameField
          key={node.id}
          value={node.label ?? ''}
          fallback={node.type === 'structured-output' ? 'OPENAI' : node.type.toUpperCase()}
          onCommit={(next) =>
            updateNode(node.id, {
              label: next.trim() ? next.trim() : undefined,
            })
          }
        />
        {node.type === 'start' && <StartForm workflow={currentWorkflow} />}
        {node.type === 'end' && (
          <EndForm
            config={node.config as EndConfig}
            onPatch={patchConfig}
          />
        )}
        {node.type === 'agent' && (
          <AgentForm
            config={node.config as AgentConfig}
            refs={refs}
            templateRefs={templateRefs}
            selfId={node.id}
            workflowCwd={currentWorkflow?.cwd}
            providerInfo={
              providers.find(
                (p) => p.id === ((node.config as AgentConfig).providerId ?? 'claude'),
              ) ?? null
            }
            onPatch={patchConfig}
          />
        )}
        {node.type === 'condition' && (
          <ConditionForm
            config={node.config as ConditionConfig}
            refs={refs}
            templateRefs={templateRefs}
            selfId={node.id}
            onPatch={patchConfig}
          />
        )}
        {node.type === 'loop' && (
          <LoopForm
            config={node.config as LoopConfig}
            onPatch={patchConfig}
          />
        )}
        {node.type === 'branch' && (
          <BranchForm
            config={node.config as BranchConfig}
            refs={refs}
            templateRefs={templateRefs}
            selfId={node.id}
            onPatch={patchConfig}
          />
        )}
        {node.type === 'parallel' && (
          <ParallelForm
            config={node.config as ParallelConfig}
            onPatch={patchConfig}
          />
        )}
        {node.type === 'subworkflow' && (
          <SubworkflowForm
            config={node.config as SubworkflowConfig}
            templateRefs={templateRefs}
            selfId={node.id}
            onPatch={patchConfig}
          />
        )}
        {node.type === 'structured-output' && (
          <StructuredOutputForm
            config={node.config as StructuredOutputConfig}
            providers={providers}
            refs={refs}
            templateRefs={templateRefs}
            selfId={node.id}
            onPatch={patchConfig}
          />
        )}
        {node.type === 'sidenote' && (
          <SidenoteForm
            config={node.config as SidenoteConfig}
            onPatch={patchConfig}
          />
        )}
        {node.type === 'script' && (
          <ScriptForm
            config={node.config as ScriptConfig}
            refs={refs}
            templateRefs={templateRefs}
            selfId={node.id}
            onPatch={patchConfig}
          />
        )}
        {node.type === 'manual' && (
          <ManualForm
            config={node.config as ManualConfig}
            refs={refs}
            templateRefs={templateRefs}
            selfId={node.id}
            onPatch={patchConfig}
          />
        )}
      </form>
    </aside>
  );
}
