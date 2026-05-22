# Production burn-in

Infinite Loop's hardening — crash recovery, the durable trigger queue, the
cost ceilings, the egress allowlist, the audit log, the shipped Prometheus
alerts — is all merged and unit-tested. Unit and E2E tests prove each piece
*in isolation*. They cannot prove the system works **as an operated whole**:
that a `kill -9` is actually reconciled on the real image, that a pre-written
alert actually fires, that a backup actually restores, that nothing leaks
over days of unattended running.

This page is the dress rehearsal that closes that gap. Run it once in a
staging environment before the first real production deployment, and again
after any change to the deployment shape (image, compose file, supervision,
resource limits). It is deliberately destructive — **do not run it against a
deployment holding data you care about.**

Write [`runbook.md`](runbook.md) as you go: every failure you inject here is
an incident an operator will one day see for real, and the burn-in is the one
time you can author the response while watching the real behaviour.

## Prerequisites

- A **staging host** you can deploy to, break, and wipe — never production.
- The deployment artifacts: `Dockerfile`, `docker-compose.yml`, a `.env`
  built from `.env.example`. Follow [deployment.md](deployment.md).
- **At least one real provider CLI baked into the image.** The base image
  ships only the orchestrator (see
  [deployment.md](deployment.md#known-limitation--agent-providers-are-not-in-the-image)).
  The cost and run-failure phases below need a provider that actually runs;
  the `claude` CLI also reports cost, which the budget phase requires.
- A **Prometheus + Alertmanager** pair, or equivalent, able to scrape an
  authenticated endpoint and evaluate rule files.
- A reverse proxy or tunnel in front, as the deployment requires for any
  non-loopback exposure.

## Phases

Run the phases in order — each assumes the previous one passed. Tick the
sign-off checklist at the end as you go.

### Phase 0 — Deploy

1. Deploy per [deployment.md](deployment.md) with `docker compose up -d
   --build`. `INFLOOP_API_TOKEN` is set; the provider CLI is on `PATH`
   inside the container (`docker compose exec infinite-loop which claude`).
2. For the cost and slot phases, set tight limits in `.env` so the bounds
   are reachable in minutes, not hours — e.g. `INFLOOP_MAX_TOTAL_COST_USD`
   to a low dollar figure, a low `maxConcurrentRuns` in settings.
3. Confirm `docker compose ps` shows `(healthy)` and the UI loads behind the
   proxy and accepts the token at the login page.

### Phase 1 — Wire observability

1. Point Prometheus at `/api/metrics` with the bearer token in the scrape
   config (it is **authenticated** — an unauthenticated scrape reads as a
   down target). See [configuration.md](configuration.md#metrics).
2. Load [`deploy/prometheus-alerts.yml`](../deploy/prometheus-alerts.yml)
   under `rule_files:` and confirm all nine rules show up in the Prometheus
   **Alerts** page in the `inactive` state.
3. Confirm `infloop_*` series are present and `up{job="infinite-loop"}` is
   `1`. If the job label differs from `infinite-loop`, fix the scrape config
   or the `InfiniteLoopInstanceDown` rule — they must agree.

A burn-in that injects faults but cannot see the alerts is just breaking
things. Do not proceed until every rule is loaded and the target is `up`.

### Phase 2 — Functional pass

Confirm the three ingress surfaces each enqueue, stream, persist, and audit a
run end to end. After each, check run history (`/api/runs`), the live stream,
and the audit log (`GET /api/audit`).

| Surface | How | Expect |
|---|---|---|
| UI | Trigger a workflow from the canvas | Events stream over SSE; run lands in history; audit `run started`/`finished`. |
| Webhook | `POST /api/webhook/<triggerId>` with a valid signature | `202`; run enqueued and executed; audit `webhook` accept. |
| MCP | Call the enqueue tool over `POST /api/mcp` | Run enqueued and executed. |

### Phase 3 — Failure-injection pass

The core of the burn-in. For each row: inject the fault, confirm the
**behaviour**, then confirm the **alert** fires in Prometheus. Some alerts
have a `for:` window (10–15m) — leave the fault in place long enough, or
note the rule as "fires after N minutes" rather than skipping it. Record the
observed wording so [`runbook.md`](runbook.md) can quote it.

| # | Inject | Expected behaviour | Expected alert |
|---|---|---|---|
| 3.1 | `docker kill -s KILL infinite-loop` mid-run | Container restarts (`restart: unless-stopped`); boot crash recovery reaps the orphaned child and reconciles the interrupted run to `failed` in history with an audit entry. | No alert if the restart is faster than the 2m `for:` — `InfiniteLoopInstanceDown` is a backstop for a *crash loop*. Confirm `process_uptime_seconds` resets. |
| 3.2 | Flood a webhook trigger past the 100-run queue cap (drive deliveries faster than runs drain) | New triggers are dropped once the queue is full; `infloop_queue_dropped_total{reason="queue-full"}` climbs. | `InfiniteLoopTriggerQueueDropping` (immediate); `InfiniteLoopTriggerQueueBacklog` once depth holds above 50 for 10m. |
| 3.3 | Set `INFLOOP_MAX_TOTAL_COST_USD` low; run costed (`claude`) workflows past it | `POST /api/run` → `503`; in-flight runs abort at the next costed node; the queue drain pauses and holds queued runs on disk. | `InfiniteLoopCostBudgetNearLimit` at 80%; `InfiniteLoopCostBudgetExhausted` (critical) once exceeded. |
| 3.4 | Hammer one trigger past `INFLOOP_WEBHOOK_RATE_LIMIT` (default 120/min) | Over-limit deliveries get `429` + `Retry-After`; each rejection is recorded in the audit log; `infloop_webhook_requests_total{outcome="rejected"}` climbs. | `InfiniteLoopWebhookErrorRate` once rejections exceed 30% of webhook traffic for 15m. |
| 3.5 | Make the data directory unwritable (`chmod` the volume, or fill the disk) | `/api/health` returns `503 {status:"degraded"}`; `docker compose ps` shows `unhealthy`. | **No Prometheus alert** — `/api/metrics` may still scrape `200`. Detection is the Docker healthcheck. Note this gap in the runbook. |
| 3.6 | Lower `maxConcurrentRuns`, then push more concurrent runs than slots | Excess runs park waiting for an execution slot; `infloop_slot_pool_waiting > 0`. | `InfiniteLoopSlotPoolSaturated` after 15m of waiting. |
| 3.7 | Set `INFLOOP_MAX_TOTAL_EVENT_BUFFER` low; run event-heavy workflows | Per-run event buffers are squeezed to a fair share — memory stays bounded, per-run history truncates. | `InfiniteLoopEventBufferNearLimit` once the ratio holds above 0.8 for 10m. |
| 3.8 | Force runs to fail repeatedly (point a provider at a missing binary, or run a known-bad workflow) — more than 5, over 50% of settled runs | Runs land in history as `failed`; `infloop_runs_total{status="failed"}` climbs. | `InfiniteLoopHighRunFailureRate` after 15m. |
| 3.9 | Stop the container and leave it down past 2m | Prometheus loses the target. | `InfiniteLoopInstanceDown` (critical) after 2m. |

For each row that fires an alert, follow the matching
[`runbook.md`](runbook.md) entry end to end — this validates the *response*,
not just the detection.

### Phase 4 — Disaster-recovery drill

Prove backup **and restore**, not just backup. A backup never restored is a
guess.

1. With the server running and real state present, take a backup:
   `docker compose exec infinite-loop bun run backup --out /data/backup.tar.gz`
   and copy it off the host.
2. Inspect it: `bun run restore <archive> --inspect` — confirm the manifest
   and an empty `uncoveredPaths`.
3. Simulate volume loss: `docker compose down -v` (this **deletes** the
   volume).
4. Restore into a fresh volume per
   [backup-restore.md](backup-restore.md#restoring-in-docker) and restart.
5. Confirm workflows, run history, triggers, settings, and the audit log are
   all intact and the server is `healthy`.

### Phase 5 — Soak

The one behaviour class with no automated coverage: slow drift over time.

1. Drive a steady, modest load — e.g. an external cron or timer firing a
   webhook trigger every few minutes — for **24–72 hours** unattended.
2. Watch over the window: `event_buffer_events`, `runs_active`,
   `queue_depth`, `slot_pool_*`, container RSS, and
   `process_uptime_seconds`. The gauges should return to baseline between
   runs; RSS should be flat; uptime should climb monotonically (no silent
   restarts).
3. A gauge that ratchets up, RSS that trends up, or an unexplained uptime
   reset is a leak or an instability — file it before going to production.

## Sign-off

The burn-in passes when every box is ticked:

- [ ] Phase 0 — deployed; `(healthy)`; provider CLI present.
- [ ] Phase 1 — all nine alert rules loaded; target `up`.
- [ ] Phase 2 — UI, webhook, and MCP each ran end to end with an audit trail.
- [ ] Phase 3 — every fault produced the expected behaviour; every expected
      alert was observed firing (or its `for:` window understood).
- [ ] Phase 4 — backup taken, volume destroyed, restore verified intact.
- [ ] Phase 5 — 24–72h soak with flat memory and no unexplained restart.
- [ ] [`runbook.md`](runbook.md) has an operator-tested entry for every
      alert and for the unwritable-data-dir case.

Only then is the deployment *verified* production-ready, rather than expected
to be.
