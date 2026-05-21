# Configuration

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` (then next free, up to +20) | HTTP port |
| `HOST` | `127.0.0.1` | Bind address; loopback-only by default. Set `0.0.0.0` (or a LAN IP) to expose on the network — see `INFLOOP_ALLOW_INSECURE`. |
| `INFLOOP_API_TOKEN` | _(unset)_ | When set, all `/api/*` calls require authentication. MCP/API clients pass `Authorization: Bearer <token>`; the browser UI prompts for the token at a login page. |
| `INFLOOP_ALLOW_INSECURE` | _(unset)_ | Set to `1` to allow a network-reachable bind with **no** `INFLOOP_API_TOKEN`. Without it, the server refuses to start in that configuration (it would be unauthenticated remote code execution). Trusted networks only. |
| `INFLOOP_WORKFLOWS_DIR` | `<cwd>/workflows` | Where workflow JSON lives |
| `INFLOOP_TRIGGERS_DIR` | `<cwd>/triggers` | Where webhook trigger JSON lives |
| `INFLOOP_RUNS_DIR` | `<cwd>/runs` | Where completed-run records are persisted |
| `INFLOOP_RUN_HISTORY_LIMIT` | `100` | Max persisted runs per workflow (oldest pruned first) |
| `INFLOOP_MAX_RUN_NODE_EXECUTIONS` | `10000` | Run-level safety ceiling: max node-execution steps per run before it is aborted and marked failed. Bounds runaway loops, including `infinite: true`. `0` disables. |
| `INFLOOP_MAX_RUN_DURATION_MS` | `86400000` (24h) | Run-level wall-clock cap, in milliseconds, checked at each node-step boundary (a single long-running node is not interrupted mid-flight). A backstop against a genuinely-stuck run, not a tight SLA. `0` disables. |
| `INFLOOP_MAX_RUN_COST_USD` | `0` (disabled) | Run-level cost ceiling, in US dollars. When set, a run is aborted and marked failed once accumulated provider-reported cost exceeds it. Only providers that report cost are counted (currently the `claude` CLI); HTTP providers report none. `0` disables. |
| `INFLOOP_MAX_TOTAL_COST_USD` | `0` (disabled) | Process-wide cost ceiling, in US dollars, summed across **all** runs since startup. Once cumulative provider-reported cost exceeds it, new runs are refused (`POST /api/run` → `503`), in-flight runs abort at their next costed node, and the trigger-queue drain pauses — queued runs are held on disk to resume after a restart. Process-lifetime and in-memory — a restart resets the total. `0` disables. Exposed live as `infloop_cost_budget_spent_usd` / `infloop_cost_budget_limit_usd` on `/api/metrics`. |
| `INFLOOP_MAX_TOTAL_EVENT_BUFFER` | `200000` | Process-wide ceiling, in events, on workflow events buffered in memory across all concurrent runs. Each run's event buffer is dynamically squeezed to a fair share of this ceiling, so a burst of triggers cannot grow memory without bound. A non-numeric, zero or negative value falls back to the default. Exposed live as `infloop_event_buffer_events` / `infloop_event_buffer_limit` on `/api/metrics`. |
| `INFLOOP_PROVIDERS_DIR` | `<cwd>/providers` | Where provider manifests live |
| `INFLOOP_PROVIDER_BIN_<ID>` | _(unset)_ | Override the binary for provider `<ID>` (upper-cased), e.g. `INFLOOP_PROVIDER_BIN_CLAUDE=/opt/claude` |
| `INFLOOP_CLAUDE_BIN` | `claude` | Legacy override for the `claude` provider only — kept for back-compat |
| `INFLOOP_PYTHON_BIN` | `python3` | Interpreter for Script nodes with `language: py` |
| `INFLOOP_BUN_BIN` | `bun` | Interpreter for Script nodes with `language: ts` |
| `INFLOOP_CHILD_ENV_PASSTHROUGH` | _(unset)_ | Extra host environment variables to expose to spawned Agent/Script children, on top of the scrubbed non-secret allowlist. Comma-separated exact names or `PREFIX_*` trailing wildcards (e.g. `AWS_*,SSH_AUTH_SOCK`). The `INFLOOP_` namespace is never passed regardless. See [security.md](security.md#containment-of-executed-code). |
| `INFLOOP_EGRESS_ENFORCE` | _(unset)_ | Set to `1` to route a CLI provider child's HTTP(S) traffic through a per-run filtering proxy that permits only the hosts named in the manifest's `egressAllowlist`. Off-allowlist requests get `403`; if the proxy cannot start, the run fails closed. Off by default — children spawn with unrestricted egress. See [security.md](security.md#per-run-egress-allowlist). |
| `INFLOOP_WEBHOOK_PLUGINS_DIR` | `<cwd>/webhook-plugins` | Where webhook plugin manifests live |
| `INFLOOP_LOG_LEVEL` | `info` | Minimum level for structured server logs (`debug`, `info`, `warn`, `error`) |
| `INFLOOP_AUDIT_MAX_BYTES` | `5000000` | Size threshold (bytes) at which the audit log rotates to a new file |
| `INFLOOP_AUDIT_MAX_FILES` | `5` | Rotated audit-log generations to keep, excluding the current file (minimum `1`) |
| `INFLOOP_WEBHOOK_RATE_LIMIT` | `120` | Max webhook deliveries accepted per minute, per trigger, before further requests get `429` |
| `INFLOOP_LOGIN_RATE_LIMIT` | `20` | Max browser-login attempts accepted per minute (one global bucket) before further attempts get `429` |

## Startup validation

The numeric and enum-valued `INFLOOP_*` variables above are validated once at
startup. If any is **set to a malformed value** — non-numeric, negative, a
fractional value where a whole number is required, or a zero where a positive
number is required — the server prints a per-variable explanation and **refuses
to start**:

```
Invalid configuration — refusing to start:
  - INFLOOP_MAX_TOTAL_COST_USD is set to "abc" — expected a non-negative number (US dollars across all runs since startup; 0 disables the ceiling).
```

This is deliberate fail-fast behaviour. Without it a typo'd value silently
falls back to its default, and for a safety ceiling that default is *disabled*
— so a fat-fingered `INFLOOP_MAX_TOTAL_COST_USD` would leave an unattended
deployment running with no spend cap and nothing said so.

An **unset or empty** variable is not an error — the documented default
applies. A literal `0` is accepted wherever `0` is a meaningful value (it
disables that ceiling). The validator is intentionally strict about format: it
rejects trailing units and exponent/hex notation (`5usd`, `1e6`, `0x10`), so
write plain decimal values (`5`, `1000000`).

## Health & observability

`GET /api/health` is an unauthenticated liveness/readiness probe — it works
without a token even when `INFLOOP_API_TOKEN` is set, and also serves as the
version endpoint. It returns the running version, process uptime, and a
timestamp:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptimeSeconds": 42,
  "timestamp": "2026-05-21T00:00:00.000Z"
}
```

Live workload telemetry (run / child-process counts) is deliberately kept
off this endpoint — it answers unauthenticated, so activity counts would be
a reconnaissance signal in token-gated network mode.

Server-side diagnostics are emitted as one JSON object per line (`ts`,
`level`, `scope`, `msg`, plus call-specific fields) so they pipe cleanly into
a log aggregator. Raise or lower verbosity with `INFLOOP_LOG_LEVEL`.

### Metrics

`GET /api/metrics` renders process-lifetime operational counters and live
gauges in Prometheus text exposition format. Unlike `/api/health` it is
**authenticated** — run counts, cost, and queue depth are operational detail
and a reconnaissance signal, so the scrape must carry the token:

```yaml
scrape_configs:
  - job_name: infinite-loop
    metrics_path: /api/metrics
    authorization:
      credentials: <INFLOOP_API_TOKEN>
    static_configs:
      - targets: ['localhost:3000']
```

Without the token every scrape gets `401`, so Prometheus reports the target as
down — a common first-time misconfiguration.

The surface covers run outcomes and duration (`infloop_runs_total`,
`infloop_run_duration_seconds`), cost (`infloop_run_cost_usd_total` settled,
`infloop_cost_budget_spent_usd` / `infloop_cost_budget_limit_usd` live),
trigger-queue flow (`infloop_queue_*`), slot-pool saturation
(`infloop_slot_pool_*`), in-memory event-buffer pressure
(`infloop_event_buffer_*`), and webhook outcomes
(`infloop_webhook_requests_total`). Every series carries a `# HELP` line.

A ready-to-load set of alerting rules wired to these metrics ships at
[`deploy/prometheus-alerts.yml`](../deploy/prometheus-alerts.yml) — instance
down, high run-failure rate, queue drops and backlog, slot saturation,
event-buffer and cost-budget pressure, and webhook error rate. For a windowed
(e.g. daily) cost view, alert on `increase(infloop_run_cost_usd_total[24h])`;
`infloop_cost_budget_spent_usd` itself is process-lifetime and resets on
restart.

## Audit log

Trust- and security-relevant events are recorded in a durable, append-only
audit log at `<data-dir>/audit/audit.jsonl` — one JSON object per line. Unlike
run history, it is never pruned to a small window: it rotates by size
(`INFLOOP_AUDIT_MAX_BYTES`, default 5 MB) and keeps `INFLOOP_AUDIT_MAX_FILES`
rotated generations (default 5).

It captures what the proxy in front of the app cannot see: run lifecycle
(`started` / `finished`, including crash-recovered runs), login attempts
(success and failure), trigger CRUD, and webhook accept/reject decisions. Each
entry carries a timestamp, category, action, outcome, a coarse actor, the
affected resource id, and a small detail payload — never a secret.

Read recent entries (newest-first) with the authenticated endpoint:

```bash
curl -H "Authorization: Bearer $INFLOOP_API_TOKEN" \
  'http://localhost:3000/api/audit?limit=50'
```

`?limit=` is clamped to `[1, 2000]` (default 200).

## Rate limiting

The two ingress surfaces that `INFLOOP_API_TOKEN` does not gate are
rate-limited in-process:

- **Webhook ingress** (`POST /api/webhook/<triggerId>`) — up to
  `INFLOOP_WEBHOOK_RATE_LIMIT` deliveries per minute *per trigger*. Caps how
  hard a leaked trigger URL can be hammered.
- **Browser login** (`POST /api/auth`) — up to `INFLOOP_LOGIN_RATE_LIMIT`
  attempts per minute, counted in a single global bucket.

Over the limit, the request is rejected with `429 Too Many Requests` and a
`Retry-After` header; a webhook rejection is also recorded in the audit log.
Each limit is a per-minute token bucket, so a whole minute's budget may arrive
as a burst. State is in-memory and per-process — a restart clears it. See
[security.md](./security.md#rate-limiting).

## Container resource limits

`docker-compose.yml` caps the container's memory and CPU. The orchestrator's
own heap is bounded (`INFLOOP_MAX_TOTAL_EVENT_BUFFER`), but the agent CLIs a
run spawns are not — a ballooning provider child, or a loop spawning agents,
can otherwise consume the whole host. With a cgroup limit a runaway run is
OOM-killed inside the container; `restart: unless-stopped` plus boot-time
crash recovery then reconciles, and the host stays up.

| Var | Default | Purpose |
|---|---|---|
| `INFLOOP_MEM_LIMIT` | `4g` | Container memory ceiling (`mem_limit`). The compose file pins `memswap_limit` to the same value, so the container gets **no swap** — the limit is hard. |
| `INFLOOP_CPUS` | `2.0` | Container CPU ceiling (`cpus`). |

These are read by `docker compose`, not the app — set them in `.env`. Two
caveats when tuning `INFLOOP_MEM_LIMIT`:

- The `tmpfs` mounts in `docker-compose.yml` (`/tmp` and the Next.js cache,
  ~768 MB combined) count against `mem_limit`, so the app effectively has
  `INFLOOP_MEM_LIMIT` minus ~768 MB. Size with that headroom and with
  `INFLOOP_MAX_CONCURRENT_RUNS` agent subprocess trees in mind.
- The no-swap guarantee depends on the **host kernel** having memory-swap
  accounting enabled. Where it is not, Docker logs a warning at container
  start and `memswap_limit` is silently ignored.

## Common recipes

**Loopback-only dev server (the default):**

```bash
bun run dev
```

Reachable only from this machine. No token needed.

**Token-gated server (UI + MCP):**

```bash
INFLOOP_API_TOKEN=$(openssl rand -hex 32) HOST=0.0.0.0 bun run start
```

The browser UI prompts for the token at a login page; MCP clients and the management API authenticate with `Authorization: Bearer <token>`.

**LAN-exposed server with no token (trusted networks only):**

```bash
INFLOOP_ALLOW_INSECURE=1 HOST=0.0.0.0 bun run start
```

Without `INFLOOP_ALLOW_INSECURE=1` the server refuses to start in this configuration — a network-reachable, unauthenticated Infinite Loop is unauthenticated remote code execution. See [security.md](security.md).

**Custom storage paths:**

```bash
INFLOOP_WORKFLOWS_DIR=/srv/infinite-loop/workflows \
INFLOOP_RUNS_DIR=/srv/infinite-loop/runs \
INFLOOP_TRIGGERS_DIR=/srv/infinite-loop/triggers \
bun run start
```

**Tightening the runaway guard:**

```bash
# Abort any run over 2000 node steps, 30 minutes of wall-clock, or $5 of cost,
# and refuse new runs once cumulative spend since startup passes $100.
INFLOOP_MAX_RUN_NODE_EXECUTIONS=2000 \
INFLOOP_MAX_RUN_DURATION_MS=1800000 \
INFLOOP_MAX_RUN_COST_USD=5 \
INFLOOP_MAX_TOTAL_COST_USD=100 \
bun run start
```

The node and wall-clock ceilings are on by default (10000 steps / 24h) and
bound every run; the two cost ceilings are opt-in — `INFLOOP_MAX_RUN_COST_USD`
to your real per-run budget, `INFLOOP_MAX_TOTAL_COST_USD` to the most a
process should ever spend before a human checks in. **Behavior note:** the 24h wall-clock cap is a default — a run that
legitimately needs to exceed it must set `INFLOOP_MAX_RUN_DURATION_MS` higher
or to `0`. See [docs/security.md](./security.md#runaway-protection).

**Containerized deployment:**

```bash
docker compose up -d --build
```

Runs Infinite Loop as a supervised container — auto-restart on crash, a
`/api/health` healthcheck, and a persistent `/data` volume. Requires
`INFLOOP_API_TOKEN`. Full guide: [deployment.md](./deployment.md).
