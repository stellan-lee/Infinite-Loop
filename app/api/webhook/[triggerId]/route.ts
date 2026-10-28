import { NextResponse } from 'next/server';
import { triggerIndex } from '@/lib/server/trigger-index';
import { pluginIndex } from '@/lib/server/webhook-plugins';
import { triggerQueue } from '@/lib/server/trigger-queue-singleton';
import { buildWebhookScope } from '@/lib/server/webhook-scope';
import { evaluatePredicate } from '@/lib/server/predicate';
import { resolve as resolveTemplate } from '@/lib/server/templating';
import { resolveRunInputs, WorkflowInputError } from '@/lib/shared/resolve-run-inputs';
import { getWorkflow } from '@/lib/server/workflow-store';
import { verifySignature } from '@/lib/server/webhook-signature';
import { recordAudit } from '@/lib/server/audit-log';
import { webhookRateLimiter } from '@/lib/server/rate-limiter';
import { metrics, type WebhookOutcome } from '@/lib/server/metrics';
import { createLogger } from '@/lib/server/logger';
import { CORRELATION_HEADER, newCorrelationId } from '@/lib/server/correlation';
import {
  createWebhookReceipt, ensureWebhookReceiptSubscription, updateWebhookReceipt,
} from '@/lib/server/webhook-receipt-store';
import type { WebhookReceipt } from '@/lib/shared/webhook-receipt';
import type { TriggerPredicate, WebhookTrigger } from '@/lib/shared/trigger';
import type { Scope, Workflow } from '@/lib/shared/workflow';

const log = createLogger('webhook');

// NOTE: This route deliberately bypasses INFLOOP_API_TOKEN. The unguessable
// `triggerId` in the path is the auth credential. Every other route uses
// requireAuth(); this is the one explicit exception.

const MAX_BODY_BYTES = 1024 * 1024;

interface RouteParams {
  params: Promise<{ triggerId: string }>;
}

function notFound() {
  return NextResponse.json({ error: 'not-found' }, { status: 404 });
}

/**
 * Map an HTTP status to a coarse webhook metric outcome. Range-based, so a
 * status added at a future return point is still classified without editing
 * this function:
 *   2xx (≠204)  → accepted   (202 queued)
 *   204         → ignored    (ping / wrong event type / predicate no-match)
 *   404         → not_found  (unknown or disabled trigger / plugin / workflow)
 *   503         → rejected   (queue full — expected back-pressure, not a fault)
 *   other 4xx   → rejected   (bad signature, invalid inputs, rate-limited, …)
 *   other 5xx   → error      (misconfiguration or an unexpected failure)
 */
function outcomeFromStatus(status: number): WebhookOutcome {
  if (status >= 200 && status < 300) return status === 204 ? 'ignored' : 'accepted';
  if (status === 404) return 'not_found';
  if (status === 503) return 'rejected';
  if (status >= 400 && status < 500) return 'rejected';
  return 'error';
}

/**
 * Capture a durable receipt before dispatching, then record its HTTP outcome
 * and one webhook metric sample across all handler return points. Queue/run
 * events advance execution state independently. Unexpected errors are recorded
 * before being rethrown for the framework's error handling.
 */
