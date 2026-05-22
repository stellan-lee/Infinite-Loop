# Burn-in Run 2 — pre-flight dress-rehearsal

[`burn-in-run2-plan.md`](burn-in-run2-plan.md) is the **plan** for Run 2 — host
sizing, the two `.env` profiles, the phase-by-phase steps. Run 2 itself is
blocked on infrastructure no script can supply: a real Linux host, a
credentialed provider, and a 24–72h window.

This file is the **record of dress-rehearsing** that plan, done on 2026-05-22
on the local macOS host while the infrastructure is still being arranged — and
re-run the same day against a new candidate after a deployment-shape change
(see *Re-run trigger* below). The point of a dress-rehearsal is narrow but
real: prove that every step of the plan that does *not* need a host actually
works, so that when the host appears the run starts clean instead of failing
on a typo or a stale reference hours in. It is the staging-side counterpart to
[`BURN-IN.md`](../BURN-IN.md) — that file records the runs; this one records the
preparation for one.

## What a dress-rehearsal can and cannot prove

It **can** prove: the frozen candidate builds and its tests pass; the burn-in
tooling runs, parses its arguments, and fails cleanly on a bad setup; every
command and flag the plan tells the operator to type actually exists; and the
plan's internal references are consistent.

It **cannot** prove anything the burn-in exists to prove — the cost ceiling
tripping on real spend, behaviour on real Linux, or drift over a multi-day
soak. Those remain Run 2's job and are listed under *Host-gated* below. A green
dress-rehearsal is a precondition for Run 2, not a substitute for it.

## Re-run trigger — the Slack-notifier deployment-shape change

The first pass of this rehearsal ran against the commit that added this
document. Commit `b695fe7` then landed on `main` — *"feat: wire an opt-in Slack
notifier and fold alert delivery into Run 2"* — and it is a **change to the
deployment shape**: a new `deploy/alertmanager.slack.yml`, +48 lines to
`deploy/docker-compose.observability.yml` (a second Alertmanager config mount
and a secret-materializing entrypoint), and a new `.env` knob,
`INFLOOP_ALERT_SLACK_WEBHOOK_URL`.

`docs/burn-in.md` requires the pre-flight be re-run after any change to the
deployment shape, and the rule stated above — *a green dress-rehearsal is a
precondition for Run 2* — means this record must track the actual candidate.
So the rehearsal was re-run **in full** against `b695fe7`. The results below
are that re-run; it found no defect.

The re-run was cheap because `b695fe7` carried regression coverage for its own
change: it extended `deploy/burn-in-preflight.test.ts` with a static gate for
the observability overlay — parsing it to assert the Slack config reads the
secret file the entrypoint writes (`api_url_file`), that the null receiver
stays the default when no webhook is set, and that the two Alertmanager
`route:` blocks stay identical bar the receiver name. That accounts for the
`+3` in both the suite (`1252 → 1255`) and the `deploy/` count (`74 → 77`)
since the first pass: the deployment-shape change shipped with the test that
guards it.

## Rehearsal results

All checks below were re-run against `b695fe7` — the current
`burn-in-run2-candidate` and `main` HEAD.

| Check | Command | Result |
|---|---|---|
| Full test suite | `bun test` | **1255 pass, 1 skip, 0 fail** (117 files, ~9s) |
| Type check | `bun run typecheck` (`tsc --noEmit`) | **clean** — no errors |
| Burn-in driver unit tests | `bun test deploy/` | **77 pass, 0 fail** (4 files) |
| Observability overlay parses | `docker compose … -f deploy/docker-compose.observability.yml config` | **valid** — with and without `INFLOOP_ALERT_SLACK_WEBHOOK_URL` set |
| Driver `--help` | each of `burn-in-driver`, `burn-in-soak-load`, `burn-in-soak-watch` | prints usage, **exit 0** |
| Driver bad-argument handling | e.g. `--bogus`, `--interval abc` | rejected with a usage error, **exit 2** |
| Driver preflight on an unreachable host | each driver against a dead URL | clean `Preflight FAILED: …` message, **exit 1** — no stack trace, no hang |

The observability-overlay parse is new for this re-run: `b695fe7` is the commit
that rewrote that overlay, so a `docker compose config` over it — layered the
way [`burn-in-run2-plan.md`](burn-in-run2-plan.md) deploys it — confirms the
second Alertmanager mount and the secret-materializing entrypoint are valid
Compose before a host ever sees them.

The dead-host preflight check matters: it exercises each driver's module load
(including `burn-in-soak-load.ts` and `burn-in-soak-watch.ts` importing
`readMetric` from `burn-in-driver.ts`), argument parsing, and error path
end to end — everything except the part that needs a live stack. A driver that
only fails once it is hours into a soak is the failure mode this check rules
out.

