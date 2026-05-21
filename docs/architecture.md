# Architecture

```
 Browser
   ├─ canvas (xyflow)  ◀──── /api/workflows/<id>      (loads workflow JSON)
   ├─ palette (drag)
   ├─ config panel
   └─ run view (SSE consumer)
                            ▲
                            │ HTTP (start/stop/save) + Server-Sent Events
                            ▼
 Bun + Next.js (server.ts)
   ├─ /api/workflows          CRUD against workflows/*.json
   ├─ /api/run                POST → workflowEngine.start(wf)
   ├─ /api/run/stop           POST → workflowEngine.stop()
   ├─ /api/events             text/event-stream → live events
   ├─ /api/mcp                Streamable HTTP MCP endpoint
   ├─ /api/webhook/<id>       webhook ingress (queues a run)
   └─ /api/triggers, /api/runs, /api/providers, /api/webhook-plugins
                            │
                            ▼
 WorkflowEngine (singleton)
   ├─ Graph walker with built-in Loop / Parallel / Subworkflow semantics
   ├─ Per-node executor → provider runner (spawn CLI or HTTP call)
   ├─ Templating resolver: {{node-id.field}} over flat scope
   └─ Event buffer (5k live for refresh hydration, 50k persisted per run)
```

## Tech stack

- **Runtime:** Bun
- **Server:** Next.js 15 (App Router) + a thin custom server (`server.ts`)
- **Frontend:** React 19, Zustand for state, `@xyflow/react` v12 for the canvas, hand-written CSS with multi-hue Tokyo-Night-inspired tokens
- **Transport:** Server-Sent Events (`/api/events`)
- **Agent runners:** Pluggable providers — subprocess (`spawn`) or HTTP. See [providers.md](providers.md).
- **Tests:** `bun:test`, `@testing-library/react`, `@happy-dom/global-registrator`

## Why SSE, not WebSockets?

Native HTML/JSON, one-way (engine → browser), Bun-friendly, no upgrade dance. Stop and save go through normal `fetch` calls in the other direction.

## Why Bun?

Native TypeScript + ESM (no `tsx` shim), faster cold start than Node, single binary.

## Project layout

```
app/
  api/                  Next.js route handlers (workflows, run, events, mcp, webhook, …)
  components/
    canvas/             xyflow wrapper + custom node UIs
    Palette.tsx         draggable node-type list
    ConfigPanel.tsx     per-node-type config form (templating-aware)
    RunView.tsx         live event log + status pill + elapsed timer
    DispatchView.tsx    webhook trigger management UI
    WorkflowMenu.tsx    top-bar dropdown: list / new / duplicate / save / delete
  queue/                /queue page — pending workflow runs, per-item cancel
  page.tsx              top bar + tri-pane layout (palette · canvas · right panel)
lib/
  shared/workflow.ts    immutable types contract (Workflow, WorkflowNode, …)
  client/               Zustand store + SSE hook + undo/redo
  server/
    workflow-engine.ts  graph walker + Loop / Parallel / Subworkflow semantics
    workflow-store.ts   filesystem-backed CRUD
    run-store.ts        persists completed runs under runs/
    crash-recovery.ts   boot-time reaping of crash-orphaned children + runs
    child-registry.ts   tracks detached child PIDs (in-memory + on-disk)
    trigger-queue.ts    in-memory FIFO queue (cap 100)
    trigger-store.ts    webhook trigger persistence
    event-bus.ts        typed pub/sub
    nodes/              one executor per node type
    conditions/         sentinel / command / judge strategies
    providers/          provider manifest loader + CLI/HTTP runners
    mcp/                MCP tool schema generation + handlers
    webhook-plugins/    plugin manifest loader
providers/              runner manifests (Claude, Codex, Hermes, …)
webhook-plugins/        webhook source manifests (GitHub ships in the box)
workflows/              the workflow JSON store
  library/              read-only repo-shipped presets (Team, …)
runs/                   persisted run records, one folder per workflow
pids/                   live detached-child PID records (crash recovery)
active-runs/             in-flight run markers (crash recovery)
triggers/               webhook trigger configs, one file per trigger
docs/                   user-facing documentation
```
