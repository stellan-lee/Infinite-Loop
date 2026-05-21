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
