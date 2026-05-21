# Correlation IDs — end-to-end run traceability

**Status:** Implemented
**Author:** rhoninlee (with Claude)

## Problem

Infinite Loop runs workflows unattended — started by webhooks, MCP, or the
browser. When a webhook-triggered run fails, an operator today cannot walk the
chain that produced it:

- the webhook accept is audited under `target = triggerId`;
- the trigger queue tracks the item under `queueId` + `triggerId`;
- the run is audited and persisted under `runId`.

Nothing connects those three identities. The webhook ack does not name the
queue item; the queue item does not name the run; the run does not name the
webhook. Structured logs carry `runId` on some lines and nothing on others.

The keystone fix is one **correlation id** generated at ingress and threaded
through every stage the ingress event causes — so `audit.jsonl`, the run
history record, the SSE event stream, and the structured logs can all be
joined on a single value.

## Non-goals

- Per-request ids for *every* route (a `GET /api/runs` list call gains nothing
  from a trace id). The id is generated only at the three ingress points that
  create durable run work.
- Accepting an inbound `x-correlation-id` from callers. Webhook ingress is
  untrusted; echoing a caller-supplied string into our logs is a log-injection
  vector. The id is always minted server-side and *returned* to the caller.
- Pushing the id into provider child-process environments. A run's provider
  calls are already observable through its `node_started` / `stdout_chunk` /
  `node_finished` events, which carry the correlation id via emit-stamping.
- A `?correlationId=` query filter on `/api/audit`. The field is present and
  greppable; a dedicated filter endpoint is a natural follow-up, not part of
  the keystone.

## Design

### The primitive

`lib/server/correlation.ts` exports:

- `newCorrelationId(): string` — `cid_` + 18 random bytes base64url. The
  `cid_` prefix makes the value recognizable at a glance in a log line or an
  HTTP header.
- `CORRELATION_HEADER = 'x-correlation-id'` — the response header the three
  ingress routes set so an operator sees the id without parsing the body.

### Where it is generated

At the three ingress points that start run work:

| Ingress | Action |
|---|---|
| `POST /api/run` | mint id → pass to `engineStartAdapter` → return in body + header |
| `POST /api/webhook/[triggerId]` | mint id → pass to `enqueue` → stamp on every `webhook/*` audit entry → return in body + header |
| MCP `enqueueWorkflowTool` | mint id → pass to `enqueue` → return in result |

### How it threads

```
ingress ──correlationId──▶ TriggerQueue (QueuedRun.correlationId, persisted)
                                  │
                                  ▼
                          engineStart(wf, { resolvedInputs, correlationId })
                                  │
                                  ▼
                          WorkflowEngine.startRun(wf, { correlationId })
                                  │
                                  ▼
                          RunController.correlationId
                            ├─ emit() stamps every run event
                            ├─ recordAudit() on run/started + run/finished
                            ├─ saveRun() → RunRecord.correlationId
                            └─ writeRunMarker() → RunMarker.correlationId
```

`/api/run` skips the queue and calls `engineStartAdapter` directly; it passes
the correlation id the same way.

### Field placement

- **`QueuedRun.correlationId: string`** — required. A queued run without a
  correlation id is meaningless for tracing. `enqueue()` accepts it optionally
  and mints one when the caller omits it (keeps internal callers/tests simple).
  Persisted to disk by `queue-store.ts`; the type guard treats it as optional
  for back-compat, and `crash-recovery.reconcileQueuedRuns` backfills a fresh
  id for any pre-upgrade file that lacks one.
- **Events** — `correlationId?: string` on every `WorkflowEvent` member,
  optional exactly as `runId?` is: it is stamped by `RunController.emit()` (run
  events) or set explicitly at the `eventBus.emit` call site (trigger events),
  never by the literal at an `emit()` argument.
- **`AuditEntry.correlationId?: string`** — optional top-level field, parallel
  to `target`. Optional so pre-upgrade `audit.jsonl` lines still validate.
- **`RunRecord.correlationId?` / `RunSummary.correlationId?`** — optional;
  absent on records written before this change, like `nodeCount` / `costUsd`.
- **`RunMarker.correlationId?`** — optional; carried so a crash-recovered
  `failed` record keeps the trace link (a crash *is* a run failure — exactly
  the case the operator most needs to trace).
