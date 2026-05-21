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
 * Webhook ingress. A thin wrapper over `handleWebhook` whose only job is to
 * record one `infloop_webhook_requests_total` sample per request — the inner
 * handler has ~10 return points, so instrumenting the single HTTP status it
 * resolves to is both simpler and exhaustive. An unexpected throw (which
 * Next.js turns into a 500) is recorded as `error` before being rethrown so
 * the framework's error handling still applies.
 */
export async function POST(req: Request, ctx: RouteParams): Promise<Response> {
  // Mint the correlation id at the ingress edge — before any return point — so
  // every audit entry, log line, and (on accept) the queued run share one id.
  // Set on the response header for ALL outcomes, accepted or rejected, so a
  // rejected webhook is still traceable from its caller's side.
  const correlationId = newCorrelationId();
  let res: Response;
  try {
    res = await handleWebhook(req, ctx, correlationId);
  } catch (err) {
    metrics.recordWebhookRequest('error');
    throw err;
  }
  metrics.recordWebhookRequest(outcomeFromStatus(res.status));
  res.headers.set(CORRELATION_HEADER, correlationId);
  return res;
}

async function handleWebhook(
  req: Request,
  { params }: RouteParams,
  correlationId: string,
): Promise<Response> {
  const { triggerId } = await params;
  // Bind the correlation id onto every log line from this request.
  const clog = log.child({ correlationId });
  // Set when a trigger with `verifyOptional` accepts an unsigned request —
  // recorded on the eventual `webhook/accepted` audit entry.
  let acceptedUnsigned = false;

  // Body-size guard via content-length, BEFORE consuming body.
  const lenHeader = req.headers.get('content-length');
  if (lenHeader) {
    const len = Number.parseInt(lenHeader, 10);
    if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'payload-too-large' }, { status: 413 });
    }
  }

  const hit = await triggerIndex.lookup(triggerId);
  if (!hit) return notFound();
  if (!hit.trigger.enabled) return notFound();

  // Rate-limit per trigger. Checked here — once the trigger is known to exist
  // and be enabled, before any plugin lookup or body read — so the bucket map
  // stays bounded by the real trigger count and a flood is rejected cheaply.
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
    return NextResponse.json(
      { error: 'rate-limited' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSeconds) } },
    );
  }

  const plugin = await pluginIndex.lookup(hit.trigger.pluginId);
  if (!plugin) return notFound();
  if (plugin.eventHeader) {
    const header = req.headers.get(plugin.eventHeader);
    if (!header || header !== hit.trigger.eventType) {
      return new Response(null, { status: 204 });
    }
  }

  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    return NextResponse.json({ error: 'bad-body' }, { status: 400 });
  }
  if (bodyText.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload-too-large' }, { status: 413 });
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
        return NextResponse.json({ error: 'bad-signature' }, { status: 401 });
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
      return NextResponse.json({ error: 'trigger-misconfigured' }, { status: 500 });
    }
  }

  let workflow: Workflow;
  try {
    workflow = await getWorkflow(hit.workflowId);
  } catch {
    return notFound();
  }

  const scope = buildWebhookScope({
    headers: req.headers,
    url: req.url,
    bodyText,
  });

  if (!matchesAllPredicates(hit.trigger.match, scope)) {
    return new Response(null, { status: 204 });
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
    return NextResponse.json({ error: 'inputs-template-failed' }, { status: 500 });
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
      return NextResponse.json(
        {
          error: 'invalid-inputs',
          field: err.field,
          reason: err.reason,
          ...(err.expected ? { expected: err.expected } : {}),
          ...(err.got ? { got: err.got } : {}),
        },
        { status: 422 },
      );
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
      return NextResponse.json(
        { error: 'queue-full' },
        { status: 503, headers: { 'Retry-After': '30' } },
      );
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
