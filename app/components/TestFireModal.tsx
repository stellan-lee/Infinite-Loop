'use client';

import { useState } from 'react';
import type { WebhookPlugin, WebhookTrigger } from '@/lib/shared/trigger';

export interface TestFireModalProps {
  trigger: WebhookTrigger;
  plugin?: WebhookPlugin;
  onClose: () => void;
}

export function TestFireModal({ trigger, plugin, onClose }: TestFireModalProps) {
  const event = plugin?.events.find((e) => e.type === trigger.eventType);
  const [headers, setHeaders] = useState<string>(
    plugin?.eventHeader && trigger.eventType
      ? `${plugin.eventHeader}: ${trigger.eventType}`
      : '',
  );
  const [payload, setPayload] = useState<string>('{}');
  const [response, setResponse] = useState<{ status: number; body: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  function handlePrefill() {
    if (event?.examplePayload !== undefined) {
      setPayload(JSON.stringify(event.examplePayload, null, 2));
    }
  }

  async function handleSend() {
    setError(null);
    setSending(true);
    setResponse(null);
    try {
      const parsedPayload = JSON.parse(payload);
      const parsedHeaders: Record<string, string> = {};
      for (const line of headers.split('\n')) {
        const idx = line.indexOf(':');
        if (idx < 0) continue;
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (k.length > 0) parsedHeaders[k] = v;
      }
      const res = await fetch(`/api/triggers/${trigger.id}/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ payload: parsedPayload, headers: parsedHeaders }),
      });
      if (!res.ok) {
        setError(`Test endpoint returned ${res.status}`);
        return;
      }
      const json = await res.json() as { status: number; body: unknown };
      setResponse(json);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal trg-form-modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">Test fire — {trigger.name}</header>

        <div className="modal-body">
          <label className="trg-form-row">
            <span className="trg-form-label">Headers (one per line, key: value)</span>
            <textarea
              className="trg-form-textarea"
              rows={2}
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              aria-label="Headers"
            />
          </label>

          <label className="trg-form-row">
            <span className="trg-form-label">Payload (JSON)</span>
            <textarea
              className="trg-form-textarea"
              rows={10}
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              aria-label="Payload"
            />
          </label>

          {error && <div className="trg-form-error">{error}</div>}
          {response && (
            <div className="trg-form-test-response">
              <code>{response.status}</code> <code>{JSON.stringify(response.body)}</code>
            </div>
          )}
        </div>

        <div className="modal-actions">
          {event?.examplePayload !== undefined && (
            <button type="button" className="btn" onClick={handlePrefill}>
              Pre-fill example
            </button>
          )}
          <button type="button" className="btn" disabled={sending} onClick={handleSend}>
            Send
          </button>
          <button type="button" className="btn" onClick={onClose}>Close</button>
        </div>

      </div>
    </div>
  );
}
