import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { WebhookTrigger, WebhookPlugin } from '../shared/trigger';
import { getWorkflow } from './workflow-store';
import { pluginIndex } from './webhook-plugins';
import { triggerIndex } from './trigger-index';
import { triggersDir } from './paths';
import { createLogger } from './logger';

const log = createLogger('trigger-store');

const TRIGGER_ID_RE = /^[A-Za-z0-9_-]{16,32}$/;
const ALLOWED_OPS = new Set(['==', '!=', 'contains', 'matches']);

function fileFor(id: string): string {
  return path.join(triggersDir(), `${id}.json`);
}

class TriggerNotFoundError extends Error {
  constructor(id: string) {
    super(`trigger not found: ${id}`);
    this.name = 'TriggerNotFoundError';
  }
}

async function validateTrigger(t: Omit<WebhookTrigger, 'createdAt' | 'updatedAt'>): Promise<void> {
  if (typeof t.id !== 'string' || !TRIGGER_ID_RE.test(t.id)) {
    throw new Error(`invalid trigger: id "${t.id}" must match /^[A-Za-z0-9_-]{16,32}$/`);
  }
  if (typeof t.name !== 'string' || t.name.length === 0) {
    throw new Error(`invalid trigger: name must be non-empty`);
  }
  if (typeof t.enabled !== 'boolean') {
    throw new Error(`invalid trigger: enabled must be boolean`);
  }
  if (typeof t.workflowId !== 'string' || t.workflowId.length === 0) {
    throw new Error(`invalid trigger: workflowId must be non-empty`);
  }
  if (typeof t.pluginId !== 'string' || t.pluginId.length === 0) {
    throw new Error(`invalid trigger: pluginId must be non-empty`);
  }

  const plugin = await pluginIndex.lookup(t.pluginId);
  if (!plugin) {
    throw new Error(`invalid trigger: plugin "${t.pluginId}" not found`);
  }
  if (plugin.eventHeader) {
    if (!t.eventType) {
      throw new Error(`invalid trigger: plugin "${plugin.id}" requires eventType`);
    }
    if (!plugin.events.some((e) => e.type === t.eventType)) {
      throw new Error(`invalid trigger: event "${t.eventType}" not declared by plugin "${plugin.id}"`);
    }
  }

  if (!Array.isArray(t.match)) throw new Error(`invalid trigger: match must be array`);
  for (const p of t.match) {
    if (
      !p || typeof p !== 'object' ||
      typeof (p as { lhs: unknown }).lhs !== 'string' ||
      typeof (p as { rhs: unknown }).rhs !== 'string' ||
      !ALLOWED_OPS.has((p as { op: unknown }).op as string)
    ) {
      throw new Error(`invalid trigger: predicate must have string lhs/rhs and valid op`);
    }
  }

  if (!t.inputs || typeof t.inputs !== 'object' || Array.isArray(t.inputs)) {
    throw new Error(`invalid trigger: inputs must be a record`);
  }

  // Workflow check + input-key subset
  let workflow;
  try {
    workflow = await getWorkflow(t.workflowId);
  } catch {
    throw new Error(`invalid trigger: workflow "${t.workflowId}" not found`);
  }
  const declaredNames = new Set((workflow.inputs ?? []).map((i) => i.name));
  for (const key of Object.keys(t.inputs)) {
    if (!declaredNames.has(key)) {
      throw new Error(`invalid trigger: inputs.${key} is not a declared workflow input on "${workflow.id}"`);
    }
    if (typeof (t.inputs as Record<string, unknown>)[key] !== 'string') {
      throw new Error(`invalid trigger: inputs.${key} must be a templated string`);
    }
  }
}

/** Shallow shape guard for a trigger file's parsed content — same role as
 *  run-store's `isRunRecord` and queue-store's `isPersistedQueuedRun`. Checks
 *  the structural fields the webhook-dispatch path dereferences, so a file that
 *  is valid JSON but the wrong shape (an old-schema trigger surfaced by a
 *  backup restore, a hand-edit, a torn write) is rejected on read instead of
 *  detonating later inside dispatch. Deep predicate/input validation stays in
 *  `validateTrigger`, which gates the write path. */
function isWebhookTrigger(v: unknown): v is WebhookTrigger {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return (
    typeof t.id === 'string' &&
    typeof t.name === 'string' &&
    typeof t.enabled === 'boolean' &&
    typeof t.workflowId === 'string' &&
    typeof t.pluginId === 'string' &&
    Array.isArray(t.match) &&
    !!t.inputs &&
    typeof t.inputs === 'object' &&
    !Array.isArray(t.inputs)
  );
}

