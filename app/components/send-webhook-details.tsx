'use client';

import { useState } from 'react';
import { Input, TextArea } from '@heroui/react';
import type { WorkflowStoreState } from '@/lib/client/workflow-store-client';
import { useWorkflowStore } from '@/lib/client/workflow-store-client';
import type { WorkflowEvent } from '@/lib/shared/workflow';
import {
  type SendWebhookConfig,
  type SendWebhookOutput,
  WEBHOOK_METHODS,
  validateSendWebhookConfig,
} from '@/lib/shared/send-webhook';
import type { TemplateRef } from '@/lib/shared/template-refs';
import TemplateField from './TemplateField';
import SelectMenu from './SelectMenu';
import { useDebouncedString } from './config/shared';

export function latestWebhookOutput(events: readonly WorkflowEvent[], nodeId: string): SendWebhookOutput | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'webhook_updated' && event.nodeId === nodeId) return event.output;
  }
}

export function webhookOutputForNode(
  state: Pick<WorkflowStoreState, 'inspectedRunEvents' | 'runEvents' | 'webhooks'>,
  nodeId: string,
): SendWebhookOutput | undefined {
  if (state.inspectedRunEvents !== null) return latestWebhookOutput(state.inspectedRunEvents, nodeId);
  return state.webhooks[nodeId] ?? latestWebhookOutput(state.runEvents, nodeId);
}

export function SendWebhookDetails({ output }: { output?: SendWebhookOutput }) {
  if (!output) return <p className="field-hint">Results appear when this node is reached during a run.</p>;
  return (
    <section className="field" aria-label="Webhook results">
      <h3>{output.status}{output.statusCode ? ` · HTTP ${output.statusCode}` : ''}</h3>
      <p>{output.method} {output.destination} · {output.durationMs} ms</p>
      {output.errorMessage && <p role="alert">{output.errorMessage}</p>}
      <ol>
        {output.attempts.map(attempt => (
          <li key={attempt.attempt}>
            Attempt {attempt.attempt}: {attempt.statusCode ? `HTTP ${attempt.statusCode}` : attempt.errorCategory ?? 'Sending'} · {attempt.durationMs} ms
          </li>
        ))}
      </ol>
      {output.responseTruncated && <p>Response exceeded the limit; body omitted.</p>}
      {Object.keys(output.responseHeaders).length > 0 && (
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {JSON.stringify(output.responseHeaders, null, 2)}
        </pre>
      )}
      {output.responseBody && (
        <pre
          aria-label="Webhook response body"
          style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 240, overflow: 'auto' }}
        >{output.responseBody}</pre>
      )}
    </section>
  );
}

