# Production-smoke E2E suite

End-to-end verification that the assembled product works — the layer between
`bun test` (modules in isolation) and a real deployment.

`bun run test:e2e` builds the app, boots the **real production server**
(`NODE_ENV=production bun server.ts`) against a hermetic temp data dir and a
deterministic stub agent, then drives it through a real Chromium browser and
over HTTP.

## What it covers

| Spec                     | Check                                                            |
| ------------------------ | ---------------------------------------------------------------- |
| `health.e2e.ts`          | `/api/health` answers 200 unauthenticated                        |
| `auth.e2e.ts`            | API rejects anonymous calls; browser login flow works            |
| `flow-routing.e2e.ts`    | Home owns flow creation, rename, delete, and opening; flow URLs, history, and pending-edit navigation work |
| `home-jobs.e2e.ts`       | One home jobs list combines queued, live, and finished work with status colors, elapsed/stage updates, and failure recovery |
| `canvas.e2e.ts`          | Console shell loads; seeded workflow renders on the canvas       |
| `run.e2e.ts`             | UI-triggered run streams over SSE and lands in history           |
| `webhook.e2e.ts`         | Webhook ingress runs a workflow and is recorded in the audit log |
| `crash-recovery.e2e.ts`  | A run killed mid-flight is reconciled to `failed` on restart     |

## Determinism

The seeded workflow's Agent node uses the `e2e-echo` stub provider
(`fixtures/fake-agent.sh`) instead of a real model — so the suite is fast,
offline, and **spends no API credits**.

## Layout

- `fixtures/` — committed: stub agent script, seeded workflow JSON.
- `lib/` — shared constants and server/fixture helpers (no `@/` aliases; the
  suite is a pure black-box harness).
- `global-setup.ts` — recreates the hermetic `.tmp/` workspace before the run.
- `*.e2e.ts` — specs. Named `.e2e.ts`, not `.spec.ts`, so `bun test` ignores them.

Generated state lives in `.tmp/` and is gitignored.

## Notes

- Locally the config sets `reuseExistingServer: true` — if you already have
  something bound to port `3460` it will be used instead of a fresh hermetic
  server. Stop any such process before running the suite. In CI a fresh server
  is always started.
- The crash-recovery spec runs its own server on port `3461` with a separate
  data dir, so it never disturbs the shared server.