export async function listTriggers(): Promise<WebhookTrigger[]> {
  const dir = triggersDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const files = entries.filter((e) => e.endsWith('.json') && !e.endsWith('.json.tmp'));
  const out: WebhookTrigger[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(dir, file), 'utf8');
    } catch (err) {
      log.error('failed to read trigger file', { file, err });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      log.error('skipping malformed trigger file (invalid JSON)', { file, err });
      continue;
    }
    if (!isWebhookTrigger(parsed)) {
      log.error('skipping malformed trigger file (invalid shape)', { file });
      continue;
    }
    out.push(parsed);
  }
  return out;
}

export async function getTrigger(id: string): Promise<WebhookTrigger> {
  let raw: string;
  try {
    raw = await fs.readFile(fileFor(id), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new TriggerNotFoundError(id);
    }
    throw err;
  }
  // A file that is unreadable as a valid trigger is treated as not-found —
  // same call as run-store's `getRun`, where `readRunFile` collapses a corrupt
  // file into `null`. The alternative (surfacing a parse/shape error to the
  // caller) just relocates the crash; not-found is a state every caller of
  // getTrigger already handles.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.error('malformed trigger file (invalid JSON)', { id, err });
    throw new TriggerNotFoundError(id);
  }
  if (!isWebhookTrigger(parsed)) {
    log.error('malformed trigger file (invalid shape)', { id });
    throw new TriggerNotFoundError(id);
  }
  return parsed;
}

export async function saveTrigger(
  t: Omit<WebhookTrigger, 'createdAt' | 'updatedAt'> & Partial<Pick<WebhookTrigger, 'createdAt' | 'updatedAt'>>,
): Promise<WebhookTrigger> {
  await validateTrigger(t);

  const dir = triggersDir();
  await fs.mkdir(dir, { recursive: true });

  let existing: WebhookTrigger | null = null;
  try {
    existing = await getTrigger(t.id);
  } catch (err) {
    if (!(err instanceof TriggerNotFoundError)) throw err;
  }

  const now = Date.now();
  const saved: WebhookTrigger = {
    ...t,
    createdAt: existing?.createdAt ?? t.createdAt ?? now,
    updatedAt: now,
    lastFiredAt: existing?.lastFiredAt ?? null,
  };

  const target = fileFor(saved.id);
  await atomicWriteJson(target, saved);

  triggerIndex.invalidate();
  return saved;
}

/** Write `value` as JSON to `target` atomically.
 *
 * Uses a per-call random suffix on the temp file so concurrent writers
 * (and concurrent unlinkers like `deleteTrigger`) can't collide on the
 * same `.tmp` path — a previous bug where two near-simultaneous saves
 * raced via `${target}.tmp` and one rename hit ENOENT when the other
 * cleanup arrived between writeFile and rename. */
async function atomicWriteJson(target: string, value: unknown): Promise<void> {
  const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  try {
    await fs.rename(tmp, target);
  } catch (err) {
    // Best-effort clean up the orphaned temp if rename failed for any reason.
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export async function deleteTrigger(id: string): Promise<void> {
  try {
    await fs.unlink(fileFor(id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new TriggerNotFoundError(id);
    }
    throw err;
  }
  triggerIndex.invalidate();
}

/** Update the `lastFiredAt` timestamp on an existing trigger. Bypasses
 *  `validateTrigger` — this is a hot-path called by the queue on every fire
 *  and the data validity doesn't change. If the file is missing or
 *  unreadable, log and continue (the trigger may have been deleted
 *  mid-flight). */
export async function touchLastFired(id: string, ts: number = Date.now()): Promise<void> {
  let current: WebhookTrigger;
  try {
    current = await getTrigger(id);
  } catch {
    return; // trigger deleted while in queue — best effort
  }
  const updated: WebhookTrigger = { ...current, lastFiredAt: ts };
  try {
    await atomicWriteJson(fileFor(id), updated);
  } catch (err) {
    // Best-effort hot path: swallow file-gone races. EINVAL is here
    // because Darwin surfaces it (not just ENOENT/ENOTDIR) when the
    // parent dir is torn down concurrently — accepts the small Linux
    // risk of masking a real bug in exchange for a quiet hot path.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EINVAL') {
      log.warn('touchLastFired skipped', { triggerId: id, code });
      return;
    }
    throw err;
  }
  triggerIndex.invalidate();
}

export { TriggerNotFoundError };
