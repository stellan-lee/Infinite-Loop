import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dataDir, triggersDir } from './paths';
import type {
  AgentConfig,
  JudgeNodeConfig,
  ParallelConfig,
  SubworkflowConfig,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowSummary,
} from '../shared/workflow';
import { AGENT_RESERVED_OUTPUT_NAMES } from '../shared/workflow';
import type { WebhookTrigger } from '../shared/trigger';
import {
  collectWorkflowNodeIds,
  walkWorkflowNodes,
} from '../shared/workflow-graph';

/**
 * v5→v6 migration: rewrite `type: "claude"` nodes to `type: "agent"` with
 * `providerId: "claude"`. Pure function; called on every load so old files on
 * disk keep working. Disk is only rewritten on the next `saveWorkflow`.
 */
function migrateNode(n: unknown): WorkflowNode {
  if (!n || typeof n !== 'object') return n as WorkflowNode;
  const node = { ...(n as Record<string, unknown>) };
  if (node.type === 'claude') {
    const oldCfg = (node.config as Record<string, unknown> | undefined) ?? {};
    node.type = 'agent';
    node.config = { providerId: 'claude', ...oldCfg };
  }
  if (Array.isArray(node.children)) {
    node.children = node.children.map(migrateNode);
  }
  return node as unknown as WorkflowNode;
}

function migrateWorkflow(wf: Workflow): Workflow {
  if (!Array.isArray(wf.nodes)) return wf;
  return { ...wf, nodes: wf.nodes.map(migrateNode) };
}

function storageDir(): string {
  return (
    process.env.INFLOOP_WORKFLOWS_DIR ||
    path.join(dataDir(), 'workflows')
  );
}

/**
 * Read-only library directory shipped with the repo. Defaults to the
 * project root so library presets remain available regardless of where
 * user workflows are stored.
 */
function libraryDir(): string {
  return (
    process.env.INFLOOP_LIBRARY_DIR ||
    path.join(process.cwd(), 'workflows', 'library')
  );
}

function fileFor(id: string): string {
  return path.join(storageDir(), `${id}.json`);
}

function libraryFileFor(id: string): string {
  return path.join(libraryDir(), `${id}.json`);
}

function validateNodeConfig(n: WorkflowNode): void {
  if (n.type === 'parallel') {
    const cfg = n.config as ParallelConfig;
    if (cfg.mode === 'quorum') {
      const childCount = n.children?.length ?? 0;
      const q = cfg.quorumN ?? 0;
      if (q < 1 || q > childCount) {
        throw new Error(
          `invalid workflow: parallel node "${n.id}" mode=quorum requires 1 ≤ quorumN ≤ children.length (got ${q}, ${childCount} children)`,
        );
      }
    }
    if (cfg.onError !== 'fail-fast' && cfg.onError !== 'best-effort') {
      throw new Error(
        `invalid workflow: parallel node "${n.id}" onError must be 'fail-fast' or 'best-effort'`,
      );
    }
  }
  if (n.type === 'subworkflow') {
    const cfg = n.config as SubworkflowConfig;
    if (typeof cfg.workflowId !== 'string' || cfg.workflowId.length === 0) {
      throw new Error(
        `invalid workflow: subworkflow node "${n.id}" workflowId must be a non-empty string`,
      );
    }
  }
  if (n.type === 'judge') {
    const cfg = n.config as JudgeNodeConfig;
    if (!Array.isArray(cfg.candidates) || cfg.candidates.length < 2) {
      throw new Error(
        `invalid workflow: judge node "${n.id}" requires at least 2 candidates`,
      );
    }
  }
  if (n.type === 'agent') {
    const cfg = n.config as AgentConfig;
    if (cfg.outputs !== undefined) {
      if (!Array.isArray(cfg.outputs)) {
        throw new Error(
          `invalid workflow: agent node "${n.id}" outputs must be an array`,
        );
      }
      const seen = new Set<string>();
      const reserved = new Set(AGENT_RESERVED_OUTPUT_NAMES);
      for (const decl of cfg.outputs) {
        if (
          !decl ||
          typeof decl !== 'object' ||
          typeof decl.name !== 'string' ||
          decl.name.length === 0
        ) {
          throw new Error(
            `invalid workflow: agent node "${n.id}" outputs entries must be { name: string, description?: string }`,
          );
        }
        if (seen.has(decl.name)) {
          throw new Error(
            `invalid workflow: agent node "${n.id}" declares duplicate output "${decl.name}"`,
          );
        }
        if (reserved.has(decl.name)) {
          throw new Error(
            `invalid workflow: agent node "${n.id}" output "${decl.name}" collides with a reserved runtime field`,
          );
        }
        seen.add(decl.name);
      }
    }
  }
}

