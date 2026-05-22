# Production-readiness decision — feature freeze, awaiting burn-in Run 2

**Date:** 2026-05-22
**Status:** Accepted — in effect until burn-in Run 2 passes.

## Decision

Infinite Loop's feature and hardening work is **frozen**. No new features,
no new hardening pillars, and **no further burn-in *preparation* commits**
should be merged. The single remaining gate to a production-ready
declaration is the execution of **burn-in Run 2** — the 24–72h soak on a
real Linux host — per [`docs/burn-in-run2-plan.md`](burn-in-run2-plan.md).

Until Run 2 passes, the honest project status is **"code-complete, not yet
production-validated."**

## Context

Every production-readiness pillar is built and merged to `main`:

- **Security** — token auth, per-run egress allowlist, audit log,
  fail-closed deploy posture, `0600` secrets-at-rest, trigger-file shape
  validation, startup config validation, an integrity pass.
- **Reliability** — crash recovery, the durable trigger queue, the global
  event-memory budget, data-directory backup/restore, and an automated
  scheduled-backup sidecar with retention pruning.
- **Observability** — 11 Prometheus alert rules, the per-alert operator
  runbook, end-to-end correlation IDs, and the backup-freshness metric.
- **Operability** — a process-wide cost budget, container resource limits,
  and forwarded operator config knobs.

The test suite is green (1252 pass / 1 skip / 0 fail), CI is green, and
`main` is tagged `burn-in-run2-candidate`. An independent gap sweep found
**no unbuilt engineering work** — no real TODO/FIXME/stub markers, only
example payload data and one deliberately documented choice (agent
providers are not baked into the base image; an overlay Dockerfile solves
it).

Burn-in **Run 1** (2026-05-22, [`BURN-IN.md`](../BURN-IN.md)) drove Phases
0–4 to `pass` and found four real defects that every green test missed —
all fixed. But Run 1 ran entirely on a local macOS Docker Desktop host.

## The gap

**Nothing in this system has ever run on real infrastructure, under load,
for a sustained period.** Every validation to date is local: macOS Docker
Desktop, off-host dry runs, a dress-rehearsal. A system that has never run
in production-like conditions cannot honestly be called production-ready.

## Why the freeze

The last five commits to `main` were, in order: a soak-load generator, a
soak-watch observer, a cost-budget driver, the Run 2 plan, and the Run 2
pre-flight. Five commits of **preparing to test** rather than **testing** —
the classic pre-production trap, where preparation substitutes for the one
scary, irreversible step: provisioning a real host and spending real money.

The marginal value of further preparation is now essentially zero, and each
new "burn-in helper" commit is itself more unvalidated code. The disciplined
move is to stop preparing and execute.

## What Run 2 proves that nothing else can

These defect classes are unfindable by short tests or local runs, by
construction:

- Memory leaks / RSS drift over wall-clock days.
- Gauge/counter monotonicity and the absence of silent restarts.
- `restart: unless-stopped` auto-restart on a real `docker kill` —
  Docker Desktop / macOS did **not** fire it in Run 1.
- Real TLS termination, reverse-proxy, network egress, and disk-full
  behaviour.
- The two credential-blocked Run 1 phases — 3.3 (the cost-admission gate)
  and 3.6 (slot-pool saturation).

## What unblocks Run 2

Run 2 is blocked only on operator-supplied infrastructure — everything else
is scripted and committed:

1. A Linux host — ≥4 vCPU / 8 GB RAM / 20 GB disk (a ~$20–40/mo cloud VM,
   destroyed after).
2. A provider CLI authenticated in the container, via
   [`deploy/Dockerfile.providers`](../deploy/Dockerfile.providers).
3. Acceptance of ~$2–5 of real agent spend, capped tightly with
   `INFLOOP_MAX_TOTAL_COST_USD`.
4. A 24–72h unattended window. A 24h soak is an acceptable first cut if
   cost or time is constrained.

The execution steps, host sizing, `.env` profiles, soak-driver invocation,
verdict checklist, and abort criteria are already written in
[`docs/burn-in-run2-plan.md`](burn-in-run2-plan.md).

## Consequence

This decision stays in effect until burn-in Run 2 completes and a `## Run 2`
section is recorded in [`BURN-IN.md`](../BURN-IN.md). At that point — and not
before — Infinite Loop may be declared production-ready.

## Go-live checklist (after Run 2 passes)

Run 2 validates the system, and a passing Run 2 is now the whole gate. An
earlier revision of this decision deferred one item to a post-Run-2
"~5-minute change" — wiring a real Alertmanager notifier. That deferral has
been **withdrawn**: the item is folded into Run 2 itself, for the reason
recorded below.

## Amendment — alert delivery is validated by Run 2

The deferred item was: [`deploy/alertmanager.yml`](../deploy/alertmanager.yml)
routes to a `null` receiver, so all 11 alert rules page nobody until an
operator wires a real notifier. The deferral's reasoning — a Slack/PagerDuty
secret cannot be baked into the repo — was right about the secret but wrong
about the deferral. The alert *delivery* path (a firing alert actually
reaching a human) is end-to-end-only-testable: a wrong webhook URL passes
every config-load and healthcheck and then fails silently in the real
incident, which is worse than no alerting because operators trust it.
Deferring it would have shipped to production the one thing Run 2 never
exercised.

The secret objection does not force deferral — the notifier secret goes in the
Run 2 `.env`, exactly as `INFLOOP_API_TOKEN` already does. So
[`deploy/alertmanager.yml`](../deploy/alertmanager.yml) stays the burn-in
default (the `null` receiver), and the observability overlay now also ships
[`deploy/alertmanager.slack.yml`](../deploy/alertmanager.slack.yml): set
`INFLOOP_ALERT_SLACK_WEBHOOK_URL` and the `alertmanager` service delivers to
Slack. Run 2 Phase 3 then confirms an injected alert *lands in the channel*,
not just on the UI. See [`docs/burn-in-run2-plan.md`](burn-in-run2-plan.md).

This amendment is itself a change merged under the freeze, and it is
consistent with the freeze rather than an exception to it. The freeze forbids
*preparation that substitutes for running Run 2*; this does the opposite — it
widens what Run 2 validates, converting an unvalidated post-Run-2 production
change into a burn-in-covered one. It is the last such change. The disciplined
next action is unchanged: execute Run 2.
