# Concurrent runs

Design for running multiple workflows simultaneously, with a directory-scoped lock to prevent two runs from stomping on the same working tree.

## Problem

The engine is a process-global singleton with one in-flight run at a time. `start()` throws `"a run is already active"` if status is `running` (`lib/server/workflow-engine.ts:126-128`). The `TriggerQueue` exists solely to serialize fan-in against that singleton — its drain loop catches the busy error and re-prepends the head (`lib/server/trigger-queue.ts:128-131`).

The real hazard preventing concurrent runs is not CPU — it is that two Agent nodes pointed at the same `cwd` will race on the same filesystem and git state. A coarse "one run at a time" rule is the existing workaround.

## Goals

- Multiple workflow runs may be in flight at once.
- Two runs whose Agent nodes touch the same working directory must serialize automatically, without per-workflow configuration.
- Two runs touching disjoint directories run in parallel.
- Workflows whose Agent nodes touch no local directory (HTTP providers, all-`/tmp`, all-`useWorktree`) run unlimited.
- A configurable cap on simultaneous **folder-touching** runs, settable at boot and at runtime.
- The UI surfaces every active run, distinguishes "running", "waiting for lock", and "waiting for slot", and lets the user cancel any individual run.

## Non-goals

- Distributed locking across multiple server processes. The lock manager is in-process; only this server spawns the agents.
- Read/write lock distinction. Agents are uncontrolled; default to exclusive.
- Cross-workflow atomicity guarantees beyond what the directory lock provides.
- A soft cap on the *number* of in-flight runs. Run count is not bounded; the aggregate *memory* of their event buffers is — see the Memory note under Risks.
- Streaming `runEventLog` to disk.
- Per-workflow `concurrency: serial | parallel` flag. The directory lock supersedes it.

## Acceptance criteria

The implementation is complete when:

1. Two folder-touching runs against disjoint `cwd`s complete with overlapping wall time.
2. Two folder-touching runs against the same `cwd` (CLI provider) serialize and the latecomer's node emits `node_waiting_for_lock`.
3. Three sibling branches inside one Parallel node, all using HTTP providers, run concurrently and consume zero slots and zero locks.
4. Three sibling branches inside one Parallel node, all using a CLI provider with the same `cwd`, serialize against each other and emit `node_waiting_for_lock` between siblings.
5. 100 folder-free runs (HTTP providers, empty `cwd`) complete concurrently regardless of cap.
6. A wait-for cycle (A waits for `/b`, B waits for `/a`) fails the latecomer's `lockManager.acquire` call with `LockCycleError`. The agent node routes via its `error` handle if one is connected (with `errorMessage` containing the cycle path `[runIdA → runIdB → runIdA]`); otherwise the run settles as `failed`.
7. With cap=2 and three folder-touching runs triggered: the third's first non-exempt acquire emits `node_waiting_for_slot`; when one of the first two settles, the third's `node_slot_acquired` fires.
8. Lowering cap mid-flight does not preempt slot holders; they finish naturally.
9. Raising cap admits any current slot waiters immediately.
10. A slot waiter cancelled mid-wait settles as `cancelled`, never consumes a slot, and is removed from the wait queue cleanly.
11. `useWorktree` worktree paths register as exempt for the run's lifetime and never enter the lock manager's bookkeeping.
12. Single-run flows (one trigger, no contention) behave identically to the pre-change baseline from the user's perspective.

## Design

### Engine becomes a registry

Per-run state moves off the engine instance onto a `RunController`. The registry owns lookup + admission; the controller owns the run.

```
RunController {
  runId, workflow, snapshot, abort, edgesBySource,
  recentEvents, runEventLog, runEventLogTruncated,
  worktrees,
  slotHandle?: { release: () => void; acquiredAt: number },
  emit(event)               // stamps runId before forwarding to eventBus
  start(opts)               // walkFrom(start node)
  stop()                    // abort.abort()
  walkFrom, walkParallel, walkSubworkflow, walkLoop, ...
}
```

```
WorkflowEngine {                       // really a registry now
  runs: Map<runId, RunController>
  executors, loadWorkflow              // stateless, shared
  start(wf, opts) -> runId             // allocates controller, registers, kicks off walk
  getRun(runId)   -> RunController | undefined
  stop(runId | { all: true })
  list()          -> RunController[]
}
```

#### Method placement after refactor

