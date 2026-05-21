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
import { createLogger } from '@/lib/server/logger';
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

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  const { triggerId } = await params;
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
        log.error('signature verification failed', {
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
      log.warn('verifyOptional=true — accepting unsigned request', {
        triggerId: hit.trigger.id,
      });
      acceptedUnsigned = true;
    } else {
      log.error(
        'trigger requires a secret (plugin declares signing) but has neither secret nor verifyOptional set',
        { triggerId: hit.trigger.id, pluginId: plugin.id },
      );
      await recordAudit({
        category: 'webhook',
        action: 'rejected',
        outcome: 'failure',
        actor: 'webhook',
        target: hit.trigger.id,
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
    log.error('inputs resolve failed', { err });
    await recordAudit({
      category: 'webhook',
      action: 'rejected',
      outcome: 'failure',
      actor: 'webhook',
      target: hit.trigger.id,
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
      receivedAt: Date.now(),
    });
    void triggerQueue.drain();
    await recordAudit({
      category: 'webhook',
      action: 'accepted',
      outcome: 'success',
      actor: 'webhook',
      target: hit.trigger.id,
      detail: {
        queueId,
        workflowId: workflow.id,
        ...(acceptedUnsigned ? { unsigned: true } : {}),
      },
    });
    return NextResponse.json(
      { queued: true, queueId, position },
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
