'use client';

import {
  useCallback,
  useEffect,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';

/* Wire shape: keep aligned with `HermesLocalConnection` in
 * `lib/server/providers/hermes-local-store.ts`. We don't import that type
 * here because this is a 'use client' file and importing from a server
 * module would drag node-only deps into the bundle. */
interface PortProfile {
  port: number;
  profile: string;
}

interface Connection {
  id: string;
  label: string;
  host: string;
  token: string;
  ports: PortProfile[];
}

interface Props {
  /** Called when the user dismisses the modal. */
  onClose: () => void;
  /** Called after any successful create / update / delete so the palette
   * can re-fetch /api/providers and re-render its draggable card list. */
  onConnectionsChanged: () => void;
}

interface PortRow {
  /** Stable row id — survives reorder/remove without re-mounting inputs. */
  rowId: string;
  port: string;
  /** Last-known discovered profile. Comes from an existing connection on
   * edit; cleared when the user changes the port number and refreshed
   * after a successful save. Empty string = "not yet discovered". */
  profile: string;
}

interface FormState {
  /** Editing an existing connection? If null we're creating a new one
   * (POST on submit). The id is immutable once the file exists. */
  editingId: string | null;
  label: string;
  host: string;
  token: string;
  ports: PortRow[];
}

function nextRowId(): string {
  return `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Default port for a fresh Hermes connection. 8642 is the port the
 * Hermes Agent API server documentation uses in its examples, so most
 * users land there on a stock deployment and can hit save immediately. */
const DEFAULT_PORT = '8642';

const EMPTY_FORM: FormState = {
  editingId: null,
  label: '',
  host: '',
  token: '',
  ports: [{ rowId: nextRowId(), port: DEFAULT_PORT, profile: '' }],
};

function fromConnection(c: Connection): FormState {
  return {
    editingId: c.id,
    label: c.label,
    host: c.host,
    token: c.token,
    ports:
      c.ports.length > 0
        ? c.ports.map((p) => ({
            rowId: nextRowId(),
            port: String(p.port),
            profile: p.profile,
          }))
        : [{ rowId: nextRowId(), port: '', profile: '' }],
  };
}

/**
 * Modal for managing `*.hermes.local.json` connections. A connection is
 * `{ label, host, token, ports[] }`; on save the server hits
 * `<host>:<port>/v1/models` for each port and stores the discovered
 * model id alongside. Each (port, profile) pair becomes its own palette
 * card.
 */
export default function HermesConnectionsModal({
  onClose,
  onConnectionsChanged,
}: Props) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setListError(null);
    try {
      const r = await fetch('/api/providers/hermes-local');
      const body = (await r.json()) as {
        connections?: Connection[];
        error?: string;
      };
      if (!r.ok) {
        setListError(body.error ?? `HTTP ${r.status}`);
        setConnections([]);
        return;
      }
      setConnections(Array.isArray(body.connections) ? body.connections : []);
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'failed to load');
      setConnections([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const startCreate = () => {
    setFormError(null);
    setForm({
      ...EMPTY_FORM,
      // Fresh rowId per open — using the constant's rowId across two
      // create flows would re-key the same React node and confuse focus.
      ports: [{ rowId: nextRowId(), port: DEFAULT_PORT, profile: '' }],
    });
  };
  const startEdit = (c: Connection) => {
    setFormError(null);
    setForm(fromConnection(c));
  };
  const cancelForm = () => {
    setFormError(null);
    setForm(null);
  };

  const onScalarField =
    (key: 'label' | 'host' | 'token') =>
    (e: ChangeEvent<HTMLInputElement>) => {
      setForm((prev) => (prev ? { ...prev, [key]: e.target.value } : prev));
    };

  const onPortChange = (rowId: string, next: string) => {
    setForm((prev) =>
      prev
        ? {
            ...prev,
            ports: prev.ports.map((p) =>
              // Editing the port invalidates any previously-discovered
              // profile for that row, so it's clear the next save will
              // re-discover.
              p.rowId === rowId ? { ...p, port: next, profile: '' } : p,
            ),
          }
        : prev,
    );
  };
  const onPortAdd = () => {
    setForm((prev) =>
      prev
        ? {
            ...prev,
            ports: [
              ...prev.ports,
              { rowId: nextRowId(), port: '', profile: '' },
            ],
          }
        : prev,
    );
  };
  const onPortRemove = (rowId: string) => {
    setForm((prev) =>
      prev ? { ...prev, ports: prev.ports.filter((p) => p.rowId !== rowId) } : prev,
    );
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!form) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const ports = form.ports
        .map((p) => p.port.trim())
        .filter((p) => p.length > 0)
        .map((p) => Number(p));
      if (ports.length === 0) {
        setFormError('at least one port is required');
        return;
      }
      const payload = {
        label: form.label.trim(),
        host: form.host.trim(),
        token: form.token,
        // Send bare numbers — the server will discover profile names via
        // /v1/models. If a row had a previously-discovered profile and
        // the port wasn't edited, we could pre-supply it to skip the
        // round-trip, but the simpler shape avoids one client/server
        // contract.
        ports,
      };
      const url =
        form.editingId === null
          ? '/api/providers/hermes-local'
          : `/api/providers/hermes-local/${encodeURIComponent(form.editingId)}`;
      const method = form.editingId === null ? 'POST' : 'PUT';
      const r = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await r.json()) as {
        connection?: Connection;
        error?: string;
      };
      if (!r.ok) {
        setFormError(body.error ?? `HTTP ${r.status}`);
        return;
      }
      setForm(null);
      await refresh();
      onConnectionsChanged();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'failed to save');
    } finally {
      setSubmitting(false);
    }
  };

  const onDelete = async (c: Connection) => {
    if (
      !window.confirm(
        `Delete connection "${c.label}" (${c.id})?\nThis removes the .local.json file from disk and any palette cards it produced.`,
      )
    ) {
      return;
    }
    try {
      const r = await fetch(
        `/api/providers/hermes-local/${encodeURIComponent(c.id)}`,
        { method: 'DELETE' },
      );
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        setListError(body.error ?? `HTTP ${r.status}`);
        return;
      }
      if (form?.editingId === c.id) setForm(null);
      await refresh();
      onConnectionsChanged();
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'failed to delete');
    }
  };

  return (
    <div
      className="hlm-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Hermes connections"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <style>{modalCss}</style>
      <div className="hlm-card">
        <header className="hlm-header">
          <h2 className="hlm-title">Hermes connections</h2>
          <button
            type="button"
            className="hlm-close"
            onClick={onClose}
            aria-label="close"
          >
            ✕
          </button>
        </header>

        <p className="hlm-blurb">
          Each connection is a (host, token) pair plus a list of ports.
          On save the server hits{' '}
          <code>&lt;host&gt;:&lt;port&gt;/v1/models</code> to discover
          each port's model id; every (port, model) pair becomes its own
          palette card. Stored as{' '}
          <code>providers/&lt;id&gt;.hermes.local.json</code> (gitignored).
        </p>

        <section className="hlm-list-section">
          <div className="hlm-list-head">
            <h3>existing</h3>
            {form === null && (
              <button
                type="button"
                className="hlm-add"
                onClick={startCreate}
              >
                + new
              </button>
            )}
          </div>
          {listError && <p className="hlm-error">{listError}</p>}
          {connections === null && !listError && (
            <p className="hlm-muted">loading…</p>
          )}
          {connections !== null && connections.length === 0 && !listError && (
            <p className="hlm-muted">none yet — click + new to add one.</p>
          )}
          {connections !== null && connections.length > 0 && (
            <ul className="hlm-list">
              {connections.map((c) => (
                <li key={c.id} className="hlm-row">
                  <div className="hlm-row-text">
                    <span className="hlm-row-id">{c.id}</span>
                    <span className="hlm-row-label">{c.label}</span>
                    <span className="hlm-row-url">{c.host}</span>
                    {c.ports.length > 0 && (
                      <ul className="hlm-row-ports">
                        {c.ports.map((p) => (
                          <li key={p.port}>
                            <span className="hlm-row-port">:{p.port}</span>
                            <span className="hlm-row-arrow">→</span>
                            <span className="hlm-row-profile">{p.profile}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="hlm-row-actions">
                    <button
                      type="button"
                      className="hlm-btn-quiet"
                      onClick={() => startEdit(c)}
                    >
                      edit
                    </button>
                    <button
                      type="button"
                      className="hlm-btn-danger"
                      onClick={() => onDelete(c)}
                    >
                      delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {form !== null && (
          <form className="hlm-form" onSubmit={onSubmit}>
            <h3>
              {form.editingId === null
                ? 'new connection'
                : `edit · ${form.editingId}`}
            </h3>
            <div className="hlm-grid">
              <label className="hlm-field hlm-field-wide">
                <span>label</span>
                <input
                  type="text"
                  value={form.label}
                  onChange={onScalarField('label')}
                  placeholder="My Hermes"
                  required
                />
              </label>
              <label className="hlm-field hlm-field-wide">
                <span>host</span>
                <input
                  type="url"
                  value={form.host}
                  onChange={onScalarField('host')}
                  placeholder="https://hermes.example"
                  required
                />
                <small className="hlm-hint">
                  scheme + hostname only — no port, no path
                </small>
              </label>
              <label className="hlm-field hlm-field-wide">
                <span>bearer token</span>
                <input
                  type="password"
                  value={form.token}
                  onChange={onScalarField('token')}
                  placeholder="sk-…"
                  required
                  autoComplete="off"
                />
              </label>

              <div className="hlm-field hlm-field-wide">
                <span>ports</span>
                <div className="hlm-ports-rows">
                  {form.ports.map((row, i) => (
                    <div key={row.rowId} className="hlm-port-row">
                      <input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={65535}
                        value={row.port}
                        onChange={(e) => onPortChange(row.rowId, e.target.value)}
                        placeholder={DEFAULT_PORT}
                        aria-label={`port ${i + 1}`}
                        required
                      />
                      <span className="hlm-port-profile">
                        {row.profile
                          ? `→ ${row.profile}`
                          : '→ (discovered on save)'}
                      </span>
                      <button
                        type="button"
                        className="hlm-btn-quiet"
                        onClick={() => onPortRemove(row.rowId)}
                        aria-label={`remove port ${i + 1}`}
                        disabled={form.ports.length <= 1}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="hlm-add"
                    onClick={onPortAdd}
                  >
                    + add port
                  </button>
                </div>
              </div>
            </div>
            {formError && <p className="hlm-error">{formError}</p>}
            <div className="hlm-form-actions">
              <button
                type="button"
                className="hlm-btn-quiet"
                onClick={cancelForm}
                disabled={submitting}
              >
                cancel
              </button>
              <button
                type="submit"
                className="hlm-btn-primary"
                disabled={submitting}
              >
                {submitting ? 'discovering…' : 'save'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

const modalCss = `
.hlm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  z-index: 1000;
  padding: 16px;
  overflow: auto;
}
.hlm-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  width: 100%;
  max-width: 720px;
  min-width: 0;
  max-height: calc(100dvh - 32px);
  overflow: auto;
  padding: 22px 26px 26px;
  font-family: var(--mono);
  color: var(--fg);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
}
.hlm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.hlm-title {
  font-size: 13px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--fg-soft);
  margin: 0;
}
.hlm-close {
  background: transparent;
  border: 0;
  color: var(--fg-dim);
  cursor: pointer;
  font-size: 14px;
  padding: 4px 6px;
}
.hlm-close:hover { color: var(--accent-live); }
.hlm-blurb {
  font-size: 12px;
  color: var(--fg-dim);
  margin: 4px 0 18px;
  line-height: 1.5;
}
.hlm-blurb code {
  background: var(--bg-deep);
  padding: 1px 5px;
  border-radius: 3px;
}
.hlm-list-section { margin-bottom: 18px; }
.hlm-list-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 8px;
}
.hlm-list-head h3 {
  font-size: 11px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--fg-soft);
  margin: 0;
}
.hlm-add {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--accent-live);
  background: transparent;
  border: 0;
  cursor: pointer;
  padding: 2px 6px;
}
.hlm-add:hover { text-shadow: var(--crt-glow); }
.hlm-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hlm-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-deep);
}
.hlm-row-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  font-size: 12px;
}
.hlm-row-id { color: var(--fg); overflow-wrap: anywhere; }
.hlm-row-label { color: var(--fg-soft); overflow-wrap: anywhere; }
.hlm-row-url {
  color: var(--fg-dim);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.hlm-row-ports {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: 11px;
}
.hlm-row-ports li { display: flex; gap: 6px; min-width: 0; }
.hlm-row-port { color: var(--fg-soft); min-width: 56px; }
.hlm-row-arrow { color: var(--fg-faint); }
.hlm-row-profile { color: var(--accent-live); min-width: 0; overflow-wrap: anywhere; }
.hlm-row-actions { display: flex; gap: 6px; flex-shrink: 0; }
.hlm-btn-quiet {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--fg-soft);
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.06em;
  padding: 4px 8px;
  border-radius: 3px;
  cursor: pointer;
}
.hlm-btn-quiet:hover { color: var(--fg); border-color: var(--fg-dim); }
.hlm-btn-quiet:disabled { opacity: 0.5; cursor: not-allowed; }
.hlm-btn-danger {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--accent-err, #d44);
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.06em;
  padding: 4px 8px;
  border-radius: 3px;
  cursor: pointer;
}
.hlm-btn-danger:hover { border-color: var(--accent-err, #d44); }
.hlm-btn-primary {
  background: var(--accent-live);
  border: 1px solid var(--accent-live);
  color: var(--bg);
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 5px 14px;
  border-radius: 3px;
  cursor: pointer;
}
.hlm-btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
.hlm-form {
  border-top: 1px dashed var(--border);
  padding-top: 16px;
}
.hlm-form h3 {
  font-size: 11px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--fg-soft);
  margin: 0 0 12px;
}
.hlm-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 14px;
}
.hlm-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.hlm-field-wide { grid-column: 1 / -1; }
.hlm-field > span {
  font-size: 10px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--fg-dim);
}
.hlm-field input {
  min-width: 0;
  background: var(--bg-deep);
  border: 1px solid var(--border);
  color: var(--fg);
  font-family: var(--mono);
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 3px;
}
.hlm-field input:focus {
  outline: 1px solid var(--accent-live);
  outline-offset: -1px;
}
.hlm-field input:disabled {
  background: transparent;
  color: var(--fg-dim);
  cursor: not-allowed;
}
.hlm-ports-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hlm-port-row {
  display: grid;
  grid-template-columns: 100px minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
}
.hlm-port-row input {
  min-width: 0;
  background: var(--bg-deep);
  border: 1px solid var(--border);
  color: var(--fg);
  font-family: var(--mono);
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 3px;
}
.hlm-port-row input:focus {
  outline: 1px solid var(--accent-live);
  outline-offset: -1px;
}
.hlm-port-profile {
  font-size: 11px;
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.hlm-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
.hlm-error {
  color: var(--accent-err, #d44);
  font-size: 11.5px;
  margin: 8px 0 0;
}
.hlm-muted {
  color: var(--fg-dim);
  font-size: 12px;
  margin: 4px 0;
}
.hlm-hint {
  color: var(--fg-dim);
  font-size: 10.5px;
  letter-spacing: 0.02em;
}
@media (max-width: 480px) {
  .hlm-card { padding: 16px; }
  .hlm-row { flex-wrap: wrap; gap: 8px; }
  .hlm-port-row { grid-template-columns: 78px minmax(0, 1fr) auto; gap: 6px; }
}
`;
