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
  the `claude` CLI also reports cost, which the budget phase requires. The
  repo ships [`deploy/Dockerfile.providers`](../deploy/Dockerfile.providers),
  an overlay that bakes `claude` on top of the base image — Phase 0 builds it.
- A **Prometheus + Alertmanager** pair able to scrape an authenticated
  endpoint and evaluate rule files, and a reverse proxy in front of the app.
  The repo ships
  [`deploy/docker-compose.observability.yml`](../deploy/docker-compose.observability.yml) —
  a local overlay that stands all three up, already wired to the app — so
  Phases 1–4 can be driven on a developer machine. Phase 0 brings it up. A
  remote staging deployment may substitute its own equivalents.

## Phases

Run the phases in order — each assumes the previous one passed. Tick the
sign-off checklist at the end as you go, and record each run's results —
per-phase observations, alerts seen, runbook entries validated — in
[`BURN-IN.md`](../BURN-IN.md), so this procedure stays a reusable checklist.

### Phase 0 — Deploy

1. Build the base image, then build-and-start the stack with the provider
   overlay **and the observability overlay** (`INFLOOP_API_TOKEN` must already
   be set in `.env` — see [deployment.md](deployment.md)):

   ```bash
   docker compose build                                   # base image
   docker compose -f docker-compose.yml \
                  -f deploy/docker-compose.burn-in.yml \
                  -f deploy/docker-compose.observability.yml up -d --build
   ```

   The observability overlay adds Prometheus, Alertmanager, and an nginx
   reverse proxy alongside the app — bringing them up here means Phase 0's
   proxy check and all of Phase 1 are wired from the start. See the
   [overlay header](../deploy/docker-compose.observability.yml) for what it
   exposes and on which loopback ports.

   Then confirm the provider CLI is on `PATH` inside the container:
   `docker compose exec infinite-loop which claude`.
2. For the cost and slot phases, set tight limits in `.env` so the bounds
   are reachable in minutes, not hours — e.g. `INFLOOP_MAX_TOTAL_COST_USD`
   to a low dollar figure, a low `maxConcurrentRuns` in settings.
3. Confirm `docker compose ps` shows every service `(healthy)` and the UI
   loads through the reverse proxy at `http://localhost:8080` and accepts the
   token at the login page.

### Phase 1 — Wire observability

The observability overlay brought up in Phase 0 already does the wiring:
[`deploy/prometheus.yml`](../deploy/prometheus.yml) scrapes the authenticated
`/api/metrics` with the bearer token and loads
[`deploy/prometheus-alerts.yml`](../deploy/prometheus-alerts.yml) under
`rule_files:`. This phase *verifies* it took.

1. Open Prometheus at `http://localhost:9090`. Under **Status → Targets**,
   confirm the `infinite-loop` target is **`up`** — a scrape that returns
   `401` (wrong or missing token) reads as down, not as an error.
2. On the **Alerts** page, confirm all ten rules from
   `prometheus-alerts.yml` are listed in the `inactive` state.
3. Confirm `infloop_*` series are queryable and `up{job="infinite-loop"}` is
   `1`. If the job label differs from `infinite-loop`, the scrape config and
   the `InfiniteLoopInstanceDown` rule disagree — fix one. (A remote staging
   deployment running its own Prometheus must reproduce this wiring; see
   [configuration.md](configuration.md#metrics).)

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
| 3.5 | Make the data directory unwritable (`chmod` the volume, or fill the disk) | `/api/health` returns `503 {status:"degraded"}`; `docker compose ps` shows `unhealthy`; `infloop_data_dir_writable` flips to `0`. | `InfiniteLoopDataDirNotWritable` (critical) after 2m. `/api/metrics` keeps scraping `200`, so the alert is driven by the `infloop_data_dir_writable` gauge, not a failed scrape; the Docker healthcheck flips `unhealthy` in parallel. |
| 3.6 | Lower `maxConcurrentRuns`, then push more concurrent runs than slots | Excess runs park waiting for an execution slot; `infloop_slot_pool_waiting > 0`. | `InfiniteLoopSlotPoolSaturated` after 15m of waiting. |
| 3.7 | Set `INFLOOP_MAX_TOTAL_EVENT_BUFFER` low; run event-heavy workflows | Per-run event buffers are squeezed to a fair share — memory stays bounded, per-run history truncates. | `InfiniteLoopEventBufferNearLimit` once the ratio holds above 0.8 for 10m. |
| 3.8 | Force runs to fail repeatedly (point a provider at a missing binary, or run a known-bad workflow) — more than 5, over 50% of settled runs | Runs land in history as `failed`; `infloop_runs_total{status="failed"}` climbs. | `InfiniteLoopHighRunFailureRate` after 15m. |
| 3.9 | Stop the container and leave it down past 2m | Prometheus loses the target. | `InfiniteLoopInstanceDown` (critical) after 2m. |

Row 3.3 (the process-wide cost budget) is *partially* automated — it drives
and checks the `503` admission gate, the mid-run abort, and the spend metrics;
the queued-run-held-on-disk behaviour and the Alertmanager hop are **not**
automated and must be walked by hand. The repo ships
[`deploy/burn-in-driver.ts`](../deploy/burn-in-driver.ts) and the costed probe
workflow [`deploy/burn-in-cost-workflow.json`](../deploy/burn-in-cost-workflow.json):
`bun run burn-in -- --confirm-spend` pre-flights the budget wiring, installs
the probe, then fires costed `claude` runs one at a time — scraping
`infloop_cost_budget_spent_usd` between them — until the admission gate
returns `503`, and prints a Phase 3.3 checklist to paste into
[`BURN-IN.md`](../BURN-IN.md). Run it with `--preflight-only` first to confirm
the wiring without spending; pass `--prometheus <url>` to also check the cost
alert rules. Do not tick the 3.3 box on the driver's checklist alone — finish
the queued-run and Alertmanager checks first.

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

Step 2 is automated. The repo ships
[`deploy/burn-in-soak-watch.ts`](../deploy/burn-in-soak-watch.ts):
`bun run soak-watch -- --duration <h>` samples those gauges on an interval and,
when the window elapses (or on Ctrl-C), prints a Phase 5 drift verdict —
uptime monotonic, the return-to-baseline gauges did not ratchet, RSS flat.
Pass `--docker-container <name>` (host-local only — RSS is not in `/api/metrics`)
to add the container-RSS leak check, and `--out <path>` to log every sample as
JSONL. It is the *observer* only: step 1's steady load is still yours, and an
idle soak passes vacuously — do not tick the box on a watch run with no load.

## Sign-off

The burn-in passes when every box is ticked:

- [ ] Phase 0 — deployed; `(healthy)`; provider CLI present.
- [ ] Phase 1 — all ten alert rules loaded; target `up`.
- [ ] Phase 2 — UI, webhook, and MCP each ran end to end with an audit trail.
- [ ] Phase 3 — every fault produced the expected behaviour; every expected
      alert was observed firing (or its `for:` window understood).
- [ ] Phase 4 — backup taken, volume destroyed, restore verified intact.
- [ ] Phase 5 — 24–72h soak with flat memory and no unexplained restart.
- [ ] [`runbook.md`](runbook.md) has an operator-tested entry for every
      alert.

Only then is the deployment *verified* production-ready, rather than expected
to be.