| Today (`WorkflowEngine` method) | After refactor |
|---|---|
| `start` | `Registry.start` allocates controller + calls `controller.start` |
| `stop` | `Registry.stop(runId)`; controller-level abort |
| `getState` | `controller.getState()`; registry has `list()` / `getRun()` |
| `walkFrom`, `walkParallel`, `walkSubworkflow`, `walkLoop`, `walkBranch` | `RunController` |
| `runNode` (per-node executor wrapper) | `RunController` |
| `resolveConfigTemplates`, `namespaced` | `RunController` |
| `persistRun` | `RunController` (called in settle) |
| `reset` (tests only) | Removed; tests use `registry.clearAll()` |
| `indexEdges` | `RunController` constructor |

Subworkflows go through `RunController.walkSubworkflow` and share the parent's controller; they do **not** register a new run. Subworkflow nodeIds are namespaced as today (`<subwf-id>/<child-id>`) and inherit the parent's slot ownership and worktrees.

#### TOCTOU dance retired

`engineStartAdapter` (`lib/server/trigger-queue-singleton.ts:14-46`) only exists because the current `start()` is async-and-side-effecting before assigning `runId`. With a registry, `Registry.start` allocates and registers the controller synchronously, then returns `runId` and kicks off `controller.start()` in the background. The adapter is deleted; `TriggerQueue` calls `Registry.start` directly. Between registration and the first walk tick, `GET /api/runs/[workflowId]/[runId]` returns the seeded snapshot (`status: 'running'`, `events: []`, scope populated with `globals` + `inputs`). That is the right answer — the run exists and is starting; there is no separate "queued" state for direct `/api/run` posts since admission is lazy.

#### HMR

Bump `ENGINE_VERSION` and rename the global pin key to `__infiniteLoopWorkflowRegistry` so any stale dev-mode cached object with the old shape is simply ignored. `registry.clearAll()` replaces `engine.reset()` for tests.

### Events: run-scoped vs queue-scoped

The single global `eventBus` stays. `WorkflowEvent` is bifurcated:

| Variant | Scope | `runId` required? | Emitted via |
|---|---|---|---|
| `run_started` | run | yes | `controller.emit` |
| `node_started`, `node_finished` | run | yes | `controller.emit` |
| `stdout_chunk` | run | yes | `controller.emit` |
| `condition_checked` | run | yes | `controller.emit` |
| `template_warning` | run | yes | `controller.emit` |
| `error` (during a run) | run | yes | `controller.emit` |
| `run_finished` | run | yes | `controller.emit` |
| `node_waiting_for_lock` / `node_lock_acquired` | run | yes | `controller.emit` |
| `node_waiting_for_slot` / `node_slot_acquired` | run | yes | `controller.emit` |
| `trigger_enqueued` | queue | no (no run yet) | `eventBus.emit` direct |
| `trigger_dropped` (workflow-deleted, queue-full, engine-start-failed) | queue | no | `eventBus.emit` direct |
| `trigger_removed` | queue | no | `eventBus.emit` direct |
| `trigger_started` | queue | already carries `runId` | `eventBus.emit` direct |

`controller.emit` stamps `runId` before forwarding to `eventBus`. Executors receive `controller.emit` via `NodeExecutorContext` so they cannot accidentally emit unstamped events. The per-engine `recentEvents` buffer moves onto the controller; SSE replay for a newly-connected client filtering by `?runId=` hydrates from that controller's buffer.

### DirLockManager

New module: `lib/server/dir-lock-manager.ts`.

```
class DirLockManager {
  acquire(opts: {
    path: string,
    runId: string,
    nodeId: string,
    signal: AbortSignal,
  }): Promise<() => void>           // resolves to a release fn
  registerExempt(path: string, runId: string): () => void  // worktree register
}

class SlotPool {
  capacity: number
  setCapacity(n: number): void       // live reconfigure
  acquire(runId: string, nodeId: string, signal: AbortSignal): Promise<void>
  releaseRun(runId: string): void    // called on run settle
}
```

Both objects participate in a single wait-for graph (see Cycle detection below).

#### Lock manager behavior

