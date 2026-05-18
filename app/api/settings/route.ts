import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/server/auth';
import { loadSettings, saveSettings, effectiveMaxConcurrentRuns } from '@/lib/server/settings-store';
import { workflowEngine } from '@/lib/server/workflow-engine';

/**
 * Settings endpoint. Envelope shape `{ settings: { ... } }` so future knobs
 * don't force a v2 route.
 *
 *   GET  /api/settings              → { settings: { maxConcurrentRuns } }
 *   PUT  /api/settings              ← { settings: { maxConcurrentRuns } }
 *
 * The PUT is serialized via an async mutex inside saveSettings so two
 * simultaneous writes cannot leave in-memory and on-disk state divergent.
 * After persistence, the slot pool's live capacity is reconfigured: raising
 * the cap admits queued waiters immediately, lowering does not preempt
 * current holders.
 */
export async function GET(req: Request) {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  const persisted = await loadSettings();
  const effective = await effectiveMaxConcurrentRuns();

  return NextResponse.json(
    {
      settings: {
        maxConcurrentRuns: persisted.maxConcurrentRuns,
      },
      effective: {
        maxConcurrentRuns: effective,
      },
    },
    { status: 200 },
  );
}

export async function PUT(req: Request) {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (!body || typeof body !== 'object' || !(body as Record<string, unknown>).settings) {
    return NextResponse.json(
      { error: 'body must be { settings: { ... } }' },
      { status: 400 },
    );
  }

  const incoming = (body as { settings: Record<string, unknown> }).settings;
  const max = incoming.maxConcurrentRuns;
  if (max !== undefined) {
    if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0 || max !== Math.floor(max)) {
      return NextResponse.json(
        { error: 'maxConcurrentRuns must be a positive integer' },
        { status: 400 },
      );
    }
  }

  try {
    await saveSettings({
      ...(max !== undefined ? { maxConcurrentRuns: max } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to save settings';
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // Live reconfigure: re-resolve effective capacity (the new persisted value
  // wins over the env default) and push it into the slot pool.
  const effective = await effectiveMaxConcurrentRuns();
  workflowEngine.slotPool.setCapacity(effective);

  return NextResponse.json(
    {
      settings: { maxConcurrentRuns: max },
      effective: { maxConcurrentRuns: effective },
    },
    { status: 200 },
  );
}
