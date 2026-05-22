# Operator runbook

What to do when something goes wrong with a deployed Infinite Loop. There is
one entry per alert rule in
[`deploy/prometheus-alerts.yml`](../deploy/prometheus-alerts.yml), plus the
one failure mode Prometheus cannot see.

Infinite Loop runs workflows unattended — webhooks and triggers spawn agent
CLIs that execute code and spend API credits with nobody watching. These
alerts are the "tell a human" half of that bargain; this page is what the
human does next.

Validate every entry against real behaviour during the
[burn-in](burn-in.md) — a runbook step that was never executed is a guess.

## First response

Before drilling into a specific alert, the four places that answer "what is
going on":

| Source | Command |
|---|---|
| Server logs | `docker compose logs -f infinite-loop` |
| Audit log | `curl -H "Authorization: Bearer $INFLOOP_API_TOKEN" 'http://localhost:3000/api/audit?limit=50'` |
| Run history | `curl -H "Authorization: Bearer $INFLOOP_API_TOKEN" http://localhost:3000/api/runs` |
| Live metrics | `curl -H "Authorization: Bearer $INFLOOP_API_TOKEN" http://localhost:3000/api/metrics` |

Liveness, with no token, is `curl http://localhost:3000/api/health`.

Counters and gauges on `/api/metrics` are **process-lifetime** and reset to
`0` on restart — read them as "since the last restart", and check
`infloop_process_uptime_seconds` to know how long that is.

---

## InfiniteLoopInstanceDown — critical

**Means.** Prometheus has not scraped `/api/metrics` for over 2 minutes. The
process is down, crash-looping, or the scrape token is wrong.

**Diagnose.**
- `docker compose ps` — is the container `up`? Is `STATUS` flapping (a
  crash loop)?
- `docker compose logs --tail=200 infinite-loop` — look for an
  `uncaughtException`, a config-validation refusal, or an OOM kill.
- Scrape `/api/metrics` by hand with the token. A `401` means the scrape
  config lost the token — an unauthenticated scrape reads as a down target.
  Fix the scrape config, not the server.