| Aspect | Choice |
|---|---|
| Key | Canonicalized absolute path (see Path canonicalization). |
| Acquire site | **Agent executor only**, before spawning the CLI child (`lib/server/nodes/agent.ts` after cwd validation at line 88). HTTP-transport agents skip the lock entirely. Non-agent nodes do not lock. |
| Lifetime | Per-node-execution. Released in `finally`, after the CLI child exits. |
| Conflict | Exact path **or** ancestor **or** descendant of any currently-held path, **except** the holder is the same `runId` (re-entry; see below). |
| Re-entry, sequential | A run holding a path may re-acquire it after release; trivially no-op. |
| Re-entry, parallel same-run | When two sibling branches of one run both request the same path concurrently, both proceed without blocking. The lock manager tracks holders as `Map<canonicalPath, { holders: Set<runId>, refCountByRun: Map<runId, number> }>`. Sibling acquires inside one run bump the refcount; release decrements; the path is freed when the run's refcount hits zero. The `release` fn returned by `acquire` is **idempotent**: a `released` flag captured in its closure makes a second call a no-op, so defensive `try { release() } finally { release() }` patterns are safe. This matches the user's per-node-lifetime trade-off: within one run, parallel branches against the same `cwd` are the workflow author's choice (they wrote `useWorktree: false`); across runs, the path serializes correctly. |
| Wait queue | FIFO per conflicting subtree. |
| Cancellation | `signal.aborted` removes the waiter cleanly; on abort while waiting, the slot edge in the wait-for graph (if any) is also removed. |
| Cycle detection | See below. |
| Events | `node_waiting_for_lock { runId, nodeId, path, heldByRunId, heldByNodeId }`, `node_lock_acquired { runId, nodeId, path }`. |
| Worktree registration | `RunWorktreesImpl.create()` calls `registerExempt(path, runId)` so worktree paths short-circuit to no-op acquire for that run's lifetime. Replaces the `.infloop-worktrees/` prefix heuristic. |

#### Path canonicalization

1. `fs.realpath(path)` — resolves symlinks. On macOS this turns `/tmp` into `/private/tmp`; the test at `lib/server/worktree-manager.test.ts:38-39` already documents this divergence.
2. Strip trailing `/`.
3. ENOENT: if `realpath` throws ENOENT, the acquire **fails fast** with a clear error ("cannot lock non-existent path `<cwd>`"). The agent node routes via its `error` handle if one is connected; otherwise the run settles as `failed`. Workflows that need to create a directory at runtime must do so in an upstream node (e.g. a Script node) before the Agent node that locks it. Rationale: tracking lexical-vs-canonical alias pairs across runs is fragile (alias map outlives the originating run; cross-run conflicts on the lexical key require process-wide bookkeeping). Refusing keeps semantics predictable.
4. Exempt-prefix match is **segment-wise**, not substring: split both on `path.sep`, compare segment arrays with prefix semantics. `/x/.infloop-worktrees-fake/y` does **not** match `.infloop-worktrees` because the directory name differs at the segment boundary. The system temp dir (`os.tmpdir()`) and `/tmp` (post-realpath, on macOS this is `/private/tmp`) are exempt by default. `INFLOOP_LOCK_EXEMPT_PREFIXES` (colon-separated) adds more.
5. Worktree paths are registered explicitly via `registerExempt` rather than relying on a path-prefix heuristic — preferred over (4) when the worktree dir is known.

#### Cycle detection

Maintain a wait-for graph `Map<runId, Set<runId>>` where an edge `A → B` means "A is waiting for a resource held by B". The graph is updated on every enqueue (lock or slot) and every release. On a new enqueue, run a DFS from the waiter; if it can reach itself, reject with `LockCycleError`. The `SlotPool` and `DirLockManager` share **one** graph instance so a slot-saturated configuration cannot deadlock outside the cycle check.

```
LockCycleError extends Error {
  cycle: string[]  // [runId, runId, ...]
  resource: { kind: 'lock' | 'slot', path?: string }
}
```

A run that hits `LockCycleError` fails the node with the cycle path in the error message; the run settles as `failed`.

#### Per-node lifetime trade-off — restated

Cross-run interleaving: run A and run B both touch `/project` across multiple nodes; they will interleave node-by-node. Workflows needing cross-node atomicity over a shared directory must use `useWorktree`, which is automatically registered as exempt for the run.

Cross-run interleaving within one Parallel node of the SAME run: the refcount model lets sibling branches share the path without blocking — this matches the workflow author's stated intent (they used Parallel and same cwd deliberately). It does NOT protect against the agents stepping on each other's filesystem state inside the parallel block; that is the author's responsibility, same as today.

### SlotPool

Slot acquisition is **lazy**: tied to the first non-exempt lock acquire, owned per-run, released at run settle.

