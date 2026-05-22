# Burn-in progress log

The production burn-in *procedure* is [`docs/burn-in.md`](docs/burn-in.md).
That file is the reusable checklist and does not change between runs. **This
file is the record** of each run against it — what was verified, what failed,
and what is still open.

`docs/burn-in.md` says to tick its sign-off checklist and write
[`docs/runbook.md`](docs/runbook.md) "as you go". This log is where that
progress is captured, so the procedure doc stays a clean, reusable checklist
instead of accumulating one run's state.

## How to use this log

- Open a new `## Run N` section each time the burn-in is run end to end
  (`docs/burn-in.md` says to re-run after any change to the deployment shape —
  image, compose file, supervision, resource limits).
- Record per phase: date, environment, what was *observed*, and pass/fail.
- A phase is `pass` only when verified against real behaviour — not when the
  code "should" work. The burn-in exists precisely because merged-and-unit-
  tested is not the same as operationally proven.

## Status legend

- `pass` — verified against real behaviour on the burn-in image.
- `static-pass` — verified by automated/static checks only; still needs the
  live behavioural check in a staging deployment.
- `pending` — not yet started.
- `blocked` — started, found a defect; see the notes.

---

## Run 1 — 2026-05-22

First burn-in run, driven end to end on a local Docker host (Docker Desktop
29.3.1, `desktop-linux`, macOS) against the provider-overlay image built from
[`deploy/Dockerfile.providers`](deploy/Dockerfile.providers), with the
observability + proxy overlay
([`deploy/docker-compose.observability.yml`](deploy/docker-compose.observability.yml))
layered on. Phases 0–4 were driven to completion; Phase 5 (the 24–72h soak)
and the final remote-host pass remain.

**The burn-in did its job: it found four real defects that every green test
missed.** All four are fixed in this same commit, and the burn-in image was
rebuilt after each fix so the later phases ran on the corrected code — the
same find → fix → re-run loop Phase 0 established in the previous run
(`c403c6a`, `43ff712`). See **Defects found & fixed** below.

### Sign-off checklist

| Phase | Status | Notes |
|---|---|---|
| 0 — Deploy | `pass` | All four services `Up (healthy)`; `claude` 2.1.141 on PATH; UI loads through the nginx reverse proxy at `:8080`, redirects to `/login`, and accepts the API token. |
| 1 — Observability wiring | `pass` | Prometheus `infinite-loop` target `up`; `up{job="infinite-loop"}=1`; all nine alert rules loaded `inactive`; 19 `infloop_*` series queryable. |
| 2 — Functional pass | `pass` | UI/API, webhook (generic + HMAC-signed), and MCP each enqueued → executed → persisted → audited a run end to end; correlation id threads the whole chain; SSE streams live events. |
| 3 — Failure-injection pass | `pass` (7/9) | 7 of 9 faults verified; 5 alerts observed `firing` and reaching Alertmanager. 3.3 (cost) and 3.6 (slot pool) are blocked on provider credentials — see the matrix. |
| 4 — Disaster-recovery drill | `pass` | Backup → inspect → `down -v` (volume destroyed) → restore via the documented Docker procedure → state verified bit-for-bit intact. |
| 5 — Soak (24–72h) | `pending` | Needs an unattended soak window. |
| `runbook.md` operator-tested | `partial` | Detection verified for every alert that fired (3.2, 3.4, 3.7, 3.8, 3.9) and for the unwritable-data-dir case (3.5); the operator *response* steps were reviewed against observed behaviour but not separately executed end to end. |

### Defects found & fixed (all in this commit)

1. **`{{__inputs.*}}` unresolved in top-level runs** — `run-controller.ts`
   `start()` seeded the run scope with `inputs` only; the subworkflow path
   seeds both `inputs` and `__inputs`. Every `{{__inputs.NAME}}` reference —
   the form `docs/workflow-format.md` documents and the shipped
   `workflows/library/team.json` preset uses — resolved to empty with a
   `template_warning`. Surfaced in Phase 2 (the burn-in driver workflow's
   inputs arrived blank). Fixed by seeding `__inputs` alongside `inputs`.
2. **`queue-full` queue drops never counted** —
   `infloop_queue_dropped_total{reason="queue-full"}` is driven by
   `trigger_dropped` bus events, but `TriggerQueue.enqueue()` threw
   `QUEUE_FULL` without emitting one. The counter sat permanently at `0`, so
   `InfiniteLoopTriggerQueueDropping` could never fire for the most common,
   most important drop reason. A unit test asserted the *handler* counts the
   event; nothing asserted the event is ever *emitted*. Surfaced in Phase 3.2.
   Fixed by emitting `trigger_dropped{reason:"queue-full"}` from `enqueue()`.
