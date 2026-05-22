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

## Run 1 — started 2026-05-22

First burn-in run. Target: a staging deployment of the provider-overlay image
built from [`deploy/Dockerfile.providers`](deploy/Dockerfile.providers).

### Sign-off checklist

| Phase | Status | Notes |
|---|---|---|
| 0 — Deploy | `pass` (local) | Two boot-blocking defects found and fixed (`c403c6a`, `43ff712`); both images build clean and the stack runs `Up (healthy)` with `claude` on PATH — verified on a local Docker host 2026-05-22. The reverse proxy now ships as `deploy/docker-compose.observability.yml`, so the UI-behind-proxy check is locally reproducible; not yet run. |
| 1 — Observability wiring | `static-pass` | Pre-flight audit 15/15 pass. Observability overlay (`deploy/docker-compose.observability.yml`) shipped and smoke-tested standalone: Prometheus boots, loads all 9 alert rules, and the alert pipeline evaluates (`InfiniteLoopInstanceDown` went `pending` against an absent target). The full pass — target `up` against the live app — is now locally reproducible; still to run. |
| 2 — Functional pass | `pending` | Needs a staging host. |
| 3 — Failure-injection pass | `pending` | The core of the burn-in — see the matrix below. |
| 4 — Disaster-recovery drill | `pending` | Needs a staging host. |
| 5 — Soak (24–72h) | `pending` | Needs an unattended soak window. |
| `runbook.md` operator-tested | `pending` | Every entry is authored; none is operator-validated yet. |

### Phase 0 — Deploy

The burn-in did its job immediately: Phase 0 alone — "deploy and confirm
healthy" — surfaced **two boot-blocking defects that every green test had
missed**, both now fixed and merged to `main`:

- `c403c6a` — the container crash-looped on the first request: Next 16 fell
  back to a throwing `AsyncLocalStorage` stub. Fixed by preloading
  `globalThis.AsyncLocalStorage` (`bun --preload`) before `server.ts`.
- `43ff712` — the base image ships no provider CLI, so the cost and
  run-failure phases had nothing to run. Fixed by shipping
  `deploy/Dockerfile.providers`, an overlay that bakes the `claude` CLI onto
  the base image.

Verified on a local Docker host (2026-05-22):

- [x] `docker compose build` — the base image `infinite-loop:local` builds
      clean.
- [x] The burn-in overlay builds clean as `infinite-loop:burn-in`; its
      build-time `claude --version` smoke test reported version
      `2.1.141 (Claude Code)`, so the CLI resolves for the unprivileged
      `bun` user.
- [x] The burn-in compose override brings the stack up
      (`up -d` against `docker-compose.yml` + `deploy/docker-compose.burn-in.yml`).
- [x] `docker compose ps` shows `Up (healthy)`; `/api/health` returns
      `{"status":"ok"}`.
- [x] `docker compose exec infinite-loop which claude` resolves to
      `/usr/local/bin/claude`.

Still to confirm on the staging host:

- [ ] The UI loads behind the reverse proxy and accepts the token at the
      login page. This needs the proxy the deployment requires for
      non-loopback exposure and is not reproducible on a local Docker host.

The two boot fixes hold: the provider-overlay container boots and stays
`(healthy)` with the provider CLI on PATH. The local run cannot exercise the
reverse proxy — that is the one piece of Phase 0 left for the staging run.

### Phase 1 — Observability wiring

`bun test deploy/burn-in-preflight.test.ts` — **15/15 pass** (2026-05-22).

This is the static gate `docs/burn-in.md` Phase 1 describes. It confirms that
every alert in [`deploy/prometheus-alerts.yml`](deploy/prometheus-alerts.yml)
references an `infloop_*` series `MetricsRegistry` actually emits, that every
label value is one the registry really emits, that every `up{}` selector pins
`job="infinite-loop"`, and that every alert has a one-to-one entry in
`docs/runbook.md`. It now also audits the observability overlay
([`deploy/docker-compose.observability.yml`](deploy/docker-compose.observability.yml)):
that `deploy/prometheus.yml` loads its rules from the path the overlay mounts
them to, scrapes `/api/metrics` under `job="infinite-loop"`, and reads the
scrape token from the file the overlay's entrypoint writes.

The overlay was also smoke-tested standalone on a local Docker host
(2026-05-22): `promtool`, `amtool`, and `nginx -t` all pass on the shipped
configs; Prometheus boots, loads all nine alert rules into one `infinite-loop`
group, and the alert pipeline evaluates — `InfiniteLoopInstanceDown` correctly
went `pending` against an absent target. Alertmanager and the nginx proxy come
up `healthy`, and the proxy forwards to the app upstream.

