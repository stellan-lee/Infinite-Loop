# Workflow JSON format

Each workflow lives as one JSON file in `workflows/`. Saves are atomic and bump `version` on every write. Drop a hand-written JSON file in `workflows/` and refresh — the menu picks it up.

## Example

```jsonc
{
  "id": "loop-claude-until-condition",
  "name": "Loop Claude until condition",
  "version": 1,
  "createdAt": 1777359000000,
  "updatedAt": 1777359000000,
  "cwd": "/workspace/my-project",
  "nodes": [
    { "id": "start-1", "type": "start", "position": { "x": 80, "y": 200 }, "config": {} },
    {
      "id": "loop-1",
      "type": "loop",
      "position": { "x": 280, "y": 120 },
      "config": { "maxIterations": 5, "mode": "while-not-met" },
      "children": [
        { "id": "agent-1", "type": "agent", "position": { "x": 40, "y": 60 },
          "config": { "providerId": "claude", "prompt": "…", "timeoutMs": 60000 } },
        { "id": "cond-1", "type": "condition", "position": { "x": 320, "y": 60 },
          "config": { "kind": "sentinel", "against": "{{agent-1.stdout}}",
                      "sentinel": { "pattern": "DONE", "isRegex": false } } }
      ]
    },
    { "id": "end-1", "type": "end", "position": { "x": 760, "y": 200 },
      "config": { "outcome": "succeeded" } }
  ],
  "edges": [
    { "id": "e1", "source": "start-1", "sourceHandle": "next", "target": "loop-1" },
    { "id": "e2", "source": "loop-1",  "sourceHandle": "next", "target": "end-1" },
    { "id": "e3", "source": "agent-1", "sourceHandle": "next", "target": "cond-1" }
  ]
}
```

The optional root-level `cwd` is the workflow's global working directory. An
Agent node's own `cwd` overrides it; when neither is configured, execution
uses `/tmp`.

## Nodes

| Node | What it does | Outputs in scope | Branches |
|---|---|---|---|
| **Start** | Entry point. Holds the workflow's input declarations. | — | `next` |
| **End** | Settles the run as `succeeded` or `failed` and copies selected final outputs. | declared output names | (terminal) |
| **Agent** | Runs an agent through any provider — Claude, Codex, Hermes, your own. | `stdout`, `stderr`, `exitCode`, `durationMs`, `timedOut` | `next` (exit 0) / `error` |
| **OpenAI** | Makes one OpenAI-compatible HTTP completion with a strict imported JSON Schema. | `result` | `next` / `error` |
| **Script** | Inline TypeScript (Bun) or Python (`python3`). Reads typed named inputs; the function's return value is stored as `result`. | `result`, `stdout`, `stderr`, `durationMs` | `next` / `error` |
| **Condition** | Decides whether to continue. Three kinds: `sentinel`, `command`, `judge`. | `met`, `detail` | `met` / `not_met` / `error` |
| **Loop** | Repeats its body until a `Condition` says stop. Capped by `maxIterations` (or genuinely unbounded with `infinite: true`). | `iterations`, `broke` | `next` |
| **Branch** | Structured `lhs op rhs` predicate (`==`, `!=`, `contains`, `matches`) on templated values. | `result`, `lhs`, `rhs`, `op` | `true` / `false` / `error` |
| **Parallel** | Runs N children concurrently. Modes: `wait-all`, `race`, `quorum`. Error policy: `fail-fast` or `best-effort`. | `mode`, `completed`, `failed`, `children`, `winner?`, `winners?` | `all_done` / `first_done` / `quorum_met` / `error` |
| **Subworkflow** | Calls another workflow as a single step with isolated I/O. Inputs are templated in; named outputs are copied back. | declared output names, plus `status`, `errorMessage?` | `next` / `error` |
| **Sidenote** | A free-form sticky note on the canvas. No effect at runtime. | — | — |

## Conditions

| Kind | Best for | Cost |
|---|---|---|
| **sentinel** | The agent reliably emits a marker (`DONE`, `PASS`) when it's finished | Free, instant |
| **command** | Ground-truth checks on disk — `test -f hello.txt`, `pytest -q`, `tsc --noEmit` | One subprocess per iteration |
| **judge** | Qualitative goals — "is the README clear?", "did the answer match the user's level?" | One extra agent call per iteration |

## Templating

Every text field — an Agent's `prompt` and `cwd`, an OpenAI node's `prompt`, a Condition's `against`, a Branch's `lhs`/`rhs`, a Script's `inputs.*`, a Subworkflow's `inputs.*` — supports `{{node-id.field}}` templating, resolved against the run's flat scope before the node executes. The config panel autocompletes references from the upstream graph.

Reserved scopes:

- `{{__inputs.NAME}}` — workflow inputs supplied by the caller (UI modal, MCP call, or webhook).
- `{{globals.NAME}}` — workflow-level constants declared on the workflow root.

An End node may declare `outputs` as a map of output names to single dotted
scope paths, for example `"outputs": { "answer": "agent-1.stdout", "ok":
"branch-1.result" }`. Choose variables in the End node's configuration.
Bindings copy the original JSON value, including booleans and objects;
unavailable or nullish paths become `null`. They are recorded as End node
outputs and as the run's `finalOutputs`, shown in the run detail. This works
for both succeeded and failed End outcomes. A run that fails before reaching
an End has no selected final outputs.

## Workflow library

`workflows/library/` holds repo-shipped, read-only presets. They appear in the workflow menu with a `[library]` tag — open, run, or duplicate them into your own `workflows/` for editing, but they can never be overwritten in place.


## Run history

Every finished run is persisted at `runs/<workflowId>/<runId>.json` — one JSON file per run, capturing the full event log, final scope, and per-node outputs. The History panel lists them, replays per-node input/output cards, and links each card back to the node on the canvas.

- Per-run event log is capped at **50,000 events** (oldest dropped first; `truncated: true` is set on the record).
- Per-workflow history retention is capped by `INFLOOP_RUN_HISTORY_LIMIT` (default `100`).

### Agent HOME and CODEX_HOME

Agent configuration accepts independent optional `home` and `codexHome` strings
for capable CLI providers (the shipped Codex provider). Blank or omitted values
inherit that variable; setting HOME alone preserves inherited CODEX_HOME, and an
unset CODEX_HOME retains Codex's normal default under the effective HOME. Values
are trimmed, must not contain NUL, and are literal paths: no `~`, `$VAR`, or
`{{...}}` expansion. Relative paths resolve against the final worker cwd,
including its run-owned worktree. Requested directories are created recursively;
creation failures take the Agent error branch before launch.

For example, `"home": ".worker/user", "codexHome": ".worker/codex"` selects
two roots under the worker directory. Either setting adds the manifest's
`-c allow_login_shell=false` restriction. Leaving both unset preserves previous
launch arguments and environment. Switching providers preserves saved values;
unsupported providers reject configured overrides. Clearing the editor fields
removes them.

Absolute paths are appropriate for persistent state. Relative homes inside a
run-owned worktree share its run-end cleanup lifecycle. Explicitly shared
absolute roots share Codex state and its concurrency behavior. Fresh Codex homes
may require operator-provided authentication/configuration; nothing is copied
from the host. These settings do not provide filesystem isolation.