function collectSubworkflowIds(nodes: WorkflowNode[]): string[] {
  const ids: string[] = [];
  walkWorkflowNodes(nodes, (n) => {
    if (n.type === 'subworkflow') {
      const cfg = n.config as SubworkflowConfig;
      if (typeof cfg.workflowId === 'string' && cfg.workflowId.length > 0) {
        ids.push(cfg.workflowId);
      }
    }
  });
  return ids;
}

/**
 * DFS over the subworkflow reference graph rooted at `wf`. If any path
 * revisits `wf.id`, the save would create a cycle.
 *
 * Loading errors during the walk are tolerated as "not a cycle" — runtime,
 * not validation, is responsible for missing-target diagnostics.
 *
 * Exported (alongside saveWorkflow) so unit tests can exercise it directly
 * without round-tripping through the disk writer.
 */
export async function validateNoSubworkflowCycles(wf: Workflow): Promise<void> {
  // Visited set is keyed by workflow id — once we've cleared a referenced
  // workflow we don't need to walk its subtree again.
  const cleared = new Set<string>();

  const visit = async (currentId: string, ancestors: Set<string>): Promise<void> => {
    if (cleared.has(currentId)) return;
    if (ancestors.has(currentId)) {
      throw new Error(
        `invalid workflow: subworkflow cycle detected involving "${currentId}"`,
      );
    }

    let nodes: WorkflowNode[];
    if (currentId === wf.id) {
      nodes = wf.nodes; // use the in-memory pending workflow, not on-disk version
    } else {
      try {
        const loaded = await getWorkflow(currentId);
        nodes = loaded.nodes;
      } catch {
        // Missing or unreadable workflow: not a cycle. Mark as cleared so we
        // don't keep retrying along sibling branches of the DFS.
        cleared.add(currentId);
        return;
      }
    }

    const nextAncestors = new Set(ancestors);
    nextAncestors.add(currentId);
    const childIds = collectSubworkflowIds(nodes);
    for (const childId of childIds) {
      await visit(childId, nextAncestors);
    }
    cleared.add(currentId);
  };

  await visit(wf.id, new Set());
}

function validateWorkflow(wf: Workflow): void {
  if (typeof wf.id !== 'string' || wf.id.length === 0) {
    throw new Error('invalid workflow: id must be a non-empty string');
  }
  if (typeof wf.name !== 'string' || wf.name.length === 0) {
    throw new Error('invalid workflow: name must be a non-empty string');
  }
  if (!Array.isArray(wf.nodes)) {
    throw new Error('invalid workflow: nodes must be an array');
  }
  if (!Array.isArray(wf.edges)) {
    throw new Error('invalid workflow: edges must be an array');
  }

  const hasStart = wf.nodes.some((n) => n.type === 'start');
  if (!hasStart) {
    throw new Error(
      'invalid workflow: must contain at least one top-level node of type "start"',
    );
  }

  const nodeIds = collectWorkflowNodeIds(wf.nodes);
  for (const edge of wf.edges as WorkflowEdge[]) {
    if (!nodeIds.has(edge.source)) {
      throw new Error(
        `invalid workflow: edge ${edge.id} source "${edge.source}" does not reference any known node id`,
      );
    }
    if (!nodeIds.has(edge.target)) {
      throw new Error(
        `invalid workflow: edge ${edge.id} target "${edge.target}" does not reference any known node id`,
      );
    }
  }

  // Per-node config validation for new multi-agent node types. Subworkflow
  // cycle detection is intentionally deferred to unit U1 (engine walkers)
  // since it requires reading other workflows from disk.
  walkWorkflowNodes(wf.nodes, validateNodeConfig);
}

async function readWorkflowFile(id: string): Promise<Workflow> {
  const userFile = fileFor(id);
  const libraryFile = libraryFileFor(id);
  let raw: string;
  try {
    raw = await fs.readFile(userFile, 'utf8');
  } catch (userErr) {
    if ((userErr as NodeJS.ErrnoException).code !== 'ENOENT') throw userErr;
    // Fall through to the library directory.
    try {
      raw = await fs.readFile(libraryFile, 'utf8');
    } catch (libErr) {
      if ((libErr as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`workflow not found: ${id}`);
      }
      throw libErr;
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `workflow file for "${id}" is not valid JSON: ${(err as Error).message}`,
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`workflow file for "${id}" is not a JSON object`);
  }
  const wf = parsed as Workflow;
  if (wf.id !== id) {
    throw new Error(
      `workflow file for "${id}" has mismatched id (got "${wf.id}")`,
    );
  }
  return migrateWorkflow(wf);
}