- **`RunController.correlationId: string`** — required; `deps.correlationId ??
  newCorrelationId()`, so a controller built without one (unit tests) still
  has a stable value rather than `undefined`.

### Logging

`lib/server/logger.ts` gains `Logger.child(boundFields)` — the standard
structured-logger child pattern (pino/bunyan/winston). It returns a logger
that merges `boundFields` into every line; per-call `fields` win over bound
fields, reserved keys are still dropped. This is the root-cause fix for "logs
are threaded unevenly": ingress and run paths bind `{ correlationId }` once
(`log.child({ correlationId })`) instead of remembering to pass it per call.

### Compatibility

- All new fields are optional on the disk/wire shapes and on every type guard,
  so a server upgraded over an existing data directory reads old audit lines,
  old run records, and old persisted queue files without loss.
- Event `correlationId` mirrors `runId` (optional, stamped) — no `emit()` call
  site changes its literal.
- `enqueue()`'s input type makes `correlationId` optional, so existing callers
  and tests that omit it still compile; `restore()` requires it (crash-recovery
  backfills before calling).

## Affected files

New: `lib/server/correlation.ts` (+ test); `specs/correlation-id.md`.

Modified: `lib/server/logger.ts`, `lib/shared/workflow.ts`,
`lib/server/audit-log.ts`, `lib/server/trigger-queue.ts`,
`lib/server/trigger-queue-singleton.ts`, `lib/server/workflow-engine.ts`,
`lib/server/run-controller.ts`, `lib/server/run-store.ts`,
`lib/server/queue-history.ts`, `lib/server/crash-recovery.ts`,
`app/api/run/route.ts`, `app/api/webhook/[triggerId]/route.ts`,
`lib/server/mcp/enqueue-tool.ts`.

`lib/server/queue-store.ts` is intentionally untouched: `QueuedRun.correlationId`
rides through its plain `JSON.stringify`/`JSON.parse`, and `isPersistedQueuedRun`
stays lenient so pre-upgrade files still validate (the backfill covers them).

## Implementation notes (from design review)

These points are load-bearing — the design review flagged them as easy to miss:

- **Queue events carry the id.** All four trigger events (`trigger_enqueued`,
  `trigger_started`, `trigger_dropped`, `trigger_removed`) and
  `QueueHistoryEntry` carry `correlationId`, so the live queue UI / SSE stream
  is not a blind spot in the webhook → **queue item** → run chain.
- **`startRun` opts split.** `correlationId` must reach `RunController` through
  the **constructor `RunControllerDeps`**, not `controller.start(opts)` —
  `emit()` and `writeRunMarker()` run inside `start()` and need it already set.
  `WorkflowEngine.startRun` therefore routes `correlationId` to
  `new RunController({...})` and `resolvedInputs` to `start({resolvedInputs})`.
  `TriggerQueueDeps.engineStart` and `engineStartAdapter` both gain the opt.
- **Crash-recovery backfill is type-soundness-critical.** `QueuedRun.correlationId`
  is a required `string`, but `isPersistedQueuedRun` does not check it (so old
  files still validate). The field reconstruction in
  `crash-recovery.reconcileQueuedRuns` MUST do
  `correlationId: item.correlationId ?? newCorrelationId()` — that line is what
  keeps the required type sound against a pre-upgrade file.
- **`reconcileInterruptedRuns` must surface it.** Its `saveRun(...)` and the
  `run/finished` `recordAudit(...)` both pass `correlationId: m.correlationId`,
  or the carried `RunMarker.correlationId` is dead weight in the exact
  crash-trace case this feature targets.
- `correlationId?` is added to *every* `WorkflowEvent` union member so
  `RunController.emit()`'s `as WorkflowEvent` stamp has no excess-property
  mismatch. A persisted `RunRecord` ends up with `correlationId` both
  top-level and on each buffered event — redundant but harmless.

## Validation

- Unit: `correlation.test.ts` (format, uniqueness); `logger.test.ts` extended
  for `child()`; `trigger-queue` enqueue mints/preserves; `run-controller`
  stamps every event + threads to audit/record; `audit-log` round-trips the
  field; `crash-recovery` backfills a pre-upgrade queue file.
- Full `bun test` + `tsc --noEmit` green.
- Result check: a webhook → run trace shares one `cid_…` across the webhook
  audit entry, the queue events, the run events, the run audit entries, and the
  persisted `RunRecord`.
