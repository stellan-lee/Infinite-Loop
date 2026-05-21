# Audit Log

**Status:** Design
**Author:** rhoninlee (with Claude)

## Problem

Infinite Loop is an unattended tool that executes arbitrary code and spends
real API credits, frequently triggered by webhooks and MCP when nobody is
watching the console. The documented deployment model fronts the app with a
proxy (Cloudflare Access / Tailscale / reverse proxy) — that layer supplies
per-user identity, HTTP rate limiting, and access logs.

What the proxy can *never* supply is app-level knowledge: which workflow ran,
which trigger was created / edited / deleted, which login attempt succeeded or
failed, which webhook fired and was accepted or rejected. Only the app knows
that, and today it keeps no durable, queryable record of it.

Run history (`run-store`) is **not** a substitute:

- It is capped at 100 records per workflow and silently pruned — fine for a
  transcript, disqualifying for an audit trail.
- It captures nothing *outside* a run: auth attempts, trigger CRUD, rejected
  webhooks all happen with no run and leave no trace.

An autonomous, code-executing, money-spending tool with no durable account of
its own actions is the single biggest trust gap left before 1.0.

## Goal

A durable, append-only audit log that records security- and trust-relevant
events the moment they happen, survives restarts, is not pruned to a tiny
window, and is readable back through an authenticated API.

## Non-goals

- Per-user identity. Single-tenant shared-token auth is a deliberate design
  choice; the proxy supplies real user identity. The audit log records a
  *coarse* actor (`api-token` / `browser-session` / `webhook` / `system` /
  `open`), not a person.
- Tamper-proofing (hash chaining, signing, append-only filesystem flags). The
  log is a local file with the same trust boundary as the rest of the data
  dir; a local attacker who can edit it can already edit everything else.
- A UI. An authenticated `GET /api/audit` endpoint is the deliverable;
  rendering it in the console is a follow-up.
- Webhook-ingress rate limiting, release discipline, in-app accounts — tracked
  separately as lower-priority follow-ups.

## Events captured

| Category  | Action               | Outcome           | When |
|-----------|----------------------|-------------------|------|
| `run`     | `started`            | `info`            | a run begins |
| `run`     | `finished`           | `success`/`failure`/`info` | a run settles (incl. crash-recovered) |
| `auth`    | `login`              | `success`/`failure` | `POST /api/auth` while auth is enabled |
| `auth`    | `logout`             | `info`            | `DELETE /api/auth` while auth is enabled |
| `trigger` | `created`/`updated`/`deleted` | `success` | trigger CRUD via the API |
| `webhook` | `accepted`           | `success`         | a webhook is queued for a real, enabled trigger |
| `webhook` | `rejected`           | `failure`         | a webhook reaches a real trigger but is refused |

Deliberately **not** audited: webhook 404s (unknown/disabled trigger — random
internet scanning would flood the log) and 204s (event-type or predicate
filtering — normal high-volume operation). A malformed body (`400`) or an
oversized payload (`413`) is likewise skipped — these are pre-validation
noise, and an over-`content-length` request is rejected before the trigger is
even known. Failed trigger *validation* (a `400`) is a user error, not a
security event, so only successful trigger CRUD is recorded; failed *auth* is
recorded because it is a security signal.

## Entry schema

```ts
type AuditCategory = 'run' | 'auth' | 'trigger' | 'webhook';
type AuditOutcome  = 'success' | 'failure' | 'info';

interface AuditEntry {
  ts: string;          // ISO 8601, stamped by recordAudit
  category: AuditCategory;
  action: string;
  outcome: AuditOutcome;
  actor?: string;      // 'api-token' | 'browser-session' | 'webhook' | 'system' | 'open'
  target?: string;     // affected resource id (runId / triggerId)
  detail?: Record<string, unknown>;  // small structured payload, never secrets
}
```

`recordAudit` accepts the entry without `ts` and stamps it.

**Secrets never enter the log.** Auth entries record outcome only, never the
submitted token. Trigger entries record id / name / workflowId / enabled,
never `secret`. Webhook entries record triggerId / reason / queueId, never the
request body, headers, or trigger secret.

## Storage and rotation

One JSON object per line (JSONL) — append-only, greppable, and consistent
with the structured logger's existing "one JSON object per line" format.

- Directory: `auditDir()` = `<dataDir>/audit`, added to `paths.ts`. It derives
  from `dataDir()` with no separate env var — exactly like `pidsDir()` /
  `activeRunsDir()` — so the standard `INFLOOP_DATA_DIR` test override (and the
  global test preload) isolate it for free.
- Current file: `audit/audit.jsonl`. Rotated generations: `audit.1.jsonl` …
  `audit.N.jsonl` (newest rotation is `.1`).
- Rotation is size-based, checked before each append: when the current file
  would exceed `INFLOOP_AUDIT_MAX_BYTES` (default 5 MB), generations shift
  down, the oldest beyond `INFLOOP_AUDIT_MAX_FILES` (default 5, min 1) is
  dropped, and a fresh `audit.jsonl` is started. Worst case ≈ 30 MB of
  history — generous and bounded, vs. run-history's 100-entry cap.

