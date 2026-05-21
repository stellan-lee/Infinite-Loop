/**
 * POST /api/mcp — Streamable HTTP MCP endpoint (stateless, JSON-RPC over HTTP).
 *
 * Implements the minimal MCP surface needed for tool discovery and invocation:
 *   - initialize         → version handshake
 *   - notifications/initialized → no-op (client ack)
 *   - tools/list         → per-request workflow discovery + utility tools
 *   - tools/call         → dispatch to in-process tool handlers
 *
 * Each request is authenticated via requireAuth (same as all other /api/* routes).
 * Workflow discovery is per-request so the list is always live.
 *
 * Workflow tools always enqueue (non-blocking). Callers poll with
 * infinite_loop_get_run_status using the returned queueId.
 *
 * Backward compatibility: the historical tool prefix was `inflooop_*` (triple
 * `o`) and the server identifier was `inflooop`. Existing client configs that
 * still call those tool names continue to work — `tools/call` accepts both
 * prefixes and dispatches identically. The `tools/list` response now returns
 * only the canonical `infinite_loop_*` names.
 */

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/server/auth';
import { listWorkflows, getWorkflow } from '@/lib/server/workflow-store';
import { enqueueWorkflowTool } from '@/lib/server/mcp/enqueue-tool';
import {
  getRunStatus,
  listRuns,
  cancelRun,
  listQueue,
  removeFromQueue,
} from '@/lib/server/mcp/utility-tools';
import {
  sanitizeToolName,
  deconflictNames,
  workflowToTool,
  type McpToolSpec,
} from '@/lib/server/mcp/workflow-to-tool';
import { createLogger } from '@/lib/server/logger';
import type { Workflow } from '@/lib/shared/workflow';

const log = createLogger('mcp');

const MCP_PROTOCOL_VERSION = '2024-11-05';

// ─── Utility-tool specs (fixed) ──────────────────────────────────────────────

const UTILITY_TOOLS: McpToolSpec[] = [
  {
    name: 'infinite_loop_get_run_status',
    description:
      'Fetch the status and outputs of an Infinite Loop run, identified by ' +
      'either {workflowId, runId} or {queueId}. Use queueId to track a call ' +
      'returned by a workflow tool (state goes queued → started; once started ' +
      'the response includes runId and run outputs).',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'The workflow id (required with runId).' },
        runId: { type: 'string', description: 'The run id (preferred when known).' },
        queueId: {
          type: 'string',
          description: 'The queue id returned by a workflow tool call.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'infinite_loop_list_runs',
    description: 'List recent Infinite Loop runs, optionally filtered by workflowId.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Optional workflow id filter.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'infinite_loop_cancel_run',
    description:
      'Cancel an in-flight Infinite Loop run, if runId matches the current run.',
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string' },
        runId: { type: 'string' },
      },
      required: ['workflowId', 'runId'],
      additionalProperties: false,
    },
  },
  {
    name: 'infinite_loop_list_queue',
    description:
      'List the current trigger queue (pending workflow runs, in order). ' +
      'Items already started or finished do not appear here — use ' +
      'infinite_loop_get_run_status with a queueId to track those.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'infinite_loop_remove_from_queue',
    description:
      'Remove a queued workflow run by queueId before it starts. Returns ' +
      '{removed:false} if the item has already started or never existed.',
    inputSchema: {
      type: 'object',
      properties: {
        queueId: { type: 'string', description: 'The queue id to remove.' },
      },
      required: ['queueId'],
      additionalProperties: false,
    },
  },
];

/**
 * Map legacy `inflooop_*` tool names to their canonical `infinite_loop_*`
 * equivalents. Used by `tools/call` so existing client configs continue to
 * work after the rename. Legacy names are NOT advertised in `tools/list`.
 */
function normalizeUtilityToolName(name: string): string {
  if (name.startsWith('inflooop_')) {
    return 'infinite_loop_' + name.slice('inflooop_'.length);
  }
  return name;
}

// ─── Workflow discovery ───────────────────────────────────────────────────────

interface RegisteredWorkflowTool {
  spec: McpToolSpec;
  workflowId: string;
}