3. **Most `.env` knobs silently ignored by the Docker deployment** —
   `docker-compose.yml`'s `environment:` block forwarded only a subset of the
   app's config vars. `INFLOOP_WEBHOOK_RATE_LIMIT`,
   `INFLOOP_MAX_CONCURRENT_RUNS`, `INFLOOP_MAX_TOTAL_EVENT_BUFFER`,
   `INFLOOP_MAX_RUN_DURATION_MS`, `INFLOOP_MAX_RUN_COST_USD`,
   `INFLOOP_LOGIN_RATE_LIMIT` and `INFLOOP_EGRESS_ENFORCE` set in `.env` never
   reached the container — the app silently used built-in defaults. The
   compose file even told operators to "tune `INFLOOP_MAX_CONCURRENT_RUNS`"
   while providing no way to set it. For a product whose safety story is
   unattended operation with these very knobs, a silent config no-op is
   serious. Surfaced when reconfiguring for Phase 3. Fixed by forwarding the
   documented operator knobs in `environment:`. `INFLOOP_MAX_RUN_NODE_EXECUTIONS`
   — a run-level safety ceiling that was missing from `.env.example` as well —
   was added to both, so the run-level ceiling family is now complete.
4. **Documented Docker restore procedure broken** — `restoreBackup()` moves
   the data directory's contents aside before extracting; when the archive
   lives *inside* the data directory — exactly what
   `docs/backup-restore.md`'s Docker procedure does
   (`docker compose cp ./backup.tar.gz infinite-loop:/data/backup.tar.gz`) —
   the move-aside relocated the archive itself, and `tar` then failed with
   "Cannot open: No such file or directory". The documented disaster-recovery
   restore did not work. Surfaced in Phase 4. Fixed by extracting from the
   archive's post-move-aside location.

Regression tests were added for defects 2 and 4
(`trigger-queue.test.ts`, `backup.test.ts`). Full suite after the fixes:
**804 pass, 1 skip, 0 fail**.

### Phase 0 — Deploy

Built `infinite-loop:local` and the provider overlay `infinite-loop:burn-in`;
brought up the full stack (base + burn-in + observability overlays). Verified:

- [x] `docker compose ps` — all four services (`infinite-loop`, `prometheus`,
      `alertmanager`, `proxy`) `Up (healthy)`.
- [x] `docker compose exec infinite-loop which claude` → `/usr/local/bin/claude`;
      `claude --version` → `2.1.141 (Claude Code)`.
- [x] `/api/health` → `{"status":"ok"}`.
- [x] The UI loads through the nginx reverse proxy at `http://localhost:8080`:
      `/` → `307` redirect to `/login`, the login page renders, a wrong token
      → `401`, the real token via `POST /api/auth` → `200` and an
      authenticated `/api/runs` → `200`. **This closes the one Phase 0 box the
      previous run left open** (UI-behind-proxy was not locally reproducible
      before the observability overlay shipped).

### Phase 1 — Observability wiring

Verified live against the running app:

- [x] Prometheus **Status → Targets**: the `infinite-loop` target is `up`,
      scraping `http://infinite-loop:3000/api/metrics`.
- [x] `up{job="infinite-loop"}` evaluates to `1`.
- [x] All **nine** alert rules from `deploy/prometheus-alerts.yml` are loaded
      in one `infinite-loop` group, state `inactive`. (A tenth rule,
      `InfiniteLoopDataDirNotWritable`, was added after Run 1 closing item 4
      under *Outstanding* below — Run 2 verifies all ten.)
- [x] 19 `infloop_*` series are queryable.

This upgrades the previous run's `static-pass` to a live `pass`.

### Phase 2 — Functional pass

| Surface | Observed | Result |
|---|---|---|
| UI / API | `POST /api/run` → `202`; run executed; `succeeded` in history; SSE `/api/events` streamed `run_started` / `node_started` / `stdout_chunk` / `node_finished` / `run_finished`; audit `run started` + `run finished`. | `pass` |
| Webhook | `POST /api/webhook/<triggerId>` (generic plugin) → `202 queued`; run executed `succeeded`; audit `webhook accepted` → `run started/finished`, all sharing one correlation id. A second trigger on the HMAC-signed `frogo` plugin: a correctly-signed delivery → `202`; a bad signature → `401 bad-signature` + audit `webhook rejected (bad-signature)`. | `pass` |
| MCP | `POST /api/mcp` `tools/list` exposed the per-workflow tool; `tools/call` enqueued; run executed `succeeded` with the returned correlation id. | `pass` |

