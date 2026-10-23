/** Hermetic HTTPS/DNS fixture loaded only by the webhook acceptance server. */
import https from 'node:https';
import { Resolver } from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { appendFileSync, readFileSync } from 'node:fs';
const fixture = process.env.INFLOOP_E2E_WEBHOOK_FIXTURE;
const requests = process.env.INFLOOP_E2E_WEBHOOK_REQUESTS;
if (!fixture || !requests) throw new Error('Webhook acceptance fixture paths required');
Resolver.prototype.resolve4 = async function(hostname: string) {
  if (hostname !== 'webhook-fixture.test') throw new Error('Unexpected fixture DNS name');
  return ['93.184.216.34'];
} as typeof Resolver.prototype.resolve4;
Resolver.prototype.resolve6 = async function(hostname: string) {
  if (hostname !== 'webhook-fixture.test') throw new Error('Unexpected fixture DNS name');
  return [];
} as typeof Resolver.prototype.resolve6;
https.request = ((options: https.RequestOptions) => {
  if (options.hostname !== '93.184.216.34' || options.servername !== 'webhook-fixture.test' || options.rejectUnauthorized !== true) throw new Error('Unexpected fixture HTTPS options');
  const state = JSON.parse(readFileSync(fixture, 'utf8')) as { statusCode: number; delayMs?: number };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  const request = Object.assign(new EventEmitter(), {
    destroy() { destroyed = true; if (timer) clearTimeout(timer); },
    end(body?: string) {
      // Synthetic fixtures only: production requests never use this logger.
      appendFileSync(requests, JSON.stringify({ method: options.method, path: options.path, headers: options.headers, body }) + '\n');
      timer = setTimeout(() => {
        if (destroyed) return;
        const response = Object.assign(new EventEmitter(), { statusCode: state.statusCode, headers: { 'content-type': 'application/json', 'set-cookie': 'private-fixture-cookie', location: 'https://127.0.0.1/blocked' }, destroy() {} });
        request.emit('response', response);
        if (destroyed) return;
        response.emit('data', Buffer.from(JSON.stringify({ received: JSON.parse(body ?? '{}'), authorization: 'Bearer synthetic-webhook-e2e-secret', echo: 'synthetic-webhook-e2e-secret', accepted: state.statusCode === 201 })));
        response.emit('end');
      }, state.delayMs ?? 100);
    },
  });
  return request;
}) as typeof https.request;