`static-pass`: the alert ↔ metric ↔ runbook wiring is sound and the overlay
provably boots, but the full pass — `up{job="infinite-loop"}` reading `1`
against the live app with the real token — has not been run end to end. That
is now locally reproducible (bring the whole stack up per Phase 0); it no
longer needs a remote host.

### Phase 2 — Functional pass

`pending` — needs a staging host. Confirm the UI, webhook, and MCP ingress
surfaces each enqueue, stream, persist, and audit a run end to end.

### Phase 3 — Failure-injection pass

`pending` — the core of the burn-in. These safety controls exist *only* for
unattended operation and have never been exercised on the real provider
image. For each fault, record the behaviour observed, whether the alert
fired, and whether the matching `docs/runbook.md` entry held up when followed
end to end.

| # | Fault injected | Behaviour observed | Alert fired | Runbook entry validated |
|---|---|---|---|---|
| 3.1 | `kill -9` mid-run | _pending_ | _pending_ | `InfiniteLoopInstanceDown` (crash-loop backstop) |
| 3.2 | Flood trigger queue past the 100-run cap | _pending_ | _pending_ | `InfiniteLoopTriggerQueueDropping`, `InfiniteLoopTriggerQueueBacklog` |
| 3.3 | Exceed `INFLOOP_MAX_TOTAL_COST_USD` | _pending_ | _pending_ | `InfiniteLoopCostBudgetNearLimit`, `InfiniteLoopCostBudgetExhausted` |
| 3.4 | Hammer one trigger past `INFLOOP_WEBHOOK_RATE_LIMIT` | _pending_ | _pending_ | `InfiniteLoopWebhookErrorRate` |
| 3.5 | Make the data directory unwritable | _pending_ | n/a — no alert *by design* | "Data directory not writable" |
| 3.6 | Push more concurrent runs than execution slots | _pending_ | _pending_ | `InfiniteLoopSlotPoolSaturated` |
| 3.7 | Run event-heavy workflows past `INFLOOP_MAX_TOTAL_EVENT_BUFFER` | _pending_ | _pending_ | `InfiniteLoopEventBufferNearLimit` |
| 3.8 | Force repeated run failures (>5, >50% of settled runs) | _pending_ | _pending_ | `InfiniteLoopHighRunFailureRate` |
| 3.9 | Stop the container and leave it down past 2m | _pending_ | _pending_ | `InfiniteLoopInstanceDown` |

**Note on 3.5 — accepted monitoring limitation.** An unwritable data
directory has **no Prometheus alert**: `/api/metrics` can still scrape `200`
while the data directory is unwritable, so the Docker `HEALTHCHECK` against
`/api/health` is its sole detector (`docs/runbook.md` → "Data directory not
writable"; `docs/burn-in.md` Phase 3.5). If your monitoring is Prometheus-
only, wire the container `unhealthy` state to your orchestrator or an external
uptime check. Whether to leave this accepted or add a health-derived alert is
a deployment decision to settle **before** production — record the decision
here rather than letting it pass silently.

### Phase 4 — Disaster-recovery drill

`pending` — needs a staging host. Take a backup, destroy the volume
(`docker compose down -v`), restore into a fresh volume, and confirm
workflows, run history, triggers, settings, and the audit log are all intact.

### Phase 5 — Soak

`pending` — needs a 24–72h unattended window. Drive a steady modest load and
watch that the gauges return to baseline between runs, RSS stays flat, and
`infloop_process_uptime_seconds` climbs monotonically (no silent restart).

### Outstanding / decisions before production

1. **Most of Phases 1–4 are now locally reproducible.** The observability
   overlay (`deploy/docker-compose.observability.yml`) stands up Prometheus,
   Alertmanager, and a reverse proxy on a developer machine, so Phase 1
   (live rule load), Phase 2 (functional pass), Phase 3 (failure injection —
   all `docker`/`chmod`/config operations), and Phase 4 (DR drill) no longer
   need a remote host. The genuinely operator-gated remainder is Phase 5's
   24–72h soak window, plus one final pass on a real remote host before
   go-live to catch host-specific reality (TLS, the real proxy, real
   network).
2. **The runbook is authored but unproven.** Every entry in
   `docs/runbook.md` exists, but none has been operator-tested. Phase 3 is
   the one chance to validate the *response*, not just the detection —
   follow each runbook entry end to end as its alert fires.
3. **Phase 3.5 monitoring gap.** Decide consciously whether the
   healthcheck-only detection of an unwritable data directory is acceptable
   for this deployment, or whether it warrants a health-derived alert.
4. **Re-run trigger.** Per `docs/burn-in.md`, re-run the whole burn-in after
   any change to the deployment shape, and open a new `## Run N` section here.