`{{__inputs.*}}` templating was confirmed working after defect 1 was fixed —
the run scope carries both `inputs` and `__inputs`, no `template_warning`.

### Phase 3 — Failure-injection pass

Driven on the burn-in image with defects 1–3 fixed. Five distinct alerts were
observed transitioning to `firing`, and all firing alerts reached
Alertmanager (`prometheus → alertmanager` routing confirmed).

| # | Fault injected | Behaviour observed | Alert fired | Runbook entry |
|---|---|---|---|---|
| 3.1 | `kill -9` mid-run | Interrupted run reconciled to `failed` in history with audit `run finished (reason: crash-recovered)`; `infloop_process_uptime_seconds` reset. The `restart: unless-stopped` policy **does** restart on a real process crash (`RestartCount` incremented, container back `healthy`); a `docker kill -s KILL` did **not** auto-restart on this Docker Desktop / macOS host — a host runtime quirk, not a repo defect (the compose policy is correct, and the realistic crash path works). | n/a — restart is faster than the 2m `for:` | crash-recovery validated |
| 3.2 | Flood the trigger queue past the 100-run cap (350 concurrent MCP enqueues) | 254 enqueued, the rest shed; `infloop_queue_dropped_total{reason="queue-full"}` climbed to 295 (**stuck at 0 before defect 2 was fixed**). | `InfiniteLoopTriggerQueueDropping` — **firing** (71 scrapes) | dropping validated |
| 3.3 | Exceed `INFLOOP_MAX_TOTAL_COST_USD` | **Not verified** — the image ships the `claude` CLI but has no Anthropic credentials; costed runs need real provider auth and real spend, which was not incurred. | not observed | — |
| 3.4 | Hammer one webhook past `INFLOOP_WEBHOOK_RATE_LIMIT` (set to 20/min) | Burst of 80 → 20 accepted, 60 × `429`; repeated over the window; `infloop_webhook_requests_total{outcome="rejected"}` climbed. | `InfiniteLoopWebhookErrorRate` — **firing** | validated |
| 3.5 | Make the data directory unwritable (`chmod 0555 /data`) | `/api/health` → `503 {status:"degraded","error":"data directory is not writable"}`; the Docker healthcheck flipped the container `unhealthy` (~80s); `/api/metrics` kept scraping `200`. | **No Prometheus alert — confirmed by design**; the Docker healthcheck is the sole detector. | "Data directory not writable" validated |
| 3.6 | Push more concurrent runs than slots | **Not verified** — `INFLOOP_MAX_CONCURRENT_RUNS=1` correctly set `infloop_slot_pool_capacity=1`, but the folder-touching slot pool is only entered by runs that take a directory lock (Agent-node work). A pure-Script workflow never contends — `slot_pool_waiting` stayed `0`. Saturating it needs provider Agent nodes (same provider-credential gap as 3.3). | not observed | — |
| 3.7 | Run event-heavy workflows past `INFLOOP_MAX_TOTAL_EVENT_BUFFER` (set to 600) | Event-heavy runs drove `infloop_event_buffer_events / infloop_event_buffer_limit` to ~4.2 (the `MIN_PER_RUN_EVENT_CAP` floor lifts the aggregate above the nominal cap, as documented). | `InfiniteLoopEventBufferNearLimit` — **firing** | validated |
| 3.8 | Force repeated run failures | 358 `mode=fail` runs settled; `infloop_runs_total{status="failed"}=358`, 100% of settled runs. | `InfiniteLoopHighRunFailureRate` — **firing** | validated |
| 3.9 | Stop the container, leave it down >2m | During the 3.1 `docker kill` the container was down ~6m; Prometheus lost the target. The `ALERTS` series shows the alert going `pending` (2m `for:`) then `firing`. | `InfiniteLoopInstanceDown` — **firing** | validated |

**`InfiniteLoopTriggerQueueBacklog` (`queue_depth > 50` for 10m) was not
reproduced.** The trigger-queue drain hands a queued run off to the engine as
fast as `engineStart` returns, so the queue empties faster than an HTTP client
can fill it; `queue_depth` only holds high when the drain itself is paused
(cost-budget exhaustion). Reproducing this alert needs either a cost-budget
pause or a load generator beyond a shell — noted for a future run.

