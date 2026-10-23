import type { NodeExecutor, Scope } from '../../shared/workflow';
import { type SendWebhookConfig, type SendWebhookOutput, WEBHOOK_LIMITS, sensitiveWebhookKey, validateSendWebhookConfig, validateWebhookURL, webhookDestination, webhookFailure } from '../../shared/send-webhook';
import { resolve } from '../templating';
import { CheckpointError } from '../durable-run';
import { WebhookError, sendWebhookRequest, webhookSlots } from '../webhook-transport';

function template(text: string, scope: Scope): string {
  const result = resolve(text, scope);
  if (result.warnings.length) throw new WebhookError('unresolved_template');
  return result.text;
}
function resolveJSON(value: unknown, scope: Scope): unknown {
  if (typeof value === 'string') return template(value, scope);
  if (Array.isArray(value)) return value.map(item => resolveJSON(item, scope));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveJSON(item, scope)]));
  return value;
}
function sensitiveValues(value: unknown, sensitive = false): string[] {
  if (Array.isArray(value)) return value.flatMap(item => sensitiveValues(item, sensitive));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => {
      const marked = sensitive || sensitiveWebhookKey(key);
      const values = sensitiveValues(item, marked);
      // Retain the original container encoding as well as separately echoed leaves.
      // Serialize only at the sensitive boundary, avoiding repeated ancestor copies.
      if (!sensitive && marked && item && typeof item === 'object') values.push(JSON.stringify(item));
      return values;
    });
  }
  return sensitive && value !== null && value !== undefined ? [String(value)] : [];
}

