# Burn-in Run 2 — execution plan

Burn-in **Run 1** ([`BURN-IN.md`](../BURN-IN.md)) drove Phases 0–4 to `pass` on
a local Docker Desktop / macOS host and found four real defects. It left two
things genuinely open — not for lack of code, but for lack of a host and a
window:

- **Phase 5 — Soak (24–72h):** never run.
- **One final pass on a real remote Linux host:** never run. Everything so far
  is macOS / Docker Desktop, which `docs/burn-in.md` and `BURN-IN.md` both flag
  as unrepresentative — `docker kill -s KILL` did not auto-restart there, and
  some alerts cannot fire on that host at all.

This file is the **pre-flight plan** for that run, so Run 2 can start the moment
a host and credentials exist. It is not the procedure (that is the reusable
checklist [`docs/burn-in.md`](burn-in.md)) and it is not the record (that is a
new `## Run 2` section in [`BURN-IN.md`](../BURN-IN.md), written as the run
happens). It is the staging work that bridges the two: host sizing, the deploy
steps, the two `.env` profiles, the soak load/observer invocation, the verdict
checklist, and the abort criteria.

Run 2 starts from the frozen candidate: the `main` tag `burn-in-run2-candidate`.

## What Run 2 closes

One well-planned remote-host run closes nearly every open item from Run 1's
*Outstanding / decisions before production* list at once:

- **Phase 5 soak** — the only `pending` phase; the defect class (memory leaks,
  RSS drift, gauge ratchets, fd exhaustion) that a short test cannot find by
  construction.
- **The remote-host pass** — TLS termination, a real reverse proxy, real
  network egress, real disk-full behaviour, and `restart: unless-stopped`
  auto-restart on a `docker kill` (which did *not* fire on Docker Desktop /
  macOS — `BURN-IN.md` row 3.1 explicitly says "confirm it on Linux").
- **Phase 3.3 — cost budget** (`InfiniteLoopCostBudgetNearLimit` /
  `…Exhausted`): unverified in Run 1 for lack of provider credentials.
- **Phase 3.6 — slot-pool saturation** (`InfiniteLoopSlotPoolSaturated`):
  unverified in Run 1 — needs Agent nodes that hold folder-touching locks.
- **`InfiniteLoopDataDirNotWritable`** — the rule was added *after* Run 1 and
  has never been observed transitioning to `firing`.
- **`InfiniteLoopTriggerQueueBacklog`** — not reproduced in Run 1; the
  `soak-load` generator can now flood the queue to drive it.
- **Phase 4 DR drill on real disk** — Run 1's was local-only; re-confirm
  defect 4's fix holds on a real volume.
- **Runbook operator-testing** — Run 1 validated *detection* for every alert
  that fired but not the operator *response* steps; walk each end to end here.

## What the operator must supply

These are the genuine blockers — infrastructure and secret decisions that no
script can resolve:

1. **A remote Linux host** (sizing below), reachable over SSH.
2. **A provider the image can actually run** — `claude` baked in via
   [`deploy/Dockerfile.providers`](../deploy/Dockerfile.providers) **and
   authenticated inside the container**. Phases 3.3 and 3.6 need a provider
   that genuinely executes and reports cost.
3. **A tight `INFLOOP_MAX_TOTAL_COST_USD`** and acceptance of a few dollars of
   real provider spend — Phase 3.3 cannot be proven without real cost.
4. **A 24–72h unattended window** for the Phase 5 soak.

Everything else — load generation, gauge sampling, drift analysis, the cost
drive — is scripted and runs unattended.

## Host sizing

- **OS:** any modern Linux distribution with a current kernel and Docker
  Engine. The point of Run 2 is host *reality*, so this must be a real Linux
  host (a cloud VM is fine), not Docker Desktop.
- **CPU / RAM:** ≥ 4 vCPU, ≥ 8 GB RAM. The app container alone caps at
  `INFLOOP_MEM_LIMIT` (default `4g`) and `INFLOOP_CPUS` (default `2.0`);
  Prometheus, Alertmanager, the nginx proxy, and the `bun` soak/cost drivers
  all run alongside it.
- **Disk:** ≥ 20 GB free. 72h of Prometheus TSDB, run history, the audit log,
  and the scheduled-backup volume all accumulate over the soak window.
- **Tooling on the host:** Docker Engine + Compose v2, `git` (clone the repo
  at tag `burn-in-run2-candidate`), and `bun` (to run `soak-load`,
  `soak-watch`, and `burn-in` — or run them from a container that has it).

## Reaching the operator surfaces

The observability overlay binds Prometheus, Alertmanager, and the proxy to
**host loopback only** (`127.0.0.1:9090 / :9093 / :8080`). From a workstation,
tunnel them over SSH:

```bash
ssh -L 8080:localhost:8080 -L 9090:localhost:9090 -L 9093:localhost:9093 <host>
```

A remote staging deployment may instead substitute its own TLS-terminated
proxy and Prometheus — in which case Phase 1 must reproduce the same scrape
wiring (authenticated `/api/metrics`, the `infinite-loop` job label, the rules
file loaded). See [`configuration.md`](configuration.md#metrics).

## Configuration — two `.env` profiles

Run 2 uses **two** configs because Phase 3 and Phase 5 want opposite things.

### Profile A — fault-reachable (Phases 0–4)

Tight limits so every bound is reachable in minutes, matching Run 1:

```dotenv
INFLOOP_MAX_TOTAL_COST_USD=2.00     # 3.3 — reach the budget on ~$1-2 of spend
INFLOOP_MAX_CONCURRENT_RUNS=1       # 3.6 — one slot, so concurrent runs queue
INFLOOP_WEBHOOK_RATE_LIMIT=20       # 3.4 — burst past it in seconds
INFLOOP_MAX_TOTAL_EVENT_BUFFER=600  # 3.7 — event-heavy runs hit the ceiling
```

### Profile B — production-representative (Phase 5)

Before the soak, redeploy with realistic limits so the soak measures **drift
under normal operation**, not constant alerting. The soak's probe workflow is
provider-free, so leave `INFLOOP_MAX_TOTAL_COST_USD` at its default (`0`,
disabled) or generous — the cost ceiling is not under test in Phase 5. Set
`INFLOOP_MEM_LIMIT` / `INFLOOP_CPUS` to the values the real production host
will use, since the soak is also the RSS-headroom check.

## Phase-by-phase

Run the phases in order — each assumes the previous passed. Tick the
[`docs/burn-in.md`](burn-in.md) sign-off checklist as you go and record
per-phase observations in a new `## Run 2` section of [`BURN-IN.md`](../BURN-IN.md).

### Phase 0 — Deploy (Profile A)

```bash
git clone <repo> && cd infinite-loop && git checkout burn-in-run2-candidate
# build .env from .env.example, apply Profile A, set INFLOOP_API_TOKEN
docker compose build
docker compose -f docker-compose.yml \
               -f deploy/docker-compose.burn-in.yml \
               -f deploy/docker-compose.observability.yml up -d --build
```

Confirm all four services `Up (healthy)`, `docker compose exec infinite-loop
which claude` resolves, and the UI loads through the proxy at
`http://localhost:8080`. **New for Run 2:** this is a real Linux host —
later, in Phase 3.1, re-check that `docker kill -s KILL infinite-loop`
actually triggers the `restart: unless-stopped` auto-restart (it did not on
Docker Desktop / macOS).

### Phase 1 — Observability wiring

Verify **all eleven** alert rules from `deploy/prometheus-alerts.yml` load
`inactive` in the `infinite-loop` group. Run 1 verified *nine*; two have been
added since — `InfiniteLoopDataDirNotWritable` and `InfiniteLoopBackupStale`.
Confirm the `infinite-loop` target is `up`, `up{job="infinite-loop"}` is `1`,
and `infloop_*` series are queryable.

### Phase 2 — Functional pass

UI, webhook (generic + HMAC-signed), and MCP each enqueue → execute → persist
→ audit a run end to end, with a correlation id threading the chain and SSE
streaming live events.

### Phase 3 — Failure-injection pass

Walk every row of [`docs/burn-in.md`](burn-in.md#phase-3--failure-injection-pass)
(3.1–3.10 plus `InfiniteLoopInstanceDown`). For each alert that fires, **also
walk the matching [`docs/runbook.md`](runbook.md) entry end to end** — Run 1
validated detection but not the operator response. Specifically close the
Run 1 gaps:

- **3.3 — cost budget.** Preflight without spending, then drive:
  ```bash
  bun run burn-in -- --preflight-only
  bun run burn-in -- --confirm-spend --prometheus http://localhost:9090
  ```
  The driver fires costed `claude` runs one at a time until the `503`
  admission gate trips, scraping `infloop_cost_budget_spent_usd` between them.
  Then walk the **manual half** the driver does not cover: confirm a queued
  trigger run is held intact on disk while the budget is exhausted, and that
  `InfiniteLoopCostBudgetExhausted` reaches Alertmanager.
- **3.6 — slot-pool saturation.** With `INFLOOP_MAX_CONCURRENT_RUNS=1`, drive
  more concurrent **Agent-node** runs (the kind that take a folder-touching
  directory lock — a pure-Script workflow never contends) than slots, so
  `infloop_slot_pool_waiting > 0` holds for 15m → `InfiniteLoopSlotPoolSaturated`.
- **3.10 — backup-stale.** Age the newest archive in the
  `infinite-loop-backups` volume past 36h
  (`docker compose exec backup touch -d '40 hours ago' /backups/<newest>`),
  or stop the `backup` sidecar and remove every archive → `InfiniteLoopBackupStale`
  fires after its 2h `for:` window.
- **`InfiniteLoopDataDirNotWritable`.** `chmod 0555` the data volume and
  confirm the rule actually transitions to `firing` — it was added after
  Run 1 and has never been seen fire.
- **`InfiniteLoopTriggerQueueBacklog`.** Run 1 never reproduced it. Use the
  generator with a low interval and high concurrency to flood the queue:
  `bun run soak-load -- --duration 0.3 --interval 1 --concurrency 40` — keep
  `queue_depth` above 50 long enough for the rule's 10m `for:` window.

### Phase 4 — Disaster-recovery drill (real disk)

Backup → `restore --inspect` → `docker compose down -v` (destroys the volume)
→ restore via the documented Docker procedure
([`backup-restore.md`](backup-restore.md#restoring-in-docker)) → verify
workflows, run history, triggers, settings, and the audit log are intact and
the server is `healthy`. Run 1 found and fixed defect 4 here on a local
volume; this confirms the fix holds on a real host disk.

### Phase 5 — Soak (Profile B)

The headline phase. After Phase 4, **redeploy fresh with Profile B** so the
RSS baseline is clean and uncontaminated by Phase 3's fault injection. Then
run the generator/observer pair for the full window — under `tmux`, `nohup`,
or a systemd unit so they survive an SSH disconnect:

```bash
# Generator — one webhook wave every 3 min; installs a provider-free probe
bun run soak-load  -- --duration 48 --interval 180

# Observer — samples the Phase 5 gauges + container RSS, prints the verdict
bun run soak-watch -- --duration 48 --interval 300 \
                      --docker-container infinite-loop --out soak-run2.jsonl
```

The **pass/fail is the observer's verdict**, not the generator's — an idle
soak passes vacuously. `soak-watch` prints, when the window elapses:

- [ ] **Uptime monotonic** — `infloop_process_uptime_seconds` only ever
      climbs; no silent restart.
- [ ] **No gauge ratchet** — `event_buffer_events`, `runs_active`,
      `queue_depth`, and `slot_pool_*` return to baseline between runs and do
      not trend up.
- [ ] **RSS flat** — container RSS stays within `--rss-growth-threshold`; no
      monotonic upward trend.

### Abort criteria

Stop the soak early and file a defect — do not wait out 72h to confirm a leak
already obvious at hour 6 — if any of these appear:

- the container is **OOM-killed** or **crash-looping** (uptime resets);
- **RSS trends monotonically up** past the threshold well before the window
  ends;
- a return-to-baseline gauge **ratchets up and never recovers**;
- the host **disk fills** (TSDB / backups / data) and
  `InfiniteLoopDataDirNotWritable` fires;
- file descriptors or container thread count climb without bound.

## Expect to find defects

Run 1 found **four** real defects in the *easy* phases (0–4). Phase 5 is not a
formality — it targets exactly the failure class nothing else can catch.
Budget find → fix → rebuild image → re-run. A fix to the image or the compose
file is a change to the deployment shape: per [`docs/burn-in.md`](burn-in.md),
restart the soak from a clean baseline rather than continuing the tainted run.

## Recording the run

Open a `## Run 2` section in [`BURN-IN.md`](../BURN-IN.md): per-phase date,
environment, what was *observed*, pass/fail, the alerts seen `firing`, and the
runbook entries walked. Tick the [`docs/burn-in.md`](burn-in.md#sign-off)
sign-off checklist. Only when **every** box — including Phase 5 — is ticked is
the deployment *verified* production-ready, rather than expected to be.

## Quick command reference

```bash
# Deploy (Phases 0-4, Profile A)
docker compose -f docker-compose.yml \
               -f deploy/docker-compose.burn-in.yml \
               -f deploy/docker-compose.observability.yml up -d --build

# Phase 3.3 — cost budget
bun run burn-in    -- --preflight-only
bun run burn-in    -- --confirm-spend --prometheus http://localhost:9090

# Phase 3 — flood the trigger queue (InfiniteLoopTriggerQueueBacklog)
bun run soak-load  -- --duration 0.3 --interval 1 --concurrency 40

# Phase 5 — soak (Profile B)
bun run soak-load  -- --duration 48 --interval 180
bun run soak-watch -- --duration 48 --interval 300 \
                      --docker-container infinite-loop --out soak-run2.jsonl

# any driver — full flag list
bun run soak-load --help ; bun run soak-watch --help ; bun run burn-in --help
```