### Plan command/flag audit

Every command in [`burn-in-run2-plan.md`](burn-in-run2-plan.md) — the
phase-by-phase steps and the quick-reference block — was checked against the
drivers' actual argument parsers and against `package.json`:

- `bun run burn-in` / `soak-load` / `soak-watch` — all three `scripts` entries
  exist.
- `burn-in`: `--preflight-only`, `--confirm-spend`, `--prometheus` — all real.
- `soak-load`: `--duration`, `--interval`, `--concurrency` — all real.
- `soak-watch`: `--duration`, `--interval`, `--docker-container`, `--out`,
  `--rss-growth-threshold` — all real.

No command in the plan references a flag the drivers do not implement.

## Defect found & fixed — stale `burn-in-run2-candidate` tag

The dress-rehearsal found one real defect, and it would have broken Run 2 on
its very first step.

The plan's Phase 0 tells the operator to `git checkout burn-in-run2-candidate`.
That annotated tag — already pushed to `origin` — pointed at commit `efa982e`
("fix: make the test suite hermetic against a developer .env"). But **four
commits landed on `main` after the tag was placed and the tag was never moved
forward**:

| Commit | What the candidate was missing |
|---|---|
| `39bcc1d` | `deploy/burn-in-soak-load.ts` — the **Phase 5 load generator** (`bun run soak-load`) |
| `a0c76a4` | the scheduled-backup sidecar — the subject of **Phase 3.10** |
| `13dc22e` | the `InfiniteLoopBackupStale` alert — the **11th** alert rule |
| `6cc37eb` | `docs/burn-in-run2-plan.md` — **the plan itself** |

An operator following the plan to the letter would have checked out a tree
that does not contain the plan, cannot run `bun run soak-load` (so Phase 5
generates no load and its observer passes vacuously), has no backup sidecar to
exercise in Phase 3.10, and ships only ten alert rules — failing Phase 1's
explicit "verify **all eleven**" check against the candidate's own code.

**Fix:** the `burn-in-run2-candidate` tag was moved forward to the commit that
adds this document — a commit that contains the plan, all three burn-in
drivers, the backup sidecar, and all eleven alert rules. The plan's
`git checkout burn-in-run2-candidate` instruction is now correct as written.
This was a force-update of an existing tag; it is safe because Run 2 has never
run and nothing has consumed the old candidate.

### Re-run against `b695fe7` — no further defect

The re-run found nothing new. The suite, the type check, and all three drivers
behave exactly as in the first pass; the observability overlay parses as valid
Compose both with and without `INFLOOP_ALERT_SLACK_WEBHOOK_URL` set; and the
Slack wiring is covered by the static gate noted under *Re-run trigger* above.

`b695fe7` is functionally the rehearsed tree, but its *embedded* copy of this
document predates the re-run. So — exactly as in the first pass — the
`burn-in-run2-candidate` tag is moved forward to the commit that records this
re-run, keeping the plan's `git checkout burn-in-run2-candidate` instruction
pointed at a tree whose pre-flight record is accurate. The move is a docs-only
delta over `b695fe7`: nothing in the deployable image, the compose files, or
the alert rules changes, so the candidate tree stays dress-rehearsal-clean by
construction.

## Host-gated — what only Run 2 can close

Unchanged by this rehearsal; carried forward verbatim from the plan so the
boundary stays explicit:

1. **Phase 5 soak (24–72h)** — memory leaks, RSS drift, gauge ratchets, fd
   exhaustion. By construction, a short run cannot find these.
2. **Real Linux host pass** — TLS termination, a real reverse proxy, real
   network egress, real disk-full behaviour, and `restart: unless-stopped`
   auto-restart on a `docker kill` (which did *not* fire on Docker Desktop /
   macOS in Run 1).
3. **Phase 3.3 — cost budget** — the highest-blast-radius control in the
   product, and still never exercised on real provider spend.
4. **Phase 3.6 — slot-pool saturation** — needs Agent nodes holding
   folder-touching locks, which needs a credentialed provider.
5. **Runbook operator-response steps** — Run 1 validated detection for every
   alert that fired but not the operator *response*; Run 2 walks each one.

## Verdict

The Run 2 candidate — `b695fe7`, re-rehearsed in full after the Slack-notifier
deployment-shape change — is **dress-rehearsal clean**: it builds, the full
suite (1255) and the type check pass, the observability overlay parses with and
without the Slack notifier configured, the burn-in tooling runs and fails
safely, and the plan is internally consistent with every command in it
runnable. The remaining work is exactly the host-gated list above, and it is
genuinely host-gated: it needs infrastructure, not more preparation.