async function readSummariesFromDir(
  dir: string,
  source: 'user' | 'library',
): Promise<WorkflowSummary[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    // Library dir may not exist; user dir is created upstream. Either way an
    // ENOENT here just means "no summaries from this source".
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const jsonFiles = entries.filter(
    (e) => e.endsWith('.json') && !e.endsWith('.json.tmp'),
  );
  const summaries = await Promise.all(
    jsonFiles.map(async (entry): Promise<WorkflowSummary | null> => {
      try {
        const raw = await fs.readFile(path.join(dir, entry), 'utf8');
        const parsed = JSON.parse(raw) as Workflow;
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          typeof parsed.id !== 'string' ||
          typeof parsed.name !== 'string' ||
          typeof parsed.version !== 'number' ||
          typeof parsed.updatedAt !== 'number'
        ) {
          return null;
        }
        return {
          id: parsed.id,
          name: parsed.name,
          version: parsed.version,
          updatedAt: parsed.updatedAt,
          source,
        };
      } catch {
        return null;
      }
    }),
  );
  return summaries.filter((s): s is WorkflowSummary => s !== null);
}

export async function listWorkflows(): Promise<WorkflowSummary[]> {
  const dir = storageDir();
  await fs.mkdir(dir, { recursive: true });

  const [userSummaries, librarySummaries] = await Promise.all([
    readSummariesFromDir(dir, 'user'),
    readSummariesFromDir(libraryDir(), 'library'),
  ]);

  // User dir wins on id collision (lets users duplicate-and-edit a library
  // preset without the read-only original shadowing the edited copy).
  const userIds = new Set(userSummaries.map((s) => s.id));
  const merged = [
    ...userSummaries,
    ...librarySummaries.filter((s) => !userIds.has(s.id)),
  ];
  return merged.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Dispatch v2 migration: if a workflow JSON still has an inline `triggers[]`
 * array (the pre-v2 format), copy each entry into the trigger-store as a
 * `generic` plugin entry and strip the field from the in-memory object.
 *
 * Idempotent: if the trigger file already exists on disk it is left untouched.
 * Writes directly to disk rather than going through `saveTrigger` to avoid a
 * circular call chain (trigger-store validates by calling `getWorkflow`).
 */
async function migrateLegacyTriggers(wf: Workflow & { triggers?: unknown }): Promise<void> {
  const legacy = (wf as { triggers?: unknown }).triggers;
  if (!Array.isArray(legacy) || legacy.length === 0) {
    delete (wf as { triggers?: unknown }).triggers;
    return;
  }

  const dir = triggersDir();
  await fs.mkdir(dir, { recursive: true });

  for (const raw of legacy) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as Record<string, unknown>;
    const id = typeof t.id === 'string' ? t.id : undefined;
    if (!id) continue;

    const target = path.join(dir, `${id}.json`);
    // Skip if already migrated.
    try {
      await fs.access(target);
      continue;
    } catch {
      // File does not exist — proceed with writing.
    }

    const now = Date.now();
    const trigger: WebhookTrigger = {
      id,
      name: typeof t.name === 'string' ? t.name : id,
      enabled: typeof t.enabled === 'boolean' ? t.enabled : true,
      workflowId: wf.id,
      pluginId: 'generic',
      match: Array.isArray(t.match) ? (t.match as WebhookTrigger['match']) : [],
      inputs:
        t.inputs && typeof t.inputs === 'object' && !Array.isArray(t.inputs)
          ? (t.inputs as Record<string, string>)
          : {},
      createdAt: now,
      updatedAt: now,
      lastFiredAt: null,
    };

    try {
      const tmp = `${target}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(trigger, null, 2), 'utf8');
      await fs.rename(tmp, target);
    } catch (err) {
      console.error(`[workflow-store] migration: failed to save trigger ${id}:`, err);
    }
  }

  delete (wf as { triggers?: unknown }).triggers;
}

export async function getWorkflow(id: string): Promise<Workflow> {
  const wf = await readWorkflowFile(id);
  await migrateLegacyTriggers(wf);
  return wf;
}

export async function saveWorkflow(workflow: Workflow): Promise<Workflow> {
  validateWorkflow(workflow);
  await validateNoSubworkflowCycles(workflow);

  const dir = storageDir();
  await fs.mkdir(dir, { recursive: true });

  let existing: Workflow | null = null;
  try {
    existing = await readWorkflowFile(workflow.id);
  } catch (err) {
    if (!/^workflow not found:/.test((err as Error).message)) {
      throw err;
    }
  }

  const now = Date.now();
  const saved: Workflow = {
    ...workflow,
    version: (existing?.version ?? 0) + 1,
    createdAt: existing?.createdAt ?? workflow.createdAt ?? now,
    updatedAt: now,
  };
  // Dispatch v2: triggers no longer live in workflow JSON.
  delete (saved as { triggers?: unknown }).triggers;

  const target = fileFor(saved.id);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(saved, null, 2), 'utf8');
  await fs.rename(tmp, target);

  return saved;
}

export async function deleteWorkflow(id: string): Promise<void> {
  const file = fileFor(id);
  try {
    await fs.unlink(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`workflow not found: ${id}`);
    }
    throw err;
  }
}