This is "not pruned to a tiny window": months of events for a typical
deployment, with a hard disk-usage ceiling.

## Concurrency and durability

All writes go through one module and are serialized through an in-process
promise chain (`tail`). The rotation check and the append are one atomic link
in that chain (a single `writeEntry`), so lines never interleave and a queued
append can never slip into the middle of a rotation. A second instance
(port-fallback) is a tolerated edge: each line is small and written with
`O_APPEND` (`fs.appendFile`), which the OS appends atomically, so individual
lines stay intact even across processes; only a rotation racing a second
instance could lose a few lines — the same best-effort class as run markers.
`listAuditEntries` reads *outside* the `tail` chain (a pure read needs no
serialization); a read concurrent with an append is expected and absorbed by
the torn-line tolerance.

`recordAudit` is **best-effort and never throws / never rejects.** Audit
logging must never break a request or a run; on any failure it logs through
the structured logger and resolves.

- **Route handlers `await recordAudit(...)`** before returning their
  `Response`. A promise left dangling after `return` is not guaranteed to run
  to completion; `await` is safe because `recordAudit` never throws and a
  serialized append is sub-millisecond at audit-event volume.
- **The run-controller hooks call it fire-and-forget (`void`)** — they run
  inside the long-lived engine lifetime, not a request that is about to
  return, and must not be slowed by a disk write.

A `flushAudit()` drains the pending chain — used by tests (awaited before any
read-back assertion, since `tail` is a module-level singleton shared across
`bun test` files) and available for graceful shutdown.

Env vars (`INFLOOP_AUDIT_MAX_BYTES`, `INFLOOP_AUDIT_MAX_FILES`) are read
per-call, matching `historyLimit()` and the logger's `threshold()`.

A single line is capped (`MAX_LINE_BYTES`, 8 KB); an oversized `detail` is
replaced with `{ _truncated: true }` so one pathological entry cannot bloat
the file or tear across the atomic-append boundary.

## API

`GET /api/audit` — authenticated (`requireAuth`), `force-dynamic`. Returns
recent entries newest-first: `{ entries: AuditEntry[] }`. Optional `?limit=`
clamped to `[1, 2000]`, default 200. `listAuditEntries` reads the current file
then rotated generations only as far back as `limit` requires, tolerating
torn / unparseable lines by skipping them (same posture as `run-store`).

This is gated, unlike `/api/health`: audit data is operational detail and a
reconnaissance signal, so it must not answer unauthenticated.

## Affected files

New:
- `lib/server/audit-log.ts` — `recordAudit`, `listAuditEntries`, `flushAudit`,
  types, rotation.
- `lib/server/audit-log.test.ts`
- `app/api/audit/route.ts` + `route.test.ts`

Modified:
- `lib/server/paths.ts` — add `auditDir()`.
- `lib/server/auth.ts` — add `describeActor(req)` returning
  `api-token | browser-session | open`. The `webhook` and `system` actors are
  passed as literals at their single static call sites, not inferred.
- `lib/server/run-controller.ts` — audit `run/started` in `start()`, audit
  `run/finished` in `persistRun()` (fired regardless of whether the history
  `saveRun` succeeds — audit must survive a failed history write).
- `lib/server/crash-recovery.ts` — audit `run/finished` (`crash-recovered`)
  for each leftover marker reconciled, after its `saveRun` succeeds.
- `app/api/auth/route.ts` — audit login success/failure and logout.
- `app/api/triggers/route.ts` — audit `trigger/created`.
- `app/api/triggers/[id]/route.ts` — audit `trigger/updated`, `trigger/deleted`.
- `app/api/webhook/[triggerId]/route.ts` — audit `webhook/accepted` and the
  meaningful `webhook/rejected` reasons (bad-signature, queue-full,
  misconfigured, invalid-inputs, inputs-template-failed).
- Existing tests for the hooked routes — add audit assertions.
- `README.md`, `docs/security.md`, `docs/configuration.md` — document it.

## Edge cases / risks

- Audit failure must never surface to a caller — covered by the never-throw
  contract and a structured-logger fallback.
- Torn lines on read — skipped, like `run-store`.
- Oversized `detail` — truncated.
- Cross-test interference: hook-site tests share the preload's temp data dir,
  so they assert "an entry matching X exists among recent entries" rather than
  exact-equality; the module and endpoint tests set a fresh `INFLOOP_DATA_DIR`
  per test for clean-slate assertions.
- A run that crashes leaves a `run/started` with no `run/finished`; the
  crash-recovery hook closes that gap on the next boot.

## Validation plan

- `audit-log.test.ts` — append/read round-trip, `ts` stamping, newest-first
  ordering, serialized non-interleaving under concurrent writes, size-based
  rotation, generation cap, cross-rotation reads, `limit` handling, torn-line
  tolerance, oversized-detail truncation, never-throws on an unwritable dir.
- `app/api/audit/route.test.ts` — 401 unauthenticated when gated, 200 + entries
  when authed, `limit` clamping, open-mode access.
- Audit assertions added to the auth / trigger / webhook / run-lifecycle
  tests confirming each hook fires with the right category/action/outcome.
- `bun test` (full suite) + `tsc --noEmit`.
