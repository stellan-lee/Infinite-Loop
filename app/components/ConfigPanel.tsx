'use client';

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { useWorkflowStore } from '@/lib/client/workflow-store-client';
import Checkbox from './Checkbox';
import FolderPicker from './FolderPicker';
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
  BranchConfig,
  BranchOp,
  ConditionConfig,
  ConditionKind,
  EndConfig,
  JudgeNodeConfig,
  LoopConfig,
  ParallelConfig,
  ParallelMode,
  ParallelOnError,
  ScriptConfig,
  ScriptLanguage,
  SidenoteConfig,
  SubworkflowConfig,
  Workflow,
  WorkflowInputDecl,
  WorkflowNode,
  WorkflowSummary,
} from '@/lib/shared/workflow';

/** Available `{{nodeId.stdout}}` template refs for a given node id. */
function availableRefs(workflow: Workflow | null, selfId: string): string[] {
  if (!workflow) return [];
  return collectWorkflowNodeIdList(workflow.nodes)
    .filter((id) => id !== selfId)
    .map((id) => `{{${id}.stdout}}`);
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
      <span className="field-label">Display name</span>
      <input
        aria-label="Display name"
        type="text"
        value={v}
        placeholder={fallback}
        onChange={(e) => setV(e.target.value)}
      />
      <span className="field-hint">
        Shown on the canvas card. Leave blank to use the default.
      </span>
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
                <input
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
              <input
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
        <input
          type="text"
          value={typeof row.default === 'string' ? row.default : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        />
      );
    case 'text':
      return (
        <textarea
          value={typeof row.default === 'string' ? row.default : ''}
          onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        />
      );
    case 'number': {
      const v = typeof row.default === 'number' ? row.default : '';
      return (
        <input
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
      <span className="field-label">Note</span>
      <textarea
        aria-label="Note text"
        rows={6}
        value={text}
        placeholder="Write a free-form note — pinned to the canvas, not run by the engine."
        onChange={(e) => setText(e.target.value)}
      />
      <span className="field-hint">
        Static text. No templating, no execution — purely for documentation.
      </span>
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
 * Shared between AgentForm (CLI providers) and ScriptForm. Renders the
 * read-only tail-truncated preview backed by FolderPicker. The truncation
 * math + invalid-path warning live here so any future cwd consumer gets
 * the same behavior without re-implementing it. */
function CwdField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
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
      <span className="field-label">Working directory</span>
      <div
        ref={ref}
        role="button"
        tabIndex={0}
        aria-label="Working directory"
        aria-haspopup="dialog"
        aria-expanded={open}
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
        {value ? display : '(no folder selected — click to choose)'}
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

function AgentForm({
  config,
  refs,
  templateRefs,
  selfId,
  providerInfo,
  onPatch,
}: {
  config: AgentConfig;
  refs: string[];
  templateRefs: readonly TemplateRef[];
  selfId: string;
  /** Provider metadata for `config.providerId`, fetched once at the panel
   * level. `null` while the panel-level fetch is in flight, or if the id
   * doesn't match any known provider. */
  providerInfo: ProviderInfo | null;
  onPatch: (next: AgentConfig) => void;
}) {
  const [prompt, setPrompt] = useDebouncedString(
    config.prompt ?? '',
    (next) => onPatch({ ...config, prompt: next }),
  );
  const [cwd, setCwd] = useDebouncedString(config.cwd ?? '', (next) =>
    onPatch({ ...config, cwd: next }),
  );
  const [agent, setAgent] = useDebouncedString(config.agent ?? '', (next) =>
    onPatch({ ...config, agent: next.trim() ? next.trim() : undefined }),
  );

  const providerId = config.providerId ?? 'claude';
  const isHttpProvider = providerInfo?.transport === 'http';

  // Fetch the CLI provider's available agents so the Agent field can
  // suggest them. The cwd is part of the probe because `claude agents`
  // resolves project-scoped agents from the working directory's settings
  // stack — change the cwd, and the listing changes too. When the new
  // listing no longer contains the currently-selected agent (a project-
  // level agent from the old directory), we clear the field so the user
  // has to re-pick; built-in / user-global agents survive the change.
  const [agentChoices, setAgentChoices] = useState<AgentChoice[]>([]);
  useEffect(() => {
    if (isHttpProvider) {
      setAgentChoices([]);
      return;
    }
    // Only probe once an absolute cwd is set; relative cwds would resolve
    // against the server, not the workflow's intended directory.
    if (!cwd || !cwd.startsWith('/')) {
      setAgentChoices([]);
      return;
    }
    let cancelled = false;
    fetch(
      `/api/providers/${encodeURIComponent(providerId)}/agents?cwd=${encodeURIComponent(cwd)}`,
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
  }, [providerId, isHttpProvider, cwd]);

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
      <div className="field">
        <span className="field-label">Provider</span>
        <span
          className="field-hint provider-id-readonly"
          aria-label="Provider"
        >
          {providerId}
        </span>
      </div>

      {/* No Profile field for HTTP providers — each Hermes palette card
       * is already bound to a specific (host, port, model) tuple by the
       * `.hermes.local.json` connection it came from, so there's nothing
       * for the node author to override here. */}

      <div className="field">
        <span className="field-label">Prompt</span>
        <TemplateField
          multiline
          rows={5}
          ariaLabel="Prompt"
          value={prompt}
          onChange={setPrompt}
          selfId={selfId}
          refs={templateRefs}
          fieldPath="prompt"
        />
        <RefChips refs={refs} />
      </div>

      {!isHttpProvider && <CwdField value={cwd} onChange={setCwd} />}

      {!isHttpProvider && (
        <div className="field">
          <span className="field-label">Agent</span>
          <AgentPicker
            value={agent}
            onChange={setAgent}
            choices={agentChoices}
          />
          <span className="field-hint">
            Adds <code>--agent &lt;name&gt;</code> to the spawned command. Leave blank to omit the flag.
          </span>
        </div>
      )}

      <div className="field">
        <span className="field-label">Iteration timeout</span>
        <div className="field-row">
          <input
            aria-label="Iteration timeout"
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
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
            <input
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
                },
              })
            }
          />
        </>
      )}

      {kind === 'command' && (
        <div className="field">
          <span className="field-label">Command</span>
          <input
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
            <textarea
              aria-label="Rubric"
              rows={4}
              value={rubric}
              onChange={(e) => setRubric(e.target.value)}
            />
          </div>
          <div className="field">
            <span className="field-label">Model</span>
            <input
              aria-label="Model"
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
            <span className="field-hint">blank = claude code default</span>
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
          <input
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
          <span className="field-label">Quorum N</span>
          <input
            aria-label="Quorum N"
            type="number"
            min={1}
            value={quorumStr}
            onChange={(e) => setQuorumStr(e.target.value)}
          />
          <span className="field-hint">1 ≤ quorumN ≤ children.length</span>
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
      <input
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
          <input
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
        <span className="field-label">Outputs</span>
        <KvRowsEditor
          rows={outputRows}
          onChange={commitOutputs}
          nameLabel="name"
          valueLabel="child path"
          valuePlaceholder="judge-1.winner"
          valueDescription={
            'dotted path into the child workflow\'s terminal scope, e.g. "judge-1.winner"'
          }
          addLabel="add output"
        />
      </div>
    </>
  );
}