async function discoverWorkflowTools(): Promise<RegisteredWorkflowTool[]> {
  let summaries: Awaited<ReturnType<typeof listWorkflows>>;
  try {
    summaries = await listWorkflows();
  } catch (err) {
    log.error('workflow discovery failed', { err });
    return [];
  }

  const fulls: Workflow[] = [];
  for (const s of summaries) {
    try {
      const wf = await getWorkflow(s.id);
      fulls.push(wf);
    } catch {
      // Skip unreadable workflows.
    }
  }

  const rawNames = fulls.map((w) => sanitizeToolName(w.id));
  const finalNames = deconflictNames(rawNames);

  return fulls.map((wf, i) => ({
    workflowId: wf.id,
    spec: workflowToTool(wf, finalNames[i]!),
  }));
}

// ─── JSON-RPC helpers ─────────────────────────────────────────────────────────

function jsonRpcSuccess(id: unknown, result: unknown) {
  return NextResponse.json({ jsonrpc: '2.0', id, result }, { status: 200 });
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return NextResponse.json(
    { jsonrpc: '2.0', id, error: { code, message } },
    { status: 200 },
  );
}

// ─── POST handler ─────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
      { status: 200 },
    );
  }

  const rpc = body as { jsonrpc?: string; id?: unknown; method?: string; params?: unknown };
  const isNotification = !('id' in rpc);
  const id = rpc.id ?? null;
  const method = rpc.method;
  const params = (rpc.params ?? {}) as Record<string, unknown>;

  if (rpc.jsonrpc !== '2.0' || typeof method !== 'string') {
    return jsonRpcError(id, -32600, 'Invalid Request');
  }

  // ── JSON-RPC notifications: MUST NOT respond (spec §4) ─────────────────────
  if (isNotification) {
    return new Response(null, { status: 204 });
  }

  // ── initialize ──────────────────────────────────────────────────────────────
  if (method === 'initialize') {
    return jsonRpcSuccess(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: { name: 'infinite_loop', version: '0.1.0' },
      capabilities: { tools: {} },
    });
  }

  // ── tools/list ──────────────────────────────────────────────────────────────
  if (method === 'tools/list') {
    const workflowTools = await discoverWorkflowTools();
    const tools = [
      ...workflowTools.map((t) => t.spec),
      ...UTILITY_TOOLS,
    ];
    return jsonRpcSuccess(id, { tools });
  }

  // ── tools/call ──────────────────────────────────────────────────────────────
  if (method === 'tools/call') {
    const toolParams = params as { name?: string; arguments?: Record<string, unknown> };
    const rawName = toolParams.name;
    const args = toolParams.arguments ?? {};

    if (typeof rawName !== 'string') {
      return jsonRpcError(id, -32602, 'tools/call requires params.name');
    }

    // Normalize legacy `inflooop_*` aliases to canonical `infinite_loop_*`
    // names for utility-tool dispatch. Per-workflow tool names are not
    // affected by this rewrite — they're matched as-is below.
    const name = normalizeUtilityToolName(rawName);

    // Utility tools.
    if (name === 'infinite_loop_get_run_status') {
      const out = await getRunStatus(
        args as { workflowId?: string; runId?: string; queueId?: string },
      );
      return jsonRpcSuccess(id, {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        isError: out.status === 'error',
      });
    }
    if (name === 'infinite_loop_list_runs') {
      const out = await listRuns(args as { workflowId?: string });
      return jsonRpcSuccess(id, {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
      });
    }
    if (name === 'infinite_loop_cancel_run') {
      const out = await cancelRun(args as { workflowId: string; runId: string });
      return jsonRpcSuccess(id, {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
      });
    }
    if (name === 'infinite_loop_list_queue') {
      const out = listQueue();
      return jsonRpcSuccess(id, {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
      });
    }
    if (name === 'infinite_loop_remove_from_queue') {
      const out = removeFromQueue(args as { queueId: string });
      return jsonRpcSuccess(id, {
        content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
        isError: !out.removed,
      });
    }

    // Per-workflow tools: discover on every call so the tool list is always live.
    const workflowTools = await discoverWorkflowTools();
    const workflowToolByName = new Map(workflowTools.map((t) => [t.spec.name, t]));
    const wt = workflowToolByName.get(name);
    if (!wt) {
      return jsonRpcSuccess(id, {
        content: [{ type: 'text', text: `Unknown tool "${name}".` }],
        isError: true,
      });
    }

    const out = await enqueueWorkflowTool({
      workflowId: wt.workflowId,
      inputs: args,
    });

    return jsonRpcSuccess(id, {
      content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
      isError: out.status === 'error',
    });
  }

  // ── unknown method ───────────────────────────────────────────────────────────
  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}