| Aspect | Choice |
|---|---|
| Admission | At `start()`, no slot is consumed; the run is registered and execution begins. |
| First slot acquire | On the run's first call to `DirLockManager.acquire(...)` against a non-exempt path. Before waiting on the lock itself, the manager calls `SlotPool.acquireForRun(runId)`. If the controller already holds a slot, this is a no-op. |
| Run-lifetime ownership | Once acquired, the slot is held on `RunController.slotHandle` until run settle. Released in the same `finally` block that calls `worktrees.cleanupAll()` and `releaseRun(runId)`, **before** `persistRun` so the persisted snapshot reflects "settled" with no slot. |
| Within-run concurrency | The slot is per-RunController, not per-node. Three sibling parallel branches all calling `DirLockManager.acquire` simultaneously coordinate through a single `Promise<void>` cached on the controller. The first caller initiates the slot wait; subsequent callers await the same promise. Resolved → all proceed. |
| Cancellation | A slot waiter cancelled via `signal.aborted` is removed from the slot wait queue; the run never consumed a slot. The wait-for graph edge is removed. |
| Live reconfigure | `setCapacity(n)`. If `n > current`, drain the slot wait queue up to the new cap. If `n < current`, in-flight slot holders are not preempted; new waiters block until natural release brings holders back under the new cap. |
| Cycle participation | **Slot waits do NOT add edges to the wait-for graph.** A slot waiter, by construction, has not yet acquired any non-exempt path lock — the slot acquire IS its first non-exempt acquire — so a slot waiter holds no path-lock resources and cannot be the target of any other run's lock wait. Therefore no real cycle can include a slot waiter. The wait-for graph tracks only path-lock waits; slot waits are pure FIFO. |
| Wait queue | FIFO. |
| Events | `node_waiting_for_slot { runId, nodeId }`, `node_slot_acquired { runId, nodeId }`. |

#### Mid-run waiting state

A run that has been admitted, executed some nodes, and is now parked on a slot or lock acquire is still `snapshot.status === 'running'`. To make the wait observable without rescanning the event log:

```
RunSnapshot {
  ...,
  waitingFor?: {
    kind: 'lock' | 'slot',
    nodeId: string,
    path?: string,                    // present when kind === 'lock'
    heldBy?: { runId: string, nodeId: string }
  }
}
```

`waitingFor` is set when the wait begins and cleared when the wait resolves (acquired or aborted). MCP `RunStatusResult` (`lib/server/mcp/utility-tools.ts:7-17`) gains a `waitingFor` field for parity. The UI's active-runs list reads `waitingFor` per row.

A server crash while a run is in `waitingFor` state leaves no persisted record (same as a crash on any in-flight run today — `persistRun` runs only on settle, see `workflow-engine.ts:265`). Acceptable; matches the existing HMR-orphan note at `workflow-engine.ts:134-138`.

### Engine integration (agent executor, not engine wrapper)

The lock acquire moves into the agent executor. The engine wrapper does **not** lock around every node.

In `lib/server/nodes/agent.ts`:

```
async function runAgent(node, ctx) {
  // existing: validate cwd (line 88), select transport
  if (transport === 'http' || !cwd) {
    return invokeHttp(...)            // no lock, no slot
  }

  // CLI transport
  if (worktreePath) {
    lockManager.registerExempt(worktreePath, ctx.runId)   // run-scoped, no-op acquire
  }

  const release = await lockManager.acquire({
    path: cwd,
    runId: ctx.runId,
    nodeId: node.id,
    signal: ctx.abort.signal,
  })
  try {
    return spawnChild(...)
  } finally {
    release()
  }
}
```

Non-agent nodes (Condition, Branch, Script, Loop, Parallel, Subworkflow, Judge) do not interact with the lock manager. Script nodes that shell out into `cwd` are an open question — currently they do not lock and that matches today's behavior; flagged in Risks below.

### TriggerQueue retains its role

`TriggerQueue` (`lib/server/trigger-queue.ts`) remains the dispatch buffer for external triggers (webhooks, schedules). Changes:

- `maxQueue: 100` stays — bounds webhook flood at system entry.
- The "busy → re-prepend" branch in `drain` is deleted; admission is lazy, so `Registry.start` no longer throws "busy".
- `engineStart` dependency becomes `Registry.start` directly.
- Queue events (`trigger_enqueued`, `trigger_dropped`, `trigger_removed`, `trigger_started`) keep their existing shape — no `runId` requirement.

A flood of N webhooks is bounded by `maxQueue=100` at entry. The 100 admitted runs each buffer their own event logs until settle. This is the v1 memory foot-gun; see Risks.

### Concurrency cap