export async function POST(req: Request, ctx: RouteParams): Promise<Response> {
  // Some route-level tests reset the shared event bus. Rewire the one receipt
  // listener at ingress; this is also safe across Next dev module reloads.
  ensureWebhookReceiptSubscription();
  // Mint the correlation id at the ingress edge — before any return point — so
  // every audit entry, log line, and (on accept) the queued run share one id.
  // Set on the response header for ALL outcomes, accepted or rejected, so a
  // rejected webhook is still traceable from its caller's side.
  const correlationId = newCorrelationId();
  const receivedAt = Date.now();
  const { triggerId } = await ctx.params;
  // Retain at most one allowed body, stopping the stream on overflow. This
  // also captures deliveries that routing returns early (unknown, disabled,
  // or mismatched triggers).
  const captured = await captureBody(req);
  let trigger: WebhookTrigger | undefined;
  let source = 'Unknown';
  try {
    trigger = (await triggerIndex.lookup(triggerId))?.trigger;
    if (trigger) source = (await pluginIndex.lookup(trigger.pluginId))?.displayName ?? trigger.pluginId;
  } catch (err) {
    log.warn('could not resolve receipt source', { correlationId, err });
  }
  const receipt: WebhookReceipt = {
    id: correlationId, receivedAt, updatedAt: receivedAt, serverPid: process.pid, triggerId,
    triggerName: trigger?.name, workflowId: trigger?.workflowId,
    source, sender: senderFromBody(trigger?.pluginId, captured.text),
    state: 'received', body: captured.text,
    bodyTruncated: captured.truncated || undefined,
    bodyUnavailable: captured.unavailable || undefined,
    contentType: req.headers.get('content-type') ?? undefined,
  };
  try {
    createWebhookReceipt(receipt);
  } catch (err) {
    log.error('could not persist webhook receipt', { correlationId, err });
    metrics.recordWebhookRequest('error');
    const failed = NextResponse.json({ error: 'receipt-unavailable' }, { status: 503 });
    failed.headers.set(CORRELATION_HEADER, correlationId);
    return failed;
  }
  let res: Response;
  const decision: { reason?: string } = {};
  try {
    res = await handleWebhook(req, ctx, correlationId, captured, decision);
  } catch (err) {
    metrics.recordWebhookRequest('error');
    try {
      updateWebhookReceipt(correlationId, { state: 'rejected', httpStatus: 500, reason: 'internal-error' });
    } catch (persistErr) {
      log.error('could not settle failed webhook receipt', { correlationId, err: persistErr });
    }
    throw err;
  }
  metrics.recordWebhookRequest(outcomeFromStatus(res.status));
  try {
    updateWebhookReceipt(correlationId, {
      httpStatus: res.status,
      ...(res.status === 204 ? { state: 'ignored' as const, reason: decision.reason ?? 'no-match' } : {}),
      ...(res.status >= 400 ? { state: 'rejected' as const, reason: decision.reason ?? 'request-rejected' } : {}),
    });
  } catch (err) {
    log.error('could not settle webhook receipt', { correlationId, err });
  }
  res.headers.set(CORRELATION_HEADER, correlationId);
  return res;
}

interface CapturedBody { text: string; truncated: boolean; unavailable: boolean }

async function captureBody(req: Request): Promise<CapturedBody> {
  if (!req.body) return { text: '', truncated: false, unavailable: false };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    reader = req.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.byteLength, MAX_BODY_BYTES - size);
      if (take > 0) chunks.push(value.subarray(0, take));
      size += take;
      if (value.byteLength > take) {
        await reader.cancel().catch(() => {});
        return { text: Buffer.concat(chunks).toString('utf8'), truncated: true, unavailable: false };
      }
    }
    return { text: Buffer.concat(chunks).toString('utf8'), truncated: false, unavailable: false };
  } catch {
    return { text: Buffer.concat(chunks).toString('utf8'), truncated: false, unavailable: true };
  } finally {
    reader?.releaseLock();
  }
}

function senderFromBody(pluginId: string | undefined, text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const at = (...keys: string[]): unknown => keys.reduce<unknown>((value, key) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)[key] : undefined, parsed);
    const paths = pluginId === 'github'
      ? [['sender', 'login'], ['pusher', 'name']]
      : pluginId === 'frogo'
        ? [['payload', 'comment', 'author'], ['payload', 'task', 'createdBy']]
        : [['sender', 'login'], ['sender', 'name'], ['sender'], ['from'], ['user', 'login']];
    for (const path of paths) {
      const value = at(...path);
      if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200);
    }
  } catch { /* body is not JSON */ }
  return undefined;
}