/* ── one judge-candidate textarea row ──────────────────────────
 * Pulled out so each candidate has its own `useDebouncedString` buffer.
 * Caller still keys these rows by array index (see `candidates.map((c, i)
 * => <CandidateRow key={i} … />`); the hook re-syncs to the new `value`
 * when an upstream insert/delete shifts indices, which keeps focus on
 * the same row position but DOES leak the typed-but-uncommitted text of
 * a removed middle row into its successor. A stable per-row id would be
 * the cleaner fix but requires a parallel rowId state since
 * `candidates: string[]` is the persisted shape — tracked as a
 * follow-up. */
function CandidateRow({
  index,
  value,
  template,
  onCommit,
  onRemove,
}: {
  index: number;
  value: string;
  template?: { selfId: string; refs: readonly TemplateRef[] };
  onCommit: (next: string) => void;
  onRemove: () => void;
}) {
  const [v, setV] = useDebouncedString(value, onCommit);
  return (
    <div className="candidate-row">
      <div className="candidate-row-head">
        <span className="candidate-row-index">[{index}]</span>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onRemove}
          aria-label={`remove candidate ${index}`}
        >
          remove
        </button>
      </div>
      {template ? (
        <TemplateField
          multiline
          rows={2}
          ariaLabel={`candidate ${index}`}
          value={v}
          onChange={setV}
          selfId={template.selfId}
          refs={template.refs}
          fieldPath={`candidates.${index}`}
        />
      ) : (
        <textarea
          aria-label={`candidate ${index}`}
          rows={2}
          value={v}
          onChange={(e) => setV(e.target.value)}
        />
      )}
    </div>
  );
}