| Knob | Source | Default |
|---|---|---|
| `INFLOOP_MAX_CONCURRENT_RUNS` | env at boot | `4` |
| `maxConcurrentRuns` in settings file | runtime override (UI Settings) | absent → use env |
| `TriggerQueue.maxQueue` | hard-coded | `100` |

The cap applies **only** to runs that have acquired a slot (folder-touching, CLI agents with non-exempt `cwd`). Folder-free runs and parallel-branch siblings of an already-admitted run are unaffected.

### API surface

| Endpoint | Change |
|---|---|
| `POST /api/run` | Returns `runId`. No "busy" error path. |
| `POST /api/run/stop?runId=<id>` | Cancels one controller. |
| `POST /api/run/stop?all=1` | Aborts every live `RunController` (`registry.list().forEach(c => c.stop())`). **Does NOT clear the trigger queue.** The queue keeps draining; new runs may start as the abort propagates. To clear pending triggers, use the existing trigger-management endpoint. Rationale: stop-all is "stop what is running", not "stop the whole system". |
| `GET /api/events` | Optional `?runId=` filter. No filter → multi-run firehose; `state_snapshot` becomes `{ runs: RunSnapshot[] }`. Filtered → single-run snapshot. Client (`lib/client/ws-client.ts:28-34`) gets a minor wire-format update. |
| `GET /api/runs/[workflowId]/[runId]` | Reads `registry.getRun(runId)`. |
| `GET /api/settings`, `PUT /api/settings` | New. Body `{ settings: { maxConcurrentRuns: number } }` — envelope shape so future knobs do not force a v2 route. The PUT route serializes via an async mutex so two simultaneous PUTs cannot diverge in-memory state from on-disk state. Write order inside the mutex: tmp+rename (atomic, matches `run-store` pattern) → `slotPool.setCapacity(n)`. Reads do not need the mutex. |
| MCP `getRunStatus` (`lib/server/mcp/utility-tools.ts:53`) | Takes optional `runId`; without it, returns the most-recently-started run (back-compat). Adds `waitingFor` field to `RunStatusResult`. |
| MCP `cancelRun` (`lib/server/mcp/utility-tools.ts:111`) | Takes `runId`. |

### UI

- **Active-runs panel** in the top bar or sidebar. One row per `RunController` in the registry: `{ runId, workflowName, status, waitingFor?, startedAt }`. The selected row drives the canvas and the right-panel SSE stream (`?runId=` filter).
- Header: `slot holders N / cap M • slot-waiters K • folder-free runs L • queued triggers T`.
- Nodes in `waitingFor.kind === 'lock'` get a distinct visual treatment with a tooltip naming the holder: "waiting on `/project` (run `abc-123`, node `agent-2`)".
- Nodes in `waitingFor.kind === 'slot'` get a different visual treatment with tooltip: "waiting for a concurrency slot".
- **Settings panel** exposes `maxConcurrentRuns`.

## DirLockManager and SlotPool test list (stage 3)

`lib/server/dir-lock-manager.test.ts`:

1. Exact-path conflict serializes.
2. Ancestor holder blocks descendant acquire.
3. Descendant holder blocks ancestor acquire.
4. FIFO across multiple waiters on one subtree.
5. Abort-on-signal removes waiter cleanly; subsequent acquires succeed.
6. Cycle rejection: A holds `/a` waits `/b`, B holds `/b` waits `/a` → latecomer rejected with `LockCycleError`.
7. Sequential re-entry: same run, same path, after release.
8. Parallel re-entry: same run, two simultaneous acquires of same path → both proceed; first release decrements, second release frees.
9. Exempt path returns no-op release immediately.
10. `registerExempt` makes a path no-op for the run's lifetime; cleared on run settle.
11. macOS `/tmp` → `/private/tmp` canonicalization: acquire `/tmp` and acquire `/private/tmp` recognize as same key.
12. ENOENT cwd: acquire fails fast with "cannot lock non-existent path"; subsequent acquire of the same path after the directory is created (out-of-band) succeeds.
13. Segment-wise prefix match: `/x/.infloop-worktrees-fake/y` is NOT exempt; `/x/.infloop-worktrees/runId/y` IS.

`lib/server/slot-pool.test.ts`:

1. Cap=1, two folder-touching runs: second waits with `node_waiting_for_slot`; first settles → second emits `node_slot_acquired`.
2. Cap=N, N+1 folder-touching runs: only the (N+1)th waits.
3. Folder-free runs unaffected by cap.
4. Slot released exactly once at run settle, even if multiple nodes called acquire.
5. Slot waiter cancellable via abort signal; no slot consumed.
6. `setCapacity` raise drains waiters immediately.
7. `setCapacity` lower does not preempt; new waiters honor the new cap.
8. Cross-pool cycle: run A holds slot waits `/b`, run B holds `/b` waits slot → cycle detected.
9. Parallel branches of one run sharing the slot: three sibling acquires coordinate to one wait.

