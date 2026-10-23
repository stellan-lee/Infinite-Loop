import { Resolver } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import { WEBHOOK_LIMITS, validateWebhookURL } from '../shared/send-webhook';

export class WebhookError extends Error {
  constructor(readonly category: string) { super(`Webhook failed (${category}).`); }
}
/** Conservative public-unicast allowlist. IPv4-mapped/translation/tunnel IPv6 is rejected. */
export function isPublicWebhookIP(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(address === '168.63.129.16' || a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || address.includes('%')) return false;
  const groups = address.toLowerCase().split(':');
  const first = parseInt(groups[0] || '0', 16), second = parseInt(groups[1] || '0', 16);
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 &&
    !(first === 0x2001 && (second <= 0x1ff || second === 0xdb8)) && !(first === 0x3fff && second <= 0x0fff);
}

export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new WebhookError('cancelled'));
    if (signal.aborted) { reject(new WebhookError('cancelled')); return; }
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export async function resolveWebhookAddress(url: URL, signal: AbortSignal): Promise<string> {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) {
    if (!isPublicWebhookIP(hostname)) throw new WebhookError('unsafe_destination');
    return hostname;
  }
  const resolver = new Resolver();
  const cancel = () => resolver.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) throw new WebhookError('cancelled');
    const results = await abortable(Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]), signal);
    const addresses: string[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') addresses.push(...result.value);
      else if (!['ENODATA', 'ENOTFOUND'].includes(result.reason?.code)) throw new WebhookError('dns');
    }
    if (!addresses.length) throw new WebhookError('dns');
    if (addresses.some(address => !isPublicWebhookIP(address))) throw new WebhookError('unsafe_destination');
    return addresses[0];
  } finally { signal.removeEventListener('abort', cancel); resolver.cancel(); }
}

/** One process-wide admission queue. Cancellation removes queued work immediately. */
class WebhookSlots {
  private active = 0;
  private queue: Array<() => void> = [];
  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw new WebhookError('cancelled');
    if (this.active >= WEBHOOK_LIMITS.concurrency) {
      if (this.queue.length >= WEBHOOK_LIMITS.queue) throw new WebhookError('queue_full');
      await new Promise<void>((resolve, reject) => {
        const ready = () => { signal.removeEventListener('abort', abort); resolve(); };
        const abort = () => { this.queue = this.queue.filter(item => item !== ready); reject(new WebhookError('cancelled')); };
        signal.addEventListener('abort', abort, { once: true });
        this.queue.push(ready);
      });
    } else this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next(); else this.active--;
    };
  }
}
export const webhookSlots = new WebhookSlots();
export interface WebhookResponse { statusCode: number; headers: Record<string, string>; body: string; truncated: boolean }

/** Pin the validated address in the socket options; never perform a second hostname lookup. */
export async function sendWebhookRequest(url: URL, method: string, headers: Record<string, string>, body: string | undefined, signal: AbortSignal): Promise<WebhookResponse> {
  validateWebhookURL(url.href);
  const address = await resolveWebhookAddress(url, signal);
  if (signal.aborted) throw new WebhookError('cancelled');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: 'https:', hostname: address, port: url.port || 443, method,
      path: url.pathname + url.search, headers: { ...headers, host: url.host },
      // Native verification uses the original SNI name (or the literal IP).
      // Do not supply checkServerIdentity: Bun can invoke custom callbacks after HTTP writes.
      servername: isIP(hostname) ? '' : hostname, rejectUnauthorized: true,
      agent: false, maxHeaderSize: WEBHOOK_LIMITS.headerBytes,
    });
    let settled = false;
    const finish = (error?: WebhookError, response?: WebhookResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      signal.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve(response!);
    };
    const cancel = () => { finish(new WebhookError('cancelled')); request.destroy(); };
    const connectTimer = setTimeout(() => { finish(new WebhookError('connect_timeout')); request.destroy(); }, 5000);
    request.on('socket', socket => socket.once('secureConnect', () => clearTimeout(connectTimer)));
    request.on('error', () => finish(new WebhookError('network')));
    request.on('response', response => {
      clearTimeout(connectTimer);
      const statusCode = response.statusCode ?? 0;
      const safeHeaders: Record<string, string> = {};
      for (const name of ['content-type', 'content-length', 'retry-after']) {
        const value = response.headers[name];
        if (typeof value === 'string') safeHeaders[name] = value;
      }
      if (statusCode >= 300 && statusCode < 400) {
        finish(undefined, { statusCode, headers: {}, body: '', truncated: false });
        response.destroy(); request.destroy(); return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > WEBHOOK_LIMITS.responseBytes) {
          // Do not publish an incomplete JSON prefix: it can defeat key-based redaction.
          finish(undefined, { statusCode, headers: safeHeaders, body: '', truncated: true });
          response.destroy(); request.destroy();
        } else chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => finish(undefined, { statusCode, headers: safeHeaders, body: Buffer.concat(chunks).toString('utf8'), truncated: false }));
      response.on('error', () => finish(new WebhookError('network')));
      response.on('aborted', () => finish(new WebhookError('network')));
    });
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) { cancel(); return; }
    request.end(body);
  });
}
