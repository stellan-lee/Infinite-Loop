# Deployment

How to run Infinite Loop as a long-lived, supervised service — the setup a
team would put behind a Cloudflare Tunnel, a Tailscale ACL, or a reverse
proxy.

For a loopback-only dev server you need none of this — `bun run dev`
([Quickstart](../README.md#quickstart)) is enough.

## What you get

The repo ships a `Dockerfile` and `docker-compose.yml` that run Infinite Loop
as a supervised container:

- **Auto-restart** (`restart: unless-stopped`). Infinite Loop's crash
  recovery runs only at boot — it reaps orphaned agent CLIs and reconciles
  interrupted runs into `failed` history. A bare process that hits an
  `uncaughtException` calls `exit(1)` and stays down; under Docker it
  restarts, so crash recovery actually runs.
- **Health checks.** A `HEALTHCHECK` polls the unauthenticated `/api/health`
  probe; `docker ps` then shows `healthy` / `unhealthy`.
- **A persistent volume** for all run history, workflows, triggers, and
  connections, so they survive a restart or an image rebuild.
- **Scheduled backups.** A `backup` sidecar snapshots the data volume on a
  schedule and keeps a fixed number of generations — see [Backups](#backups).

## Prerequisites

- Docker Engine 23.0+ with the Compose plugin (`docker compose`). BuildKit —
  required by this multi-stage build — is the default backend from 23.0; on
  an older daemon enable it explicitly (`DOCKER_BUILDKIT=1`).
- That's it — Bun, Node, and the build toolchain all live inside the image.

## Quick start

1. Create a `.env` file with an API token (Compose reads `.env`
   automatically):

   ```bash
   cp .env.example .env
   echo "INFLOOP_API_TOKEN=$(openssl rand -hex 32)" >> .env
   ```

   `.env` is gitignored. The token is **required** — see
   [Why a token is mandatory](#why-a-token-is-mandatory).

2. Build and start:

   ```bash
   docker compose up -d --build
   ```

3. Open <http://localhost:3000> and log in with the token from `.env`.

Check status and logs:

```bash
docker compose ps        # STATUS shows (healthy) once the probe passes
docker compose logs -f
```

## How network exposure works

A container has its own network namespace, so there are *two* independent
bind decisions — don't conflate them:

| Layer | Setting | Default | Effect |
|---|---|---|---|
| Inside the container | `HOST` env | `0.0.0.0` (set in compose) | App listens on every *container* interface — required for the published port to reach it. |
| Host ↔ container | `ports:` in compose | `127.0.0.1:3000:3000` | Publishes the port to the **host loopback only**. |

With the defaults, Infinite Loop is reachable at `http://localhost:3000`
**on the Docker host only** — nothing on your LAN can reach it. Put a reverse
proxy or tunnel in front for real access (see
[Putting it behind a proxy](#putting-it-behind-a-proxy)).

To expose it directly on the LAN, change the port mapping to `3000:3000` in
`docker-compose.yml`. Only do that on a trusted network.

## Why a token is mandatory

Infinite Loop executes arbitrary code (agent CLIs, shell, scripts), so the
[network-posture gate](security.md#default-network-posture) **refuses to
start** any non-loopback bind without an `INFLOOP_API_TOKEN`. The container
binds `0.0.0.0` internally — non-loopback — so a token is required.

`docker compose up` fails fast with a clear message if `INFLOOP_API_TOKEN` is
unset. (You can instead acknowledge the risk with `INFLOOP_ALLOW_INSECURE=1`,
but only on a fully trusted network, and never with the port mapping opened
to the LAN.)

## Configuration

The compose file sets sensible defaults; override them via `.env` or the
`environment:` block.

| Var | Set by | Purpose |
|---|---|---|
| `INFLOOP_API_TOKEN` | `.env` (required) | Bearer token gating `/api/*`. |
| `HOST` | compose (`0.0.0.0`) | In-container bind — leave as is. |
| `PORT` | image (`3000`) | In-container port. |
| `INFLOOP_DATA_DIR` | image (`/data`) | Root of all persistent state; the volume mounts here. |
| `INFLOOP_LOG_LEVEL` | `.env` (`info`) | `debug` / `info` / `warn` / `error`. |

Every other knob from [configuration.md](configuration.md) works too — add it
to the `environment:` block.

### Data & persistence

All mutable state — the workflows you save, run history, webhook triggers,
connections, and the crash-recovery markers — lives under `INFLOOP_DATA_DIR`
(`/data`), backed by the named volume `infinite-loop-data`. It survives
`docker compose down` and image rebuilds.

The library presets shipped in the repo (`workflows/library/`) are a separate
thing: they are baked into the image, read-only, and not part of the volume.

```bash
docker compose down -v   # stop AND wipe all state (deletes the volume)
```

## Backups

The persistent volume survives restarts and rebuilds — it does **not** survive
disk loss, a deleted volume, or operator error. Crash recovery, the durable
queue, and the audit log all protect against a process dying; none protects
against losing the volume itself.

`docker-compose.yml` includes a **`backup` sidecar** that closes this gap: it
snapshots the data volume on a schedule (default every 24h), keeps a fixed
number of generations, and writes them to a separate `infinite-loop-backups`
volume. It starts with the stack — `docker compose up -d` — so backups are
automatic, with no manual step. Tune the interval and retention via
`INFLOOP_BACKUP_INTERVAL_HOURS` and `INFLOOP_BACKUP_KEEP` in `.env`, and watch
it with `docker compose logs -f backup`.

For a one-off snapshot — before an upgrade, say — you can still run a backup by
hand:

```bash
# Write a snapshot to the volume, then copy it off the host.
docker compose exec infinite-loop bun run backup --out /data/backup.tar.gz
docker compose cp infinite-loop:/data/backup.tar.gz ./backup.tar.gz
docker compose exec infinite-loop rm /data/backup.tar.gz
```

A backup is safe to take while the server runs; restoring requires the server
to be stopped. The sidecar's volume still lives on this host — copy archives
off-host for true disaster recovery. Full procedure — the sidecar's knobs,
restore, and inspecting an archive — in [backup-restore.md](backup-restore.md).

## Supervision & health

- **`restart: unless-stopped`** restarts the container after any abnormal
  exit — the mechanism that makes boot-time crash recovery run at all.
- **`init: true`** runs a real init (tini) as PID 1, so detached agent/script
  child processes that get re-parented are reaped instead of becoming
  zombies.
- **`HEALTHCHECK`** polls `/api/health` every 30s.

Note: a restart policy reacts to the process *exiting*, not to an `unhealthy`
health check. A hung-but-alive process shows `unhealthy` in `docker ps` but
is not auto-killed — wire that signal to your orchestrator if you need it.

## Monitoring

`/api/health` answers liveness and readiness; it does not answer *how the
workload is doing*. For that, scrape **`GET /api/metrics`** — Prometheus text
exposition format, ready to point Grafana or Alertmanager at.

Unlike `/api/health`, this endpoint is **authenticated** — run counts, cost and
queue depth are operational detail and a reconnaissance signal. Scrape it with
the API token:

```bash
curl -H "Authorization: Bearer $INFLOOP_API_TOKEN" http://localhost:3000/api/metrics
```

A Prometheus scrape config carries the token in `authorization`:

```yaml
scrape_configs:
  - job_name: infinite-loop
    authorization:
      credentials: <INFLOOP_API_TOKEN>
    static_configs:
      - targets: ['localhost:3000']
```

What it exposes (all metrics are prefixed `infloop_`):

| Metric | Type | Use |
|---|---|---|
| `runs_total{status}` | counter | Run success/failure rate, by terminal status. |
| `run_duration_seconds` | histogram | Run-duration distribution drifting up. |
| `run_cost_usd_total` | counter | Cumulative provider-reported spend. |
| `node_executions_total` | counter | Workflow throughput. |
| `queue_enqueued_total` / `queue_dropped_total{reason}` | counter | Trigger-queue intake vs. drops. |
| `webhook_requests_total{outcome}` | counter | Webhook ingress, by coarse outcome. |
| `runs_active`, `queue_depth` | gauge | Live load — alert before `queue_depth` nears the cap of 100. |
| `slot_pool_in_use` / `slot_pool_capacity` / `slot_pool_waiting` | gauge | Concurrency saturation. |
| `event_buffer_events` / `event_buffer_limit` | gauge | In-memory event-buffer pressure — OOM headroom. |
| `cost_budget_spent_usd` / `cost_budget_limit_usd` | gauge | Live cumulative spend vs. the process-wide cost ceiling. |
| `process_uptime_seconds` | gauge | Catches restarts. |

Counters are process-lifetime and reset to 0 on restart. A run killed by a
hard process crash is reconstructed as `failed` at the next boot: it **is**
folded into `runs_total{status="failed"}` so the failure series stays honest
about crashes, but **not** into the `run_duration_seconds` histogram — a hard
crash leaves the wall-clock duration unknowable. The histogram's `_count` can
therefore legitimately trail `runs_total`; alert on `process_uptime_seconds`
resets to catch the restarts themselves.

A ready-to-load set of alerting rules covering these metrics ships at
[`deploy/prometheus-alerts.yml`](../deploy/prometheus-alerts.yml) — see
[configuration.md](configuration.md#metrics). When one of those alerts
fires, [runbook.md](runbook.md) has a per-alert operator response.

For a runnable local example — Prometheus already pointed at `/api/metrics`
with the token, the alert rules loaded, and Alertmanager and a reverse proxy
alongside — the repo ships
[`deploy/docker-compose.observability.yml`](../deploy/docker-compose.observability.yml),
the overlay the production [burn-in](burn-in.md) uses. Layer it on
`docker-compose.yml`.

## Known limitation — agent providers are not in the image

The image contains the **orchestrator** and the Bun runtime. It does **not**
contain agent provider CLIs (`claude`, `codex`, …) or a Python interpreter:

- **Agent nodes** need their provider CLI on `PATH` inside the container.
- **Script nodes** with `language: py` need `python3`.

TypeScript Script nodes work out of the box (Bun runs them). This is
deliberate: which agent runners you trust on a host is a deployment decision,
not something the base image should bake in.

To run Agent or Python nodes, extend the image with a thin overlay —
`FROM infinite-loop:local`, installing your provider CLIs and/or `python3` —
and, if a binary is not on `PATH` under its manifest name, point the provider
at it with `INFLOOP_PROVIDER_BIN_<ID>` (see
[configuration.md](configuration.md)).

The repo ships a worked example of exactly that overlay:
[`deploy/Dockerfile.providers`](../deploy/Dockerfile.providers) adds the
`claude` CLI on top of the base image. The production [burn-in](burn-in.md)
builds it — it requires a real provider — and it is a copyable starting point
for a real deployment:

```bash
docker compose build                                   # base: infinite-loop:local
docker build -f deploy/Dockerfile.providers -t infinite-loop:burn-in .
```

## Plain `docker run` (no Compose)

```bash
docker build -t infinite-loop:local .
docker run -d --name infinite-loop \
  --init \
  -p 127.0.0.1:3000:3000 \
  -e HOST=0.0.0.0 \
  -e INFLOOP_API_TOKEN="$(openssl rand -hex 32)" \
  -v infinite-loop-data:/data \
  infinite-loop:local
```

`HOST=0.0.0.0` and `INFLOOP_API_TOKEN` are both required (see above), and
`--init` replaces Compose's `init: true`.

## Putting it behind a proxy

Infinite Loop has no per-user auth — one shared token, no accounts — so do
not expose it straight to the internet. Webhook ingress and browser login are
rate-limited and trust-relevant events are recorded in an audit log, but for a
publicly reachable surface you should still front it with a Cloudflare Tunnel
and Access policy, a Tailscale ACL host, or a reverse proxy with HTTP auth, as
described in
[security.md](security.md#dont-expose-to-the-public-internet).

When the proxy terminates TLS, make sure it forwards `X-Forwarded-Proto:
https` — Infinite Loop reads it to mark the session cookie `Secure`.

## Verifying the deployment

A green test suite proves the components; it does not prove the deployment
works as an operated whole — that a `kill -9` is reconciled on the real
image, that the shipped alerts actually fire, that a backup actually
restores. Before relying on a new or reshaped deployment, run the
[burn-in](burn-in.md): a destructive, staging-only dress rehearsal that
injects every failure mode and confirms both the behaviour and the alert.

## Updating

```bash
git pull
docker compose up -d --build
```

The data volume is untouched by a rebuild.

## A note on image shape

The team's TypeScript Dockerfile standard asks for a distroless final image.
Infinite Loop cannot use one: its production runtime *is* Bun executing
`server.ts` as TypeScript (a Next.js custom server), so the image must ship
Bun, the production `node_modules`, and the server source. It still follows
the rest of the standard — a Bun-only multi-stage build, a
production-deps-only runtime on the slim base, and a non-root final image.