export function SendWebhookForm({ config, nodeId, refs, onPatch }: {
  config: SendWebhookConfig;
  nodeId: string;
  refs: readonly TemplateRef[];
  onPatch: (config: SendWebhookConfig) => void;
}) {
  const output = useWorkflowStore(state => webhookOutputForNode(state, nodeId));
  const [headerError, setHeaderError] = useState('');
  const patch = (value: Partial<SendWebhookConfig>) => onPatch({ ...config, ...value });
  const [headers, setHeaders] = useDebouncedString(JSON.stringify(config.headers ?? {}, null, 2), value => {
    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      patch({ headers: parsed });
      setHeaderError('');
    } catch { setHeaderError('Headers must be a JSON object. Changes have not been applied.'); }
  });
  const [statuses, setStatuses] = useDebouncedString(config.successStatuses?.join(', ') ?? '', value => {
    patch({ successStatuses: value.trim() ? value.split(',').map(Number) : undefined });
  });
  let error = '';
  try { validateSendWebhookConfig(config); }
  catch (caught) { error = caught instanceof Error ? caught.message : 'Invalid webhook configuration'; }

  return (
    <>
      <div className="field">
        <label>HTTPS URL</label>
        <TemplateField
          selfId={nodeId} refs={refs} fieldPath="url" ariaLabel="Webhook URL"
          value={config.url} onChange={url => patch({ url })}
        />
      </div>
      <div className="field">
        <label>HTTP method</label>
        <SelectMenu
          ariaLabel="Webhook method" value={config.method}
          options={WEBHOOK_METHODS.map(value => ({ value, label: value }))}
          onChange={method => patch({ method })}
        />
      </div>
      <div className="field">
        <label>Headers (JSON object)</label>
        <TextArea
          aria-label="Webhook headers" variant="secondary" value={headers}
          onChange={event => setHeaders(event.target.value)}
        />
        <p className="field-hint">Nonsecret headers only. Use an authentication reference for credentials.</p>
        {headerError && <p role="alert">{headerError}</p>}
      </div>
      <div className="field">
        <label>JSON body</label>
        <TemplateField
          multiline rows={6} selfId={nodeId} refs={refs} fieldPath="body" ariaLabel="Webhook JSON body"
          value={config.body ?? ''} onChange={body => patch({ body })}
        />
        <p className="field-hint">
          Put upstream references inside JSON strings, for example {'{"message":"{{agent.stdout}}"}'}. GET and HEAD require an empty body.
        </p>
      </div>
      <div className="field">
        <label>Authentication</label>
        <SelectMenu<'none' | 'bearer' | 'header'>
          ariaLabel="Webhook authentication" value={config.auth?.type ?? 'none'}
          options={[
            { value: 'none', label: 'None' },
            { value: 'bearer', label: 'Bearer token reference' },
            { value: 'header', label: 'Custom header reference' },
          ]}
          onChange={type => patch({
            auth: type === 'none' ? undefined : {
              type, secretRef: config.auth?.secretRef ?? '',
              ...(type === 'header' ? { header: config.auth?.header ?? 'X-API-Key' } : {}),
            },
          })}
        />
      </div>
      {config.auth && (
        <>
          <div className="field">
            <label>Secret reference</label>
            <Input
              variant="secondary" aria-label="Webhook secret reference" value={config.auth.secretRef}
              onChange={event => patch({ auth: { ...config.auth!, secretRef: event.target.value } })}
              placeholder="PARTNER_TOKEN"
            />
            <p className="field-hint">
              The server reads INFLOOP_WEBHOOK_SECRET_ followed by this reference.
              Enter a reference name, never the secret value. Authentication requires a literal HTTPS origin.
            </p>
          </div>
          {config.auth.type === 'header' && (
            <div className="field">
              <label>Authentication header</label>
              <Input
                variant="secondary" aria-label="Webhook auth header" value={config.auth.header ?? ''}
                onChange={event => patch({ auth: { ...config.auth!, header: event.target.value } })}
              />
            </div>
          )}
        </>
      )}
      <div className="field">
        <label>Overall timeout (ms)</label>
        <Input
          variant="secondary" aria-label="Webhook timeout" type="number" min={100} max={60000}
          value={config.timeoutMs ?? 10000} onChange={event => patch({ timeoutMs: Number(event.target.value) })}
        />
      </div>
      <div className="field">
        <label>Maximum attempts</label>
        <Input
          variant="secondary" aria-label="Webhook maximum attempts" type="number" min={1} max={3}
          value={config.maxAttempts ?? 1} onChange={event => patch({ maxAttempts: Number(event.target.value) })}
        />
      </div>
      <div className="field">
        <label>Retry delay (ms)</label>
        <Input
          variant="secondary" aria-label="Webhook retry delay" type="number" min={0} max={5000}
          value={config.retryDelayMs ?? 500} onChange={event => patch({ retryDelayMs: Number(event.target.value) })}
        />
      </div>
      <div className="field">
        <label>Stable idempotency key</label>
        <TemplateField
          selfId={nodeId} refs={refs} fieldPath="idempotencyKey" ariaLabel="Webhook idempotency key"
          value={config.idempotencyKey ?? ''} onChange={idempotencyKey => patch({ idempotencyKey })}
        />
      </div>
      <p className="field-hint">
        Retries can deliver duplicates. POST/PATCH retries require a key supported by the receiver.
        Restarted requests are never replayed automatically.
      </p>
      <div className="field">
        <label>Success HTTP statuses</label>
        <Input
          variant="secondary" aria-label="Webhook success statuses" value={statuses}
          placeholder="Empty = all 2xx; or 200, 201, 204"
          onChange={event => setStatuses(event.target.value)}
        />
      </div>
      <p className="field-hint">
        Public HTTPS destinations only. Redirects fail. Response bodies are capped at 64 KiB and credential values are redacted.
      </p>
      {error && <p role="alert">{error}</p>}
      <SendWebhookDetails output={output} />
    </>
  );
}
