'use client';

import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';

interface Profile { id: string; label?: string }
interface Connection {
  id: string;
  label: string;
  baseUrl: string;
  endpoint: string;
  profilesEndpoint: string;
  profiles: Profile[];
  defaultProfile?: string;
  hasApiKey: boolean;
  headerNames: string[];
}
interface HeaderRow { key: string; name: string; value: string }
interface FormState {
  editingId: string | null;
  label: string;
  baseUrl: string;
  endpoint: string;
  profilesEndpoint: string;
  apiKey: string;
  clearApiKey: boolean;
  defaultProfile: string;
  staticModels: string;
  headers: HeaderRow[];
  requestOptions: string;
}
interface Props { onClose: () => void; onConnectionsChanged: () => void }

function rowKey(): string { return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }
function emptyForm(): FormState {
  return { editingId: null, label: '', baseUrl: 'https://api.openai.com/v1', endpoint: '/responses', profilesEndpoint: '/models', apiKey: '', clearApiKey: false, defaultProfile: '', staticModels: '', headers: [], requestOptions: '{}' };
}
function formFor(connection: Connection): FormState {
  return {
    editingId: connection.id,
    label: connection.label,
    baseUrl: connection.baseUrl,
    endpoint: connection.endpoint,
    profilesEndpoint: connection.profilesEndpoint,
    apiKey: '',
    clearApiKey: false,
    defaultProfile: connection.defaultProfile ?? '',
    staticModels: connection.profiles.map((profile) => profile.label && profile.label !== profile.id ? `${profile.id} | ${profile.label}` : profile.id).join('\n'),
    // Values deliberately start blank: the API never returns them. Leaving a
    // row blank preserves its saved value; replacing it updates the secret.
    headers: connection.headerNames.map((name) => ({ key: rowKey(), name, value: '' })),
    // Global options are write-only just like headers: leaving this blank
    // preserves them, while entering JSON replaces them.
    requestOptions: '',
  };
}
function parseModels(text: string): Profile[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [id, label] = line.split('|', 2).map((value) => value.trim());
    return label ? { id, label } : { id };
  });
}

