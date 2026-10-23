/** Persisted webhook configuration contains references, never authentication values. */
export const WEBHOOK_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;
export type WebhookMethod = typeof WEBHOOK_METHODS[number];
export interface SendWebhookConfig {
  url: string;
  method: WebhookMethod;
  headers?: Record<string, string>;
  /** JSON source: parse first, resolve string values, then serialize. */
  body?: string;
  auth?: { type: 'bearer' | 'header'; secretRef: string; header?: string };
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  idempotencyKey?: string;
  successStatuses?: number[];
}
export interface WebhookAttempt {
  attempt: number;
  startedAt: number;
  durationMs: number;
  statusCode?: number;
  errorCategory?: string;
}
export interface SendWebhookOutput {
  status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
  method: string;
  destination: string;
  statusCode?: number;
  responseHeaders: Record<string, string>;
  responseBody: string;
  responseTruncated: boolean;
  durationMs: number;
  attempts: WebhookAttempt[];
  errorCategory?: string;
  errorMessage?: string;
}
export const WEBHOOK_LIMITS = { bodyBytes: 65_536, headerBytes: 8192, responseBytes: 65_536, urlLength: 4096, concurrency: 8, queue: 32 } as const;
export const sensitiveWebhookKey = (key: string): boolean => /authorization|cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key|access[-_]?key|^key$|^sig$|credential|signature|(^|[-_])auth($|[-_])/i.test(key);
export const reservedWebhookHeader = (key: string): boolean => /^(host|connection|content-length|transfer-encoding|upgrade|trailer|te|expect|proxy-.*|forwarded|x-forwarded-.*|idempotency-key)$/i.test(key);
export const validWebhookHeader = (key: string): boolean => /^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(key);
const fail = (message: string): never => { throw new Error(`Send Webhook: ${message}`); };

/** Only the literal origin is safe to display: paths and queries can contain credentials. */
export function webhookDestination(raw: string): string {
  try {
    const match = /^https:\/\/([^/?#]+)(?:[/?#]|$)/.exec(raw);
    if (!match || /[{}@\\\s]/.test(match[1])) return 'HTTPS endpoint';
    const url = new URL(`https://${match[1]}`);
    return url.origin;
  } catch { return 'HTTPS endpoint'; }
}
export function validateWebhookURL(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { return fail('invalid HTTPS URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || raw.length > WEBHOOK_LIMITS.urlLength || /[\r\n\\]/.test(raw)) fail('URL must use HTTPS without credentials, fragment or backslashes');
  for (const key of url.searchParams.keys()) if (sensitiveWebhookKey(key)) fail('credentials in URL query are not allowed');
  return url;
}
export function validateSendWebhookConfig(value: unknown): asserts value is SendWebhookConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('configuration must be an object');
  const c = value as SendWebhookConfig;
  if (typeof c.url !== 'string' || !c.url.trim() || c.url.length > WEBHOOK_LIMITS.urlLength) fail('URL is required (maximum 4096 characters)');
  if (!WEBHOOK_METHODS.includes(c.method)) fail('unsupported HTTP method');
  // Validate literal components now; resolve and revalidate the entire URL before any IO.
  validateWebhookURL(c.url.replace(/\{\{\s*[\w.-]+\s*\}\}/g, 'template'));
  if (c.headers !== undefined) {
    if (!c.headers || typeof c.headers !== 'object' || Array.isArray(c.headers) || Object.keys(c.headers).length > 32) fail('headers must be a map with at most 32 entries');
    const seen = new Set<string>();
    for (const [key, val] of Object.entries(c.headers)) {
      if (!validWebhookHeader(key) || reservedWebhookHeader(key) || sensitiveWebhookKey(key) || seen.has(key.toLowerCase())) fail('credential, reserved or duplicate header; use an authentication reference');
      if (typeof val !== 'string' || /[\r\n\0]/.test(val)) fail('invalid header value');
      seen.add(key.toLowerCase());
    }
    if (JSON.stringify(c.headers).length > WEBHOOK_LIMITS.headerBytes) fail('headers too large');
  }
  if (c.body !== undefined) {
    if (typeof c.body !== 'string' || c.body.length > WEBHOOK_LIMITS.bodyBytes) fail('JSON body too large');
    if (c.body.trim()) {
      if (c.method === 'GET' || c.method === 'HEAD') fail('GET and HEAD do not accept a body');
      try { JSON.parse(c.body); } catch { fail('body must be valid JSON; put templates in JSON strings'); }
    }
  }
  for (const [field, min, max, fallback] of [['timeoutMs', 100, 60_000, 10_000], ['maxAttempts', 1, 3, 1], ['retryDelayMs', 0, 5000, 500]] as const) {
    const n = c[field] ?? fallback;
    if (!Number.isInteger(n) || n < min || n > max) fail(`${field} must be an integer from ${min} to ${max}`);
  }
  if (c.idempotencyKey !== undefined && (typeof c.idempotencyKey !== 'string' || c.idempotencyKey.length > 256 || /[\r\n\0]/.test(c.idempotencyKey))) fail('invalid idempotency key');
  if ((c.maxAttempts ?? 1) > 1 && ['POST', 'PATCH'].includes(c.method) && !c.idempotencyKey?.trim()) fail('POST/PATCH retries require a stable idempotency key');
  if (c.successStatuses !== undefined && (!Array.isArray(c.successStatuses) || !c.successStatuses.length || c.successStatuses.length > 100 || c.successStatuses.some(n => !Number.isInteger(n) || n < 200 || n > 599 || (n >= 300 && n < 400)))) fail('success statuses must be HTTP codes from 200 to 599, excluding redirects');
  if (c.auth !== undefined) {
    if (!c.auth || !['bearer', 'header'].includes(c.auth.type) || typeof c.auth.secretRef !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(c.auth.secretRef)) fail('authentication requires an uppercase secret reference');
    if (c.auth.type === 'header' && (typeof c.auth.header !== 'string' || !validWebhookHeader(c.auth.header) || reservedWebhookHeader(c.auth.header))) fail('invalid authentication header');
    if (webhookDestination(c.url) === 'HTTPS endpoint') fail('authentication requires a literal HTTPS origin');
    const authHeader = c.auth.type === 'bearer' ? 'authorization' : c.auth.header!.toLowerCase();
    if (Object.keys(c.headers ?? {}).some(key => key.toLowerCase() === authHeader)) fail('authentication header cannot also be configured as a literal header');
  }
}
export function webhookFailure(config: SendWebhookConfig, category: string, previous?: SendWebhookOutput): SendWebhookOutput {
  return {
    method: WEBHOOK_METHODS.includes(config?.method) ? config.method : 'POST', destination: webhookDestination(config?.url ?? ''),
    responseHeaders: {}, responseBody: '', responseTruncated: false, durationMs: 0, attempts: [], ...previous,
    status: category === 'cancelled' ? 'CANCELLED' : 'FAILED', errorCategory: category,
    errorMessage: category === 'interrupted' ? 'Interrupted by server restart; delivery is uncertain and was not replayed.' : `Webhook failed (${category}).`,
  };
}
