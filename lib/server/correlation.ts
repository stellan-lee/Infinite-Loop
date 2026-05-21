/*
 * Correlation ids — end-to-end run traceability.
 *
 * One id is minted at ingress (POST /api/run, POST /api/webhook/[triggerId],
 * the MCP enqueue tool) and threaded through the trigger queue, the engine, the
 * RunController, and every artifact the run produces: structured logs, the
 * audit log, the SSE event stream, and the persisted run record. Joining those
 * on a single value is what lets an operator walk webhook → queue item → run →
 * failing node when something goes wrong unattended. See specs/correlation-id.md.
 *
 * The id is always minted server-side — never read from a caller-supplied
 * header. Webhook ingress is untrusted; echoing an attacker-chosen string into
 * our logs and audit trail would be a log-injection vector. The minted id is
 * instead RETURNED to the caller (response body + `x-correlation-id` header) so
 * a client that wants to correlate can record the value we chose.
 */

import { randomBytes } from 'node:crypto';

/** Response header the ingress routes set so an operator sees the id without
 *  parsing the JSON body. */
export const CORRELATION_HEADER = 'x-correlation-id';

/** Prefix on every correlation id — makes the value recognizable at a glance
 *  in a log line, an audit entry, or an HTTP header, and greppable on its own. */
const PREFIX = 'cid_';

/**
 * Mint a fresh correlation id: `cid_` + 18 random bytes base64url (24 chars),
 * 28 total. 144 bits of entropy — collision-free for this tool's lifetime.
 */
export function newCorrelationId(): string {
  return PREFIX + randomBytes(18).toString('base64url');
}

/** True if `v` has the shape `newCorrelationId()` produces. Used by tests and
 *  available for any future inbound-id validation. */
export function isCorrelationId(v: unknown): v is string {
  return typeof v === 'string' && /^cid_[A-Za-z0-9_-]{24}$/.test(v);
}
