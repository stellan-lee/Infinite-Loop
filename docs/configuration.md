# Configuration

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` (then next free, up to +20) | HTTP port |
| `HOST` | `127.0.0.1` | Bind address; loopback-only by default. Set `0.0.0.0` (or a LAN IP) to expose on the network — see `INFLOOP_ALLOW_INSECURE`. |
| `INFLOOP_API_TOKEN` | _(unset)_ | When set, all `/api/*` calls require `Authorization: Bearer <token>`. Disables the browser UI — use for headless servers only. |
| `INFLOOP_ALLOW_INSECURE` | _(unset)_ | Set to `1` to allow a network-reachable bind with **no** `INFLOOP_API_TOKEN`. Without it, the server refuses to start in that configuration (it would be unauthenticated remote code execution). Trusted networks only. |
| `INFLOOP_WORKFLOWS_DIR` | `<cwd>/workflows` | Where workflow JSON lives |
| `INFLOOP_TRIGGERS_DIR` | `<cwd>/triggers` | Where webhook trigger JSON lives |
| `INFLOOP_RUNS_DIR` | `<cwd>/runs` | Where completed-run records are persisted |
| `INFLOOP_RUN_HISTORY_LIMIT` | `100` | Max persisted runs per workflow (oldest pruned first) |
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

**Headless MCP server (no UI, token-gated):**

```bash
INFLOOP_API_TOKEN=$(openssl rand -hex 32) HOST=0.0.0.0 bun run start
```

The UI will refuse to load (browser can't forward the token), but MCP clients and the management API work normally with `Authorization: Bearer <token>`.

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
