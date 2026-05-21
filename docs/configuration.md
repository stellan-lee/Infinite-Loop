# Configuration

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` (then next free, up to +20) | HTTP port |
| `HOST` | `0.0.0.0` | Bind address; `127.0.0.1` to disable LAN access |
| `INFLOOP_API_TOKEN` | _(unset)_ | When set, all `/api/*` calls require authentication. MCP/API clients pass `Authorization: Bearer <token>`; the browser UI prompts for the token at a login page. |
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

**Loopback-only dev server:**

```bash
HOST=127.0.0.1 bun run dev
```

**Token-gated server (UI + MCP):**

```bash
INFLOOP_API_TOKEN=$(openssl rand -hex 32) HOST=0.0.0.0 bun run start
```

The browser UI prompts for the token at a login page; MCP clients and the management API authenticate with `Authorization: Bearer <token>`.

**Custom storage paths:**

```bash
INFLOOP_WORKFLOWS_DIR=/srv/infinite-loop/workflows \
INFLOOP_RUNS_DIR=/srv/infinite-loop/runs \
INFLOOP_TRIGGERS_DIR=/srv/infinite-loop/triggers \
bun run start
```