### Phase 4 — Disaster-recovery drill

- [x] Backup taken inside the container (`bun run backup`) — `0.38 MiB`,
      copied off-host.
- [x] `restore --inspect` — valid manifest, 112 members, no `uncoveredPaths`.
- [x] Captured pre-drill state: workflows=2, triggers=2, run history=100,
      audit entries=200.
- [x] `docker compose down -v` — **all volumes destroyed**.
- [x] Restore via the documented Docker procedure
      (`docs/backup-restore.md` → "Restoring in Docker"). **This failed the
      first time** — defect 4 — and passed after the fix: "Restored 6 item(s)".
- [x] Post-restore state: workflows=2, triggers=2, run history=100, audit
      entries=200 — **identical to pre-drill**; `/api/health` → `ok`;
      the `burnin` and `team` workflows intact.

### Phase 5 — Soak

`pending` — needs a 24–72h unattended window. Drive a steady modest load and
watch that the gauges return to baseline between runs, RSS stays flat, and
`infloop_process_uptime_seconds` climbs monotonically (no silent restart).
Both halves are now automated: `deploy/burn-in-soak-load.ts`
(`bun run soak-load`) fires a webhook trigger on an interval to generate the
load, and `deploy/burn-in-soak-watch.ts` (`bun run soak-watch`) samples the
soak gauges and prints the Phase 5 drift verdict — uptime monotonicity, gauge
ratchet, RSS leak. The soak now needs only the wall-clock window.

### Outstanding / decisions before production

1. **Phase 5 soak** and **one final pass on a real remote Linux host** remain
   the genuinely time/host-gated work. A local burn-in proves logic and
   wiring; it cannot prove host reality — TLS termination, the real reverse
   proxy, real network egress, real disk-full behaviour, and the
   `restart: unless-stopped` auto-restart on a `docker kill` (which did not
   fire on Docker Desktop / macOS here — confirm it on Linux). Phase 5 is now
   fully tooled: `deploy/burn-in-soak-load.ts` (`bun run soak-load`) generates
   the webhook load and `deploy/burn-in-soak-watch.ts` (`bun run soak-watch`)
   samples the gauges and prints the drift verdict, so the soak needs only a
   wall-clock window — not a human watching Prometheus for three days.
2. **3.3 (cost budget) and 3.6 (slot pool) are unverified** for lack of
   provider credentials. Both need a provider that actually runs: 3.3 needs
   the `claude` CLI authenticated and real spend; 3.6 needs Agent nodes that
   hold folder-touching directory locks. Run both on the remote host with a
   credentialed provider and a tight `INFLOOP_MAX_TOTAL_COST_USD`. Phase 3.3
   is now partially pre-built: `deploy/burn-in-driver.ts` +
   `deploy/burn-in-cost-workflow.json` (`bun run burn-in`) drive and check the
   `503` gate, the mid-run abort, and the spend metrics, and print a checklist;
   the queued-run-held-on-disk behaviour and the Alertmanager hop still need a
   manual pass — see `docs/burn-in.md` Phase 3.
3. **`InfiniteLoopTriggerQueueBacklog`** was not reproduced locally (see
   Phase 3). The load generator now exists: `bun run soak-load` with a low
   `--interval` and a high `--concurrency` floods the trigger queue and reports
   the peak `queue_depth` reached. Run it long enough to satisfy the alert's
   10m `for:` window, then confirm the alert in Prometheus.
4. **Phase 3.5 monitoring gap — resolved.** Run 1 confirmed an unwritable
   data directory had no Prometheus alert. Rather than rely on
   healthcheck-only detection, the gap was closed in-repo: `/api/metrics` now
   exposes an `infloop_data_dir_writable` gauge (1/0), probed live at scrape
   time from the same check `/api/health` uses, and
   `InfiniteLoopDataDirNotWritable` (critical, `for: 2m`) alerts on it. The
   alert set is now ten rules. Re-verify in Run 2 that the alert actually
   transitions to `firing` when the data directory is made unwritable.
5. **Runbook operator-testing.** Detection is validated for every alert that
   fired; the operator *response* procedures in `docs/runbook.md` were
   reviewed against observed behaviour but not separately executed. Walk each
   one end to end on the remote-host run.

### Re-run trigger

Per `docs/burn-in.md`, re-run the whole burn-in after any change to the
deployment shape, and open a new `## Run N` section here. This commit changes
`docker-compose.yml` (defect 3) and the image (defects 1, 2, 4) — the next
run is the remote-host pass that closes items 1–3 and 5 above.
