# MCP guide

Infinite Loop exposes every saved workflow as an MCP tool via a Streamable HTTP endpoint at `POST /api/mcp`. Any MCP-speaking client — Claude Code, Cursor, Cline, Zed, Continue.dev, OpenAI Codex CLI — can discover and invoke Infinite Loop workflows by name.

Workflow discovery is **per-call**, so a workflow you save right now is visible on the very next `tools/list`. No restart, no client redeploy.

> **Backward compatibility.** Tools are named `infinite_loop_*` and the server identifies itself as `infinite_loop`. Older builds used the `inflooop_*` prefix (triple `o`) and the server id `inflooop`. `tools/call` still accepts the legacy names as silent aliases, so any client config that hardcoded them keeps working — only the canonical names appear in `tools/list`.

## Contract

| Field | Value |
|---|---|
| **url** | `http://localhost:3000/api/mcp` (or wherever Infinite Loop runs) |
| **auth** | `Authorization: Bearer <INFLOOP_API_TOKEN>` — required only when `INFLOOP_API_TOKEN` is set on the server |

## Clients

**Claude Code**

```bash
claude mcp add --transport http infinite_loop http://localhost:3000/api/mcp
```

The transport flag may vary across Claude Code versions; try `--transport streamable-http` if the above doesn't work. Run `claude mcp add --help` to see what your version accepts. Then `/mcp` in any session to confirm registration.

**Cursor, Cline, Zed, Continue.dev, OpenAI Codex CLI** — open your client's MCP config and add:

```json
{
  "mcpServers": {
    "infinite_loop": {
      "url": "http://localhost:3000/api/mcp"
    }
  }
}
```

That's the whole entry — no `command`, no `args`, no local runtime to install on the client.

**Hermes or any runtime that accepts an MCP URL**:

```yaml
mcp_servers:
  infinite_loop:
    url: http://localhost:3000/api/mcp
```

## Authenticating

If `INFLOOP_API_TOKEN` is set on the server, every request must carry the token. Most clients accept a `headers` map:

```json
{
  "mcpServers": {
    "infinite_loop": {
      "url": "http://localhost:3000/api/mcp",
      "headers": { "Authorization": "Bearer <your-token>" }
    }
  }
}
```

> **Heads-up.** Setting `INFLOOP_API_TOKEN` protects the HTTP API against off-host callers. The browser UI keeps working — it redirects to a login page where you enter the token once. MCP clients authenticate with the `Authorization: Bearer` header shown above.

## Tools exposed

- **One tool per workflow** — named after the workflow id (sanitized to `[a-z0-9_]`), with inputs derived from the workflow's `inputs[]`. The call **enqueues** a run (non-blocking) and returns `{ queueId, position }`. Poll with `infinite_loop_get_run_status` using the `queueId`.
- **`infinite_loop_get_run_status({ workflowId?, runId?, queueId? })`** — fetch status and outputs. Use `queueId` to track a workflow-tool call: it transitions `queued → started` and exposes `runId` once it starts.
- **`infinite_loop_list_runs({ workflowId? })`** — list recent runs.
- **`infinite_loop_cancel_run({ workflowId, runId })`** — cancel the active run if its id matches.
- **`infinite_loop_list_queue()`** — list pending workflow runs in queue order.
- **`infinite_loop_remove_from_queue({ queueId })`** — drop a queued run before it starts.

## Verify without an MCP client

```bash
curl -s -X POST http://localhost:3000/api/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq
```

You'll see one tool per saved workflow plus the five `infinite_loop_*` utility tools.

## Concurrency

The engine runs **one workflow at a time**. Additional MCP calls and webhook hits queue in FIFO order (cap 100); the UI shows a queue badge and a `/queue` page where you can cancel individual queued items.