## Risks

- **Memory.** Each in-flight run buffers events for SSE replay (`recentEvents`, ≤5k) and persistence (`runEventLog`, ≤50k). Those caps are *per run*; they do not bound the **aggregate** across concurrent runs, so a webhook flood (`TriggerQueue` admits up to 100) could once grow memory without bound and OOM-kill the process. **Closed** by `EventMemoryBudget` (`lib/server/event-memory-budget.ts`): a process-wide event ceiling (`INFLOOP_MAX_TOTAL_EVENT_BUFFER`, default 200k events) is divided fairly among the live runs, so each run's buffer is squeezed under load and the aggregate plateaus at the ceiling instead of scaling with the run count. Surfaced as `infloop_event_buffer_events` / `infloop_event_buffer_limit` on `/api/metrics`; covered by the deterministic concurrency test in `run-controller-buffer.test.ts`.
- **Test migration.** ~1000 lines across `workflow-engine.test.ts`, `trigger-queue.test.ts`, `trigger-queue-singleton.test.ts`, and `dispatch-integration.test.ts` need rewrites. The 1a/1b stage split bounds the rewrite to stage 1b.
- **Mid-workflow interleaving across runs.** Documented. Mitigation is `useWorktree`.
- **Script-node cwd not locked.** A Script node that shells into a directory bypasses the lock manager. Same behavior as today; flagged for follow-up. If the user reports a Script-vs-Agent contention bug we know where to add the call.
- **Conservative slot cycle detection.** Slot waits encode edges to all current slot holders, which can fail a legal configuration. False positives surface as `LockCycleError` rather than hangs; acceptable for v1, monitor.
- **HMR.** Global pin key rename + `ENGINE_VERSION` bump must be in the same diff or HMR will replay an old shape.
- **Provider rate limits.** Not engine-enforced. The cap and OS provide a practical CPU/process ceiling for CLI providers; HTTP providers are uncapped.

## Migration

Seven stages. Stage 1 is split per review feedback so behavior change and refactor are separately reviewable.

1. **1a — Extract `RunController`, registry of size 1.** Pure refactor. The "rejects start when a run is already active" guard moves from the engine to the registry; `walk*` methods move to the controller; events stamped via `controller.emit`. **Behavior unchanged.** All existing tests pass with cosmetic edits. Bump `ENGINE_VERSION` and rename the global pin key.
2. **1b — Flip registry to N-run + introduce `SlotPool`.** Remove the size-1 guard. `RunController` gains `slotHandle`. Add `waitingFor` to `RunSnapshot`. Rewrite `workflow-engine.test.ts`, `trigger-queue.test.ts`, `dispatch-integration.test.ts`.
3. **Event tagging.** Add required `runId` to run-scoped variants in `lib/shared/workflow.ts`; thread `controller.emit` through `NodeExecutorContext`; keep queue-scoped variants unchanged. Move `recentEvents` and `runEventLog` onto the controller.
4. **`DirLockManager` module + tests.** Build the lock manager, slot pool, canonicalization, cycle detection, all events. No engine wiring yet. Full test suite (above).
5. **Wire lock into agent executor.** Acquire inside `lib/server/nodes/agent.ts` (CLI branch only); call `registerExempt` for worktrees. Integration test: disjoint cwds parallel, same cwd serial, cycle fails.
6. **APIs, MCP, settings persistence, TriggerQueue cleanup.** `/api/events?runId=`, `/api/run/stop?runId=` / `?all=1`, `/api/runs/[workflowId]/[runId]`, `/api/settings` GET/PUT with envelope and PUT mutex, MCP `getRunStatus`/`cancelRun` accept `runId`. Delete `engineStartAdapter`. Update `TriggerQueue` to call `Registry.start` directly. The multi-run `state_snapshot` wire-format change (`{ runs: RunSnapshot[] }` when unfiltered) and the corresponding `lib/client/ws-client.ts` parser update must land in the same commit as the server-side route change to avoid a mid-PR break.
7. **UI.** Active-runs panel, lock-waiting + slot-waiting visual states, settings panel, multi-run `state_snapshot` shape.

Then: senior code-review loop until approved, local validation against the acceptance criteria, PR.
