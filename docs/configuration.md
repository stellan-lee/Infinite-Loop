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
| `INFLOOP_MAX_RUN_DURATION_MS` | `0` (disabled) | Optional run-level wall-clock cap, in milliseconds, checked at each node-step boundary (a single long-running node is not interrupted mid-flight). `0` disables. |
| `INFLOOP_PROVIDERS_DIR` | `<cwd>/providers` | Where provider manifests live |
| `INFLOOP_PROVIDER_BIN_<ID>` | _(unset)_ | Override the binary for provider `<ID>` (upper-cased), e.g. `INFLOOP_PROVIDER_BIN_CLAUDE=/opt/claude` |
| `INFLOOP_CLAUDE_BIN` | `claude` | Legacy override for the `claude` provider only — kept for back-compat |
| `INFLOOP_PYTHON_BIN` | `python3` | Interpreter for Script nodes with `language: py` |
| `INFLOOP_BUN_BIN` | `bun` | Interpreter for Script nodes with `language: ts` |
| `INFLOOP_WEBHOOK_PLUGINS_DIR` | `<cwd>/webhook-plugins` | Where webhook plugin manifests live |
| `INFLOOP_LOG_LEVEL` | `info` | Minimum level for structured server logs (`debug`, `info`, `warn`, `error`) |
| `INFLOOP_AUDIT_MAX_BYTES` | `5000000` | Size threshold (bytes) at which the audit log rotates to a new file |
| `INFLOOP_AUDIT_MAX_FILES` | `5` | Rotated audit-log generations to keep, excluding the current file (minimum `1`) |

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
# Abort any run that exceeds 2000 node steps or 30 minutes of wall-clock.
INFLOOP_MAX_RUN_NODE_EXECUTIONS=2000 \
INFLOOP_MAX_RUN_DURATION_MS=1800000 \
bun run start
```

The node ceiling is the deterministic guard against unbounded loops; the
wall-clock cap is an optional hard stop. See [docs/security.md](./security.md#runaway-protection).

**Containerized deployment:**

```bash
docker compose up -d --build
```

Runs Infinite Loop as a supervised container — auto-restart on crash, a
`/api/health` healthcheck, and a persistent `/data` volume. Requires
`INFLOOP_API_TOKEN`. Full guide: [deployment.md](./deployment.md).