async function handleWebhook(
  req: Request,
  { params }: RouteParams,
  correlationId: string,
  captured: CapturedBody,
  decision: { reason?: string },
): Promise<Response> {
  const { triggerId } = await params;
  const withReason = (reason: string, response: Response): Response => {
    decision.reason = reason;
    return response;
  };
  // Bind the correlation id onto every log line from this request.
  const clog = log.child({ correlationId });
  // Set when a trigger with `verifyOptional` accepts an unsigned request —
  // recorded on the eventual `webhook/accepted` audit entry.
  let acceptedUnsigned = false;

  // The wrapper already captured a bounded body. Also honor a declared length
  // above the limit, even when the stream provided fewer bytes.
  const lenHeader = req.headers.get('content-length');
  if (lenHeader) {
    const len = Number.parseInt(lenHeader, 10);
    if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
      return withReason('payload-too-large', NextResponse.json({ error: 'payload-too-large' }, { status: 413 }));
    }
  }
  // A chunked request can exceed the cap without a Content-Length header.
  // The ingress reader has already stopped at the cap, so reject it before
  // looking up a trigger or treating it as a predicate miss.
  if (captured.truncated) {
    return withReason('payload-too-large', NextResponse.json({ error: 'payload-too-large' }, { status: 413 }));
  }

  const hit = await triggerIndex.lookup(triggerId);
  if (!hit) return withReason('not-found', notFound());
  if (!hit.trigger.enabled) return withReason('not-found', notFound());

  // Rate-limit per trigger. Checked here — once the trigger is known to exist
  // and be enabled, before plugin lookup or workflow resolution — so the
  // bucket map stays bounded by the real trigger count.
  const rl = webhookRateLimiter.check(hit.trigger.id);
  if (!rl.ok) {
    clog.warn('rate limit exceeded', { triggerId: hit.trigger.id });
    await recordAudit({
      category: 'webhook',
      action: 'rejected',
      outcome: 'failure',
      actor: 'webhook',
      target: hit.trigger.id,
      correlationId,
      detail: { reason: 'rate-limited', retryAfterSeconds: rl.retryAfterSeconds },
    });
    return withReason('rate-limited', NextResponse.json(
      { error: 'rate-limited' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds) } },
    ));
  }

  const plugin = await pluginIndex.lookup(hit.trigger.pluginId);
  if (!plugin) return withReason('not-found', notFound());
  if (plugin.eventHeader) {
    const header = req.headers.get(plugin.eventHeader);
    if (!header || header !== hit.trigger.eventType) {
      return withReason('event-header-mismatch', new Response(null, { status: 204 }));
    }
  }

  if (captured.unavailable) return withReason('bad-body', NextResponse.json({ error: 'bad-body' }, { status: 400 }));
  const bodyText = captured.text;
  if (bodyText.length > MAX_BODY_BYTES) {
    return withReason('payload-too-large', NextResponse.json({ error: 'payload-too-large' }, { status: 413 }));
  }

  if (plugin.signature) {
    if (hit.trigger.secret) {
      const verdict = verifySignature({
        scheme: plugin.signature.scheme,
        format: plugin.signature.format,
        secret: hit.trigger.secret,
        bodyText,
        headerValue: req.headers.get(plugin.signature.header),
      });
      if (!verdict.ok) {
        clog.error('signature verification failed', {
          triggerId: hit.trigger.id,
          reason: verdict.reason,
        });
        await recordAudit({
          category: 'webhook',
          action: 'rejected',
          outcome: 'failure',
          actor: 'webhook',
          target: hit.trigger.id,
          detail: { reason: 'bad-signature', verifyReason: verdict.reason },
        });
        return withReason('bad-signature', NextResponse.json({ error: 'bad-signature' }, { status: 401 }));
      }
    } else if (hit.trigger.verifyOptional === true) {
      clog.warn('verifyOptional=true — accepting unsigned request', {
        triggerId: hit.trigger.id,
      });
      acceptedUnsigned = true;
    } else {
      clog.error(
        'trigger requires a secret (plugin declares signing) but has neither secret nor verifyOptional set',
        { triggerId: hit.trigger.id, pluginId: plugin.id },
      );
      await recordAudit({
        category: 'webhook',
        action: 'rejected',
        outcome: 'failure',
        actor: 'webhook',
        target: hit.trigger.id,
        correlationId,
        detail: { reason: 'misconfigured' },
      });
      return withReason('trigger-misconfigured', NextResponse.json({ error: 'trigger-misconfigured' }, { status: 500 }));
    }
  }

  let workflow: Workflow;
  try {
    workflow = await getWorkflow(hit.workflowId);
  } catch {
    return withReason('not-found', notFound());
  }
  // Keep the workflow's name at receipt time, even if it is renamed later.
  try {
    updateWebhookReceipt(correlationId, { workflowName: workflow.name });
  } catch (err) {
    clog.error('could not persist webhook workflow identity', { err });
    return withReason('receipt-unavailable', NextResponse.json({ error: 'receipt-unavailable' }, { status: 503 }));
  }

  const scope = buildWebhookScope({
    headers: req.headers,
    url: req.url,
    bodyText,
  });

  if (!matchesAllPredicates(hit.trigger.match, scope)) {
    return withReason('predicate-no-match', new Response(null, { status: 204 }));
  }

  let suppliedInputs: Record<string, string>;
  try {
    suppliedInputs = resolveTriggerInputs(hit.trigger, scope);
  } catch (err) {
    clog.error('inputs resolve failed', { err });
    await recordAudit({
      category: 'webhook',
      action: 'rejected',
      outcome: 'failure',
      actor: 'webhook',
      target: hit.trigger.id,
      correlationId,
      detail: { reason: 'inputs-template-failed' },
    });
    return withReason('inputs-template-failed', NextResponse.json({ error: 'inputs-template-failed' }, { status: 500 }));
  }

  let resolvedInputs;
  try {
    resolvedInputs = resolveRunInputs(workflow.inputs ?? [], suppliedInputs);
  } catch (err) {
    if (err instanceof WorkflowInputError) {
      await recordAudit({
        category: 'webhook',
        action: 'rejected',
        outcome: 'failure',
        actor: 'webhook',
        target: hit.trigger.id,
        correlationId,
        detail: { reason: 'invalid-inputs', field: err.field },
      });
      return withReason('invalid-inputs', NextResponse.json(
        {
          error: 'invalid-inputs',
          field: err.field,
          reason: err.reason,
          ...(err.expected ? { expected: err.expected } : {}),
          ...(err.got ? { got: err.got } : {}),
        },
        { status: 422 },
      ));
    }
    throw err;
  }

  try {
    const { queueId, position } = triggerQueue.enqueue({
      workflow,
      resolvedInputs,
      triggerId,
      correlationId,
      receivedAt: Date.now(),
    });
    void triggerQueue.drain();
    await recordAudit({
      category: 'webhook',
      action: 'accepted',
      outcome: 'success',
      actor: 'webhook',
      target: hit.trigger.id,
      correlationId,
      detail: {
        queueId,
        workflowId: workflow.id,
        ...(acceptedUnsigned ? { unsigned: true } : {}),
      },
    });
    return NextResponse.json(
      { queued: true, queueId, position, correlationId },
      { status: 202 },
    );
  } catch (err) {
    if ((err as { code?: string }).code === 'QUEUE_FULL') {
      await recordAudit({
        category: 'webhook',
        action: 'rejected',
        outcome: 'failure',
        actor: 'webhook',
        target: hit.trigger.id,
        correlationId,
        detail: { reason: 'queue-full' },
      });
      return withReason('queue-full', NextResponse.json(
        { error: 'queue-full' },
        { status: 503, headers: { 'Retry-After': '30' } },
      ));
    }
    throw err;
  }
}

function matchesAllPredicates(match: TriggerPredicate[], scope: Scope): boolean {
  for (const p of match) {
    const lhs = resolveTemplate(p.lhs, scope).text;
    const rhs = resolveTemplate(p.rhs, scope).text;
    const verdict = evaluatePredicate({ lhs, op: p.op, rhs });
    if (!verdict.ok) return false;
    if (verdict.result === false) return false;
  }
  return true;
}

function resolveTriggerInputs(t: WebhookTrigger, scope: Scope): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, tmpl] of Object.entries(t.inputs)) {
    out[k] = resolveTemplate(tmpl, scope).text;
  }
  return out;
}