function JudgeForm({
  config,
  refs,
  templateRefs,
  selfId,
  onPatch,
}: {
  config: JudgeNodeConfig;
  refs: string[];
  templateRefs: readonly TemplateRef[];
  selfId: string;
  onPatch: (next: JudgeNodeConfig) => void;
}) {
  const [criteria, setCriteria] = useDebouncedString(
    config.criteria ?? '',
    (next) => onPatch({ ...config, criteria: next }),
  );
  const [judgePrompt, setJudgePrompt] = useDebouncedString(
    config.judgePrompt ?? '',
    (next) =>
      onPatch({
        ...config,
        judgePrompt: next.length > 0 ? next : undefined,
      }),
  );
  const [model, setModel] = useDebouncedString(config.model ?? '', (next) =>
    onPatch({ ...config, model: next.length > 0 ? next : undefined }),
  );
  const [providerId, setProviderId] = useDebouncedString(
    config.providerId ?? '',
    (next) =>
      onPatch({
        ...config,
        providerId: next.length > 0 ? next : undefined,
      }),
  );

  // judgePrompt is collapsed by default; the checkbox is the user-facing
  // commit point. Toggling off clears the override; toggling on opens an
  // empty textarea (the user-typed value is lost on collapse — that's
  // intentional, since "override off" means "use the default").
  const [overridePrompt, setOverridePrompt] = useState<boolean>(
    () => (config.judgePrompt ?? '').length > 0,
  );

  const candidates = config.candidates ?? [];

  const updateCandidate = (idx: number, next: string) => {
    const arr = candidates.slice();
    arr[idx] = next;
    onPatch({ ...config, candidates: arr });
  };
  const removeCandidate = (idx: number) => {
    const arr = candidates.slice();
    arr.splice(idx, 1);
    onPatch({ ...config, candidates: arr });
  };
  const addCandidate = () => {
    onPatch({ ...config, candidates: [...candidates, ''] });
  };

  return (
    <>
      <div className="field">
        <span className="field-label">Criteria</span>
        <TemplateField
          multiline
          rows={4}
          ariaLabel="Criteria"
          value={criteria}
          onChange={setCriteria}
          selfId={selfId}
          refs={templateRefs}
          fieldPath="criteria"
        />
        <RefChips refs={refs} />
      </div>

      <div className="field">
        <span className="field-label">Candidates</span>
        <div className="candidate-list">
          {candidates.map((c, i) => (
            // Index-keyed: useDebouncedString re-syncs when the upstream
            // value reference changes, so focus on unaffected rows is
            // preserved when another row is added or removed.
            <CandidateRow
              key={i}
              index={i}
              value={c}
              template={{ selfId, refs: templateRefs }}
              onCommit={(next) => updateCandidate(i, next)}
              onRemove={() => removeCandidate(i)}
            />
          ))}
          <button
            type="button"
            className="btn btn-ghost kv-add"
            onClick={addCandidate}
          >
            + add candidate
          </button>
        </div>
      </div>

      <Checkbox
        className="field-checkbox"
        label="Override judge prompt"
        checked={overridePrompt}
        onChange={(next) => {
          setOverridePrompt(next);
          if (!next) {
            // Clear both the local buffer and the stored override so the
            // engine falls back to the provider default.
            setJudgePrompt('');
            onPatch({ ...config, judgePrompt: undefined });
          }
        }}
      />

      {overridePrompt && (
        <div className="field">
          <span className="field-label">Judge prompt</span>
          <TemplateField
            multiline
            rows={4}
            ariaLabel="Judge prompt"
            value={judgePrompt}
            onChange={setJudgePrompt}
            selfId={selfId}
            refs={templateRefs}
            fieldPath="judgePrompt"
          />
        </div>
      )}

      <div className="field">
        <span className="field-label">Model</span>
        <input
          aria-label="Model"
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
        <span className="field-hint">blank = provider default</span>
      </div>

      <div className="field">
        <span className="field-label">Provider</span>
        <input
          aria-label="Provider"
          type="text"
          value={providerId}
          placeholder="claude"
          onChange={(e) => setProviderId(e.target.value)}
        />
      </div>
    </>
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
      <input
        aria-label={`output name ${index}`}
        type="text"
        value={v}
        placeholder="output name"
        onChange={(e) => setV(e.target.value)}
      />
      <button
        type="button"
        className="btn btn-ghost"
        onClick={onRemove}
        aria-label={`remove output ${index}`}
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
        <span className="field-label">Outputs</span>
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
        <span className="field-hint">
          The function returns an object; each declared name is copied into
          this node&apos;s scope under the same key.
        </span>
      </div>

      <div className="field">
        <span className="field-label">Code</span>
        <textarea
          aria-label="Code"
          rows={12}
          spellCheck={false}
          className="code-textarea"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <span className="field-hint field-hint--mono-block">
          {sigHint}
        </span>
        <span className="field-hint">
          Not templated. Define <code>run(…)</code> taking the inputs as
          positional args; return an object with the declared output keys.
        </span>
      </div>

      <CwdField value={cwd} onChange={setCwd} />

      <div className="field">
        <span className="field-label">Timeout</span>
        <div className="field-row">
          <input
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
  // profile dropdown. We fetch it once at the panel level (instead of
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
        {node.id} · {node.type}
      </header>

      <form className="task-form" onSubmit={(e) => e.preventDefault()}>
        {/* Display name applies to every node type — overrides the default
         * "START" / "CLAUDE" / etc. title on the canvas card. Empty value
         * (or whitespace) falls back to the type-default. */}
        <DisplayNameField
          key={node.id}
          value={node.label ?? ''}
          fallback={node.type.toUpperCase()}
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
        {node.type === 'judge' && (
          <JudgeForm
            config={node.config as JudgeNodeConfig}
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
      </form>
    </aside>
  );
}
