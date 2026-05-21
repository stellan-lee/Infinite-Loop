import { NextResponse } from 'next/server';
import { describeActor, requireAuth } from '@/lib/server/auth';
import { recordAudit } from '@/lib/server/audit-log';
import { pluginIndex } from '@/lib/server/webhook-plugins/index';
import { validateTriggerAgainstPlugin } from '@/lib/server/trigger-validation';
import {
  getTrigger,
  saveTrigger,
  deleteTrigger,
  TriggerNotFoundError,
} from '@/lib/server/trigger-store';
import type { WebhookTrigger } from '@/lib/shared/trigger';

interface RouteParams {
  params: Promise<{ id: string }>;
}

function notFound() {
  return NextResponse.json({ error: 'not-found' }, { status: 404 });
}

export async function GET(req: Request, { params }: RouteParams): Promise<Response> {
  const unauth = requireAuth(req);
  if (unauth) return unauth;
  const { id } = await params;
  try {
    const trigger = await getTrigger(id);
    return NextResponse.json({ trigger });
  } catch (err) {
    if (err instanceof TriggerNotFoundError) return notFound();
    throw err;
  }
}

export async function PUT(req: Request, { params }: RouteParams): Promise<Response> {
  const unauth = requireAuth(req);
  if (unauth) return unauth;
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const payload = body as Partial<WebhookTrigger>;
  if (payload.id !== undefined && payload.id !== id) {
    return NextResponse.json(
      { error: 'invalid-trigger', reason: 'id cannot be changed; create a new trigger instead' },
      { status: 400 },
    );
  }
  try {
    // Confirms the trigger exists; getTrigger throws TriggerNotFoundError if not.
    await getTrigger(id);
    const draft: Omit<WebhookTrigger, 'createdAt' | 'updatedAt'> = {
      id,
      name: typeof payload.name === 'string' ? payload.name : '',
      enabled: typeof payload.enabled === 'boolean' ? payload.enabled : true,
      workflowId: typeof payload.workflowId === 'string' ? payload.workflowId : '',
      pluginId: typeof payload.pluginId === 'string' ? payload.pluginId : '',
      eventType: typeof payload.eventType === 'string' ? payload.eventType : undefined,
      match: Array.isArray(payload.match) ? payload.match : [],
      inputs: payload.inputs && typeof payload.inputs === 'object' && !Array.isArray(payload.inputs)
        ? (payload.inputs as Record<string, string>)
        : {},
      secret: typeof payload.secret === 'string' ? payload.secret : undefined,
      verifyOptional: payload.verifyOptional === true ? true : undefined,
    };

    const plugin = await pluginIndex.lookup(draft.pluginId);
    if (plugin) {
      const v = validateTriggerAgainstPlugin(draft, plugin);
      if (!v.ok) {
        return NextResponse.json(
          { error: 'invalid-trigger', reason: v.reason },
          { status: 400 },
        );
      }
    }

    const saved = await saveTrigger(draft);
    await recordAudit({
      category: 'trigger',
      action: 'updated',
      outcome: 'success',
      actor: describeActor(req),
      target: saved.id,
      detail: {
        name: saved.name,
        workflowId: saved.workflowId,
        enabled: saved.enabled,
      },
    });
    return NextResponse.json({ trigger: saved });
  } catch (err) {
    if (err instanceof TriggerNotFoundError) return notFound();
    return NextResponse.json(
      { error: 'invalid-trigger', reason: (err as Error).message },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request, { params }: RouteParams): Promise<Response> {
  const unauth = requireAuth(req);
  if (unauth) return unauth;
  const { id } = await params;
  try {
    await deleteTrigger(id);
    await recordAudit({
      category: 'trigger',
      action: 'deleted',
      outcome: 'success',
      actor: describeActor(req),
      target: id,
    });
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof TriggerNotFoundError) return notFound();
    throw err;
  }
}