export default function OpenAIProvidersModal({ onClose, onConnectionsChanged }: Props) {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/providers/openai-local');
      const body = await response.json() as { connections?: Connection[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setConnections(Array.isArray(body.connections) ? body.connections : []);
    } catch (err) { setError(err instanceof Error ? err.message : 'failed to load providers'); setConnections([]); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [onClose]);
  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => current ? { ...current, [key]: value } : current);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    setError(null);
    let requestOptions: Record<string, unknown> | undefined;
    try {
      if (form.requestOptions.trim()) {
        const parsed: unknown = JSON.parse(form.requestOptions);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Request options must be a JSON object');
        requestOptions = parsed as Record<string, unknown>;
      }
    } catch (err) { setError(err instanceof Error ? err.message : 'Invalid request options JSON'); return; }
    setSubmitting(true);
    try {
      const payload = {
        label: form.label.trim(), baseUrl: form.baseUrl.trim(), endpoint: form.endpoint.trim(),
        profilesEndpoint: form.profilesEndpoint.trim(), apiKey: form.apiKey, clearApiKey: form.clearApiKey,
        defaultProfile: form.defaultProfile.trim(), profiles: parseModels(form.staticModels),
        headers: form.headers.filter((header) => header.name.trim()).map((header) => ({ name: header.name.trim(), value: header.value })),
        ...(requestOptions ? { requestOptions } : {}),
      };
      const url = form.editingId ? `/api/providers/openai-local/${encodeURIComponent(form.editingId)}` : '/api/providers/openai-local';
      const response = await fetch(url, { method: form.editingId ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setForm(null); await refresh(); onConnectionsChanged();
    } catch (err) { setError(err instanceof Error ? err.message : 'failed to save provider'); }
    finally { setSubmitting(false); }
  };
  const remove = async (connection: Connection) => {
    if (!window.confirm(`Delete OpenAI provider "${connection.label}"? Existing nodes using it will need another provider.`)) return;
    try {
      const response = await fetch(`/api/providers/openai-local/${encodeURIComponent(connection.id)}`, { method: 'DELETE' });
      if (!response.ok) { const body = await response.json() as { error?: string }; throw new Error(body.error ?? `HTTP ${response.status}`); }
      if (form?.editingId === connection.id) setForm(null);
      await refresh(); onConnectionsChanged();
    } catch (err) { setError(err instanceof Error ? err.message : 'failed to delete provider'); }
  };
  return <div className="oap-overlay" role="dialog" aria-modal="true" aria-label="OpenAI-compatible providers" onClick={(event) => { if (event.currentTarget === event.target) onClose(); }}>
    <style>{css}</style>
    <div className="oap-card">
      <header><div><h2>OpenAI providers</h2><p>Reusable server-side connections for OpenAI-compatible APIs. API keys and header values are write-only.</p></div><button type="button" className="oap-close" onClick={onClose} aria-label="Close OpenAI providers">✕</button></header>
      {error && <p className="oap-error" role="alert">{error}</p>}
      <section><div className="oap-list-head"><h3>Configured providers</h3>{!form && <button type="button" onClick={() => { setError(null); setForm(emptyForm()); }}>+ add provider</button>}</div>
      {connections === null ? <p className="oap-muted">Loading…</p> : connections.length === 0 ? <p className="oap-muted">No providers yet. Add one to use it from an OpenAI node.</p> : <ul>{connections.map((connection) => <li key={connection.id}><div><strong>{connection.label}</strong><code>{connection.baseUrl}{connection.endpoint}</code><small>{connection.hasApiKey ? 'API key saved' : 'No API key'} · {connection.defaultProfile || 'No default model'}</small></div><div className="oap-actions"><button type="button" onClick={() => { setError(null); setForm(formFor(connection)); }}>edit</button><button type="button" className="oap-danger" onClick={() => void remove(connection)}>delete</button></div></li>)}</ul>}</section>
      {form && <form onSubmit={(event) => void submit(event)}><h3>{form.editingId ? `Edit ${form.editingId}` : 'New provider'}</h3><div className="oap-grid">
        <label><span>Label</span><input required value={form.label} onChange={(event) => update('label', event.target.value)} placeholder="OpenAI" /></label>
        <label><span>Base URL</span><input required type="url" value={form.baseUrl} onChange={(event) => update('baseUrl', event.target.value)} placeholder="https://api.openai.com/v1" /></label>
        <label><span>API key <em>optional</em></span><input type="password" value={form.apiKey} onChange={(event) => { update('apiKey', event.target.value); if (event.target.value) update('clearApiKey', false); }} placeholder={form.editingId ? 'Saved — enter to replace' : 'sk-…'} autoComplete="off" />{form.editingId && <span className="oap-check"><input type="checkbox" checked={form.clearApiKey} onChange={(event) => update('clearApiKey', event.target.checked)} /> Remove saved API key</span>}</label>
        <label><span>Default model <em>optional</em></span><input value={form.defaultProfile} onChange={(event) => update('defaultProfile', event.target.value)} placeholder="gpt-4.1-mini" /></label>
        <label><span>Responses endpoint</span><input value={form.endpoint} readOnly aria-readonly="true" /></label>
        <label><span>Models endpoint <em>blank disables discovery</em></span><input value={form.profilesEndpoint} onChange={(event) => update('profilesEndpoint', event.target.value)} placeholder="/models" /></label>
        <label className="wide"><span>Static models <em>optional fallback; one model per line, use “id | label” for a display label</em></span><textarea value={form.staticModels} onChange={(event) => update('staticModels', event.target.value)} placeholder={'gpt-4.1-mini\ngpt-4.1 | GPT 4.1'} rows={4} /></label>
        <div className="wide"><span className="oap-label">Custom headers <em>optional; values are hidden after save</em></span>{form.headers.map((header, index) => <div className="oap-header" key={header.key}><input aria-label={`header name ${index + 1}`} value={header.name} onChange={(event) => update('headers', form.headers.map((row) => row.key === header.key ? { ...row, name: event.target.value } : row))} placeholder="Header name" /><input aria-label={`header value ${index + 1}`} value={header.value} onChange={(event) => update('headers', form.headers.map((row) => row.key === header.key ? { ...row, value: event.target.value } : row))} placeholder="Value (saved if blank)" /><button type="button" onClick={() => update('headers', form.headers.filter((row) => row.key !== header.key))}>✕</button></div>)}<button type="button" className="oap-add" onClick={() => update('headers', [...form.headers, { key: rowKey(), name: '', value: '' }])}>+ header</button></div>
        <label className="wide"><span>Request options <em>optional write-only JSON; blank preserves saved options. Model, input, stream, and text format remain controlled by the node</em></span><textarea value={form.requestOptions} onChange={(event) => update('requestOptions', event.target.value)} rows={6} spellCheck={false} /></label>
      </div><footer><button type="button" onClick={() => setForm(null)} disabled={submitting}>cancel</button><button type="submit" className="oap-save" disabled={submitting}>{submitting ? 'saving…' : 'save provider'}</button></footer></form>}
    </div>
  </div>;
}

const css = `
.oap-overlay{position:fixed;inset:0;z-index:1000;overflow:auto;padding:48px 20px;background:rgba(0,0,0,.55);font-family:var(--mono);color:var(--fg)}
.oap-card{max-width:780px;margin:auto;padding:22px 26px;background:var(--bg);border:1px solid var(--border);border-radius:7px;box-shadow:0 24px 60px rgba(0,0,0,.45)}
.oap-card header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.oap-card h2,.oap-card h3{margin:0;color:var(--fg-soft);font-size:12px;letter-spacing:.18em;text-transform:uppercase}.oap-card header p,.oap-muted{margin:7px 0 16px;color:var(--fg-dim);font-size:11.5px;line-height:1.5}.oap-card button:not(.oap-close){font:inherit;color:var(--fg-soft);background:transparent;border:1px solid var(--border);border-radius:3px;padding:4px 8px;cursor:pointer}.oap-card button:not(.oap-close):hover{color:var(--accent-live);border-color:var(--accent-live)}.oap-close{display:grid;flex:0 0 auto;place-items:center;width:28px;height:28px;margin:-3px -4px 0 0;padding:0;border:0;background:transparent;color:var(--fg-dim);font:16px/1 var(--mono);cursor:pointer}.oap-close:hover{color:var(--accent-live);background:var(--bg-deep)}.oap-close:focus-visible{outline:1px solid var(--accent-live);outline-offset:2px}
.oap-list-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.oap-card ul{list-style:none;margin:0;padding:0;display:grid;gap:6px}.oap-card li{display:flex;justify-content:space-between;gap:12px;padding:8px 10px;border:1px solid var(--border);background:var(--bg-deep)}.oap-card li div:first-child{display:grid;gap:3px;font-size:12px}.oap-card code,.oap-card small{color:var(--fg-dim);font-size:11px;overflow-wrap:anywhere}.oap-actions{display:flex;align-self:start;gap:5px}.oap-danger{color:var(--accent-err)!important}.oap-error{color:var(--accent-err);font-size:12px}
.oap-card form{margin-top:18px;padding-top:16px;border-top:1px dashed var(--border)}.oap-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px 14px;margin-top:12px}.oap-grid label,.wide{display:flex;flex-direction:column;gap:4px}.wide{grid-column:1/-1}.oap-grid span,.oap-label{color:var(--fg-dim);font-size:10px;letter-spacing:.12em;text-transform:uppercase}.oap-grid em{font-style:normal;font-size:9px;letter-spacing:0;text-transform:none}.oap-grid input,.oap-grid textarea{box-sizing:border-box;width:100%;background:var(--bg-deep);border:1px solid var(--border);border-radius:3px;color:var(--fg);font:12px var(--mono);padding:7px 8px}.oap-grid textarea{resize:vertical}.oap-grid input:focus,.oap-grid textarea:focus{outline:1px solid var(--accent-live);outline-offset:-1px}.oap-check{display:flex;align-items:center;gap:6px;color:var(--fg-dim)!important;font-size:10px!important;letter-spacing:0!important;text-transform:none!important}.oap-check input{width:auto;padding:0}.oap-header{display:grid;grid-template-columns:1fr 1fr auto;gap:6px;margin:5px 0}.oap-add{align-self:start;margin-top:2px}.oap-card footer{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}.oap-card .oap-save{color:var(--bg);background:var(--accent-live);border-color:var(--accent-live)}
@media(max-width:640px){.oap-overlay{padding:16px 8px}.oap-card{padding:18px}.oap-grid{grid-template-columns:1fr}.oap-header{grid-template-columns:1fr auto}.oap-header input:nth-child(2){grid-column:1}.oap-card li{flex-direction:column}.oap-actions{align-self:auto}}
`;