/** Undefined means safely omitted: size or redaction complexity exceeded the bound. */
export function redactWebhookText(text: string, secrets: string[], maxBytes: number = WEBHOOK_LIMITS.responseBytes): string | undefined {
  if (Buffer.byteLength(text) > maxBytes) return undefined;
  const marker = '[REDACTED]';
  const variants = new Set<string>();
  const seen = new Set<string>();
  let patternBytes = 0;
  for (const secret of secrets) {
    if (!secret || seen.has(secret)) continue;
    // Fixed ceilings bound encoding allocations and the literal-only regex below.
    if (secret.length > 16_384 || seen.size >= 128) return undefined;
    seen.add(secret);
    let encoded: string;
    try { encoded = encodeURIComponent(secret); } catch { return undefined; }
    for (const variant of [secret, encoded, Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url'), JSON.stringify(secret).slice(1, -1)]) {
      if (variants.has(variant)) continue;
      patternBytes += Buffer.byteLength(variant);
      if (variants.size >= 128 || patternBytes > 16_384) return undefined;
      variants.add(variant);
    }
  }
  // Receiver text is not a trusted marker. Omitting collisions also covers
  // secrets that begin inside a marker, which alternative ordering cannot fix.
  if (variants.size && text.includes(marker)) return undefined;
  let safe = text;
  const redactObject = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(redactObject);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitiveWebhookKey(key) ? marker : redactObject(item)]));
    return value;
  };
  let parsed: unknown;
  let json = false;
  try { parsed = JSON.parse(text); json = true; } catch { /* Treat non-JSON as text. */ }
  if (json) {
    // JSON escapes can hide receiver-supplied markers from the raw-text check.
    // Normalize before introducing any of our own markers, including JSON keys.
    try {
      if (variants.size && JSON.stringify(parsed).includes(marker)) return undefined;
    } catch { return undefined; }
    // Replacing a JSON value with this fixed marker expands input by at most
    // 12x, so even this intermediate is bounded by 12 * maxBytes.
    try { safe = JSON.stringify(redactObject(parsed)); } catch { return undefined; }
    if (Buffer.byteLength(safe) > maxBytes) return undefined;
  } else {
    // Each pass inserts only fixed-size markers into bounded original input.
    safe = safe.replace(/((?:authorization|cookie|password|secret|token|api[-_]?key|credential)\s*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;&<]+)/gi, '$1[REDACTED]');
    if (Buffer.byteLength(safe) > maxBytes) return undefined;
    safe = safe.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]');
    if (Buffer.byteLength(safe) > maxBytes) return undefined;
  }
  if (!variants.size) return safe;
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Only markers inserted by key redaction remain after the collision checks.
  // Protect those markers. Matching only the input
  // means newly inserted markers can never become input to another replacement.
  const pattern = new RegExp([escape(marker), ...[...variants].sort((a, b) => b.length - a.length).map(escape)].join('|'), 'g');
  const chunks: string[] = [];
  let cursor = 0, bytes = 0;
  for (const match of safe.matchAll(pattern)) {
    const prefix = safe.slice(cursor, match.index);
    bytes += Buffer.byteLength(prefix) + marker.length;
    if (bytes > maxBytes) return undefined;
    chunks.push(prefix, marker);
    cursor = match.index! + match[0].length;
  }
  const tail = safe.slice(cursor);
  if (bytes + Buffer.byteLength(tail) > maxBytes) return undefined;
  chunks.push(tail);
  return chunks.join('');
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new WebhookError('cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
export const sendWebhookExecutor: NodeExecutor = {
  async execute(ctx) {
    const config = ctx.config as SendWebhookConfig;
    const startedAt = Date.now();
    let output = webhookFailure(config, 'configuration');
    let release: (() => void) | undefined;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    ctx.signal.addEventListener('abort', cancel, { once: true });
    if (ctx.signal.aborted) cancel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = async () => { output.durationMs = Date.now() - startedAt; await ctx.reportWebhookProgress?.(structuredClone(output)); };
    try {
      validateSendWebhookConfig(config);
      timer = setTimeout(cancel, config.timeoutMs ?? 10_000);
      const url = validateWebhookURL(template(config.url, ctx.scope));
      if (config.auth && url.origin !== webhookDestination(config.url)) throw new WebhookError('auth_origin_changed');
      output = { ...output, status: 'RUNNING', errorCategory: undefined, errorMessage: undefined };
      const headers = Object.fromEntries(Object.entries(config.headers ?? {}).map(([key, value]) => [key.toLowerCase(), template(value, ctx.scope)]));
      const parsed = config.body?.trim() ? resolveJSON(JSON.parse(config.body), ctx.scope) : undefined;
      const body = parsed === undefined ? undefined : JSON.stringify(parsed);
      if (body !== undefined && Buffer.byteLength(body) > WEBHOOK_LIMITS.bodyBytes) throw new WebhookError('request_limit');
      const secrets = sensitiveValues(parsed);
      // Values embedded in URLs may be signed endpoint tokens even without recognizable names.
      secrets.push(...url.searchParams.values(), ...url.pathname.split('/').filter(Boolean).map(part => { try { return decodeURIComponent(part); } catch { return part; } }));
      if (config.auth) {
        const secret = process.env[`INFLOOP_WEBHOOK_SECRET_${config.auth.secretRef}`];
        if (!secret || /[\r\n\0]/.test(secret)) throw new WebhookError('secret_unavailable');
        secrets.push(secret);
        const name = config.auth.type === 'bearer' ? 'authorization' : config.auth.header!.toLowerCase();
        headers[name] = config.auth.type === 'bearer' ? `Bearer ${secret}` : secret;
      }
      if (config.idempotencyKey) {
        headers['idempotency-key'] = template(config.idempotencyKey, ctx.scope);
        if (!headers['idempotency-key'].trim() || headers['idempotency-key'].length > 256) throw new WebhookError('invalid_idempotency_key');
      }
      if (body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
      if (Object.values(headers).some(value => /[\r\n\0]/.test(value)) || Buffer.byteLength(JSON.stringify(headers)) > WEBHOOK_LIMITS.headerBytes) throw new WebhookError('request_limit');
      await publish();
      release = await webhookSlots.acquire(controller.signal);
      for (let attempt = 1; attempt <= (config.maxAttempts ?? 1); attempt++) {
        if (controller.signal.aborted) throw new WebhookError('cancelled');
        const evidence = { attempt, startedAt: Date.now(), durationMs: 0 } as SendWebhookOutput['attempts'][number];
        output.attempts.push(evidence);
        // This callback must persist before the request. Checkpoint errors must escape.
        await publish();
        let retry = false;
        try {
          const response = await sendWebhookRequest(url, config.method, headers, body, controller.signal);
          evidence.statusCode = response.statusCode;
          output.statusCode = response.statusCode;
          output.responseHeaders = {};
          let headerBytes = 2; // JSON object braces.
          for (const [key, value] of Object.entries(response.headers)) {
            const keyBytes = Buffer.byteLength(JSON.stringify(key));
            const remaining = WEBHOOK_LIMITS.headerBytes - headerBytes - keyBytes - 4;
            const redacted = redactWebhookText(value, secrets, Math.max(0, remaining));
            if (redacted === undefined) continue;
            const entryBytes = keyBytes + Buffer.byteLength(JSON.stringify(redacted)) + 2;
            if (headerBytes + entryBytes > WEBHOOK_LIMITS.headerBytes) continue;
            headerBytes += entryBytes;
            output.responseHeaders[key] = redacted;
          }
          const redactedBody = redactWebhookText(response.body, secrets);
          output.responseTruncated = response.truncated || redactedBody === undefined;
          output.responseBody = output.responseTruncated ? '' : redactedBody!;
          const redirect = response.statusCode >= 300 && response.statusCode < 400;
          const success = !redirect && (config.successStatuses ? config.successStatuses.includes(response.statusCode) : response.statusCode >= 200 && response.statusCode < 300);
          output.status = success ? 'SUCCEEDED' : 'FAILED';
          output.errorCategory = success ? undefined : redirect ? 'redirect' : 'http_status';
          output.errorMessage = success ? undefined : `Webhook failed (${output.errorCategory}, HTTP ${response.statusCode}).`;
          evidence.errorCategory = output.errorCategory;
          retry = !success && [429, 502, 503, 504].includes(response.statusCode);
        } catch (error) {
          if (error instanceof CheckpointError) throw error;
          const category = controller.signal.aborted ? ctx.signal.aborted ? 'cancelled' : 'timeout' : error instanceof WebhookError ? error.category : 'network';
          evidence.errorCategory = category;
          output = webhookFailure(config, category, output);
          retry = ['network', 'dns', 'connect_timeout'].includes(category);
        }
        evidence.durationMs = Date.now() - evidence.startedAt;
        await publish();
        if (!retry || attempt === (config.maxAttempts ?? 1)) break;
        output.status = 'RUNNING';
        await delay(config.retryDelayMs ?? 500, controller.signal);
      }
    } catch (error) {
      if (error instanceof CheckpointError) throw error;
      const category = controller.signal.aborted ? ctx.signal.aborted ? 'cancelled' : 'timeout' : error instanceof WebhookError ? error.category : 'configuration';
      output = webhookFailure(config, category, output);
    } finally {
      if (timer) clearTimeout(timer);
      release?.();
      ctx.signal.removeEventListener('abort', cancel);
    }
    if (ctx.signal.aborted) output = webhookFailure(config, 'cancelled', output);
    await publish();
    return { outputs: { ...output }, branch: output.status === 'SUCCEEDED' ? 'success' : 'failure' };
  },
};