**Resolve.**
- Crash loop on startup → almost always a bad config value; the server
  prints a per-variable explanation and refuses to start. Fix `.env` and
  `docker compose up -d`. See
  [configuration.md](configuration.md#startup-validation).
- OOM kill → see *InfiniteLoopEventBufferNearLimit* and the container
  resource limits in [configuration.md](configuration.md#container-resource-limits).
- Clean exit then restart → boot crash recovery has already reconciled any
  interrupted runs to `failed`. Confirm in run history and move on.

## InfiniteLoopHighRunFailureRate — warning

**Means.** Over the last hour more than 5 runs failed *and* failures are over
half of all settled runs.

**Diagnose.** List recent `failed` runs in history and read their final
events. The usual causes: a provider outage, expired provider credentials, a
bad workflow, or a provider CLI missing from the image.

**Resolve.** Fix the root cause — rotate credentials, correct the workflow,
or bake the missing CLI into the image. The alert clears on its own once the
one-hour failure ratio drops back under 50%.

## InfiniteLoopTriggerQueueDropping — warning

**Means.** Queued runs were dropped before starting. The `reason` label says
which:
- `queue-full` — inbound triggers outpace execution; the 100-run queue cap
  was hit.
- `workflow-deleted` — the workflow was removed while a run sat queued.
- `engine-start-failed` — an unexpected engine error; check the logs.

**Diagnose.** Read the logs around the drop. For `queue-full`, also check
`infloop_queue_depth` and `infloop_slot_pool_*` — the queue is draining too
slowly.

**Resolve.**
- `queue-full` → raise `maxConcurrentRuns` if the host has headroom, or slow
  the trigger source. See *InfiniteLoopTriggerQueueBacklog*.
- `workflow-deleted` → expected if the deletion was intentional; otherwise
  restore the workflow.
- `engine-start-failed` → treat as a bug; capture the logs.

## InfiniteLoopTriggerQueueBacklog — warning

**Means.** More than 50 runs have been waiting in the trigger queue for over
10 minutes. The queue caps at 100; past that, new triggers are dropped
(*InfiniteLoopTriggerQueueDropping*).

**Diagnose.** Triggers are arriving faster than runs complete. Check
`infloop_runs_active`, `infloop_slot_pool_*`, and run durations — is
execution slow, or is the trigger source just loud?

**Resolve.** Raise `maxConcurrentRuns` if CPU and memory allow, or reduce the
trigger rate at the source. There is no way to make slow runs fast from the
runbook — this alert is a capacity signal.

## InfiniteLoopSlotPoolSaturated — warning

**Means.** Runs have been parked over 15 minutes waiting for a
folder-touching execution slot (`infloop_slot_pool_waiting > 0`).

**Diagnose.** Concurrency demand exceeds `maxConcurrentRuns`. Check
`infloop_slot_pool_in_use` against `infloop_slot_pool_capacity`.

**Resolve.** Raise `maxConcurrentRuns` in settings **only if the host has
the CPU and memory headroom** — each concurrent run spawns an agent
subprocess tree. Otherwise this is back-pressure working as designed; reduce
the inbound rate instead.

## InfiniteLoopEventBufferNearLimit — warning

**Means.** Workflow events buffered in memory have held above 80% of the
process-wide ceiling (`INFLOOP_MAX_TOTAL_EVENT_BUFFER`, default 200000) for
10 minutes.

**Diagnose.** The buffer is fair-shared across runs, so it **cannot OOM the
process** — but sustained pressure means per-run event history is being
truncated. Check `infloop_runs_active`: many concurrent, event-heavy runs is
the usual cause.

**Resolve.** Reduce concurrency, or raise `INFLOOP_MAX_TOTAL_EVENT_BUFFER` if
the container has memory headroom (mind `INFLOOP_MEM_LIMIT` — see
[configuration.md](configuration.md#container-resource-limits)). If buffer
pressure coincides with the container being OOM-killed, the agent
*children*, not the buffer, are the memory hog — lower concurrency.

## InfiniteLoopCostBudgetNearLimit — warning

**Means.** Cumulative provider cost since startup has passed 80% of
`INFLOOP_MAX_TOTAL_COST_USD`. At 100%, new runs are refused.

**Diagnose.** Read `infloop_cost_budget_spent_usd` vs.
`infloop_cost_budget_limit_usd`. Expected, or a runaway? Check run history
for an unexpected burst.

**Resolve.** If spend is legitimate, raise `INFLOOP_MAX_TOTAL_COST_USD` (a
restart resets the in-memory total) or accept that runs will soon pause. If
not, find and disable the offending trigger or workflow **before** the
budget is exhausted.

## InfiniteLoopCostBudgetExhausted — critical

**Means.** Cumulative provider cost has passed `INFLOOP_MAX_TOTAL_COST_USD`.
New runs are refused with `503`, in-flight runs abort at their next costed
node, and the trigger-queue drain is paused — queued runs are held intact on
disk and resume after a restart.

**Diagnose.** This is the cost ceiling doing its job. The only question is
*why* — confirm whether the spend was a runaway workflow or genuine demand.

**Resolve.**
- Runaway → fix or disable the offending workflow/trigger first, then
  restart to reset the process-lifetime total and resume held runs.
- Genuine demand → raise `INFLOOP_MAX_TOTAL_COST_USD` in `.env` and restart.
- Either way, until you restart or raise the limit, the deployment will not
  start new runs. The held queue is safe — it is on disk.

## InfiniteLoopWebhookErrorRate — warning

**Means.** Over 30% of webhook deliveries in the last 15 minutes ended in
`error` or `rejected`.

**Diagnose.** Check the audit log for `webhook` reject entries and the logs
for errors. Usual causes: a bad or rotated signature secret, a misconfigured
plugin, or a caller hitting the per-trigger rate limit
(`INFLOOP_WEBHOOK_RATE_LIMIT`, default 120/min → `429`).

**Resolve.**
- Bad signature → re-sync the shared secret with the caller.
- Rate limit → if the caller is legitimate, raise
  `INFLOOP_WEBHOOK_RATE_LIMIT`; if not, the limit is doing its job — the
  leaked or abused URL should be rotated by recreating the trigger.
- Plugin error → check the plugin manifest and the logs.

---

## Data directory not writable (no Prometheus alert)

**Means.** `/api/health` returns `503 {status:"degraded"}` and
`docker compose ps` shows the container `unhealthy`. The process is alive but
cannot persist runs, triggers, or the audit log.

This failure has **no Prometheus alert** — `/api/metrics` may still scrape
`200` while the data directory is unwritable. It is caught only by the Docker
healthcheck. Wire the `unhealthy` state to your orchestrator or an external
uptime check if you need to be paged on it.

**Diagnose.** Inside the container, the data directory is `/data`. Check:
- Disk full on the volume (`df -h`).
- Permissions on the volume mount — the container runs as a non-root user.
- The volume failing to mount at all.

**Resolve.** Free space, fix the mount permissions, or replace the volume and
restore from backup ([backup-restore.md](backup-restore.md)). The server
recovers on its own once the directory is writable again — no restart needed,
though a restart does no harm.

---

## Routine procedures

| Task | How |
|---|---|
| Restart | `docker compose restart infinite-loop` (boot crash recovery runs on the way up) |
| Update | `git pull && docker compose up -d --build` — the data volume is untouched |
| Take a backup | See [backup-restore.md](backup-restore.md#creating-a-backup) |
| Restore | Stop the server first — [backup-restore.md](backup-restore.md#restoring) |
| Stop and **wipe** all state | `docker compose down -v` (deletes the volume) |

A restart resets every process-lifetime counter on `/api/metrics` and the
in-memory cost-budget total; it does **not** touch persisted state on the
data volume.
