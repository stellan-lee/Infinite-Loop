/**
 * POST /api/mcp/output — SetOutput MCP server (JSON-RPC, Streamable HTTP).
 *
 * Scoped to a single agent-node invocation: the engine mints a per-run,
 * per-node token, injects this endpoint into the agent CLI via
 * `--mcp-config`, and reads the accumulated outputs back when the CLI exits.
 *
 * Auth: `Authorization: Bearer <run-token>` validated against the in-memory
 * registry in `lib/server/mcp/output-registry.ts`. This is a DELIBERATELY
 * SEPARATE surface from `requireAuth` (which guards every other /api/*
 * route with the global `INFLOOP_API_TOKEN`). Mixing the two would force
 * every route to branch on token type. See the registry module's header
 * for the lifecycle and crash-safety notes.
 *
 * v1 limitations (called out so callers don't confuse implementation gaps
 * with API contracts):
 *   - `value` must be a string; widening later is back-compat.
 *   - Outputs are visible to downstream nodes only AFTER the agent process
 *     exits (engine merges `consumeOutputs` into the node's output map then,
 *     not on each `set_output` call). Reads from a parallel branch mid-run
 *     will not see partial state.
 *   - One MCP server per agent invocation; merging with user-configured MCP
 *     servers is a follow-up.
 */

import { NextResponse } from 'next/server';
import {
  requireRunToken,
  setOutput,
  type RegistryEntry,
} from '@/lib/server/mcp/output-registry';

const MCP_PROTOCOL_VERSION = '2024-11-05';

/* ─── JSON-RPC helpers ───────────────────────────────────────────────────── */

function jsonRpcSuccess(id: unknown, result: unknown) {
  return NextResponse.json({ jsonrpc: '2.0', id, result }, { status: 200 });
}

function jsonRpcError(id: unknown, code: number, message: string) {
  return NextResponse.json(
    { jsonrpc: '2.0', id, error: { code, message } },
    { status: 200 },
  );
}

/* ─── tool spec (per-token) ──────────────────────────────────────────────── */

function setOutputToolSpec(entry: RegistryEntry) {
  const keys = entry.outputDecls.map((d) => d.name);
  // Per-key descriptions are flattened into the tool description so the agent
  // sees what each key is for without requiring per-arg JSON-Schema enums to
  // carry descriptions (which most MCP clients ignore).
  const lines = entry.outputDecls
    .filter((d) => typeof d.description === 'string' && d.description.length > 0)
    .map((d) => `  - ${d.name}: ${d.description}`);
  const description =
    'Record a named output for this Infinite Loop agent node. ' +
    'The value is captured when this agent exits and surfaces in the node\'s ' +
    'outputs map for downstream nodes to consume.' +
    (lines.length > 0 ? '\n\nDeclared outputs:\n' + lines.join('\n') : '');
  return {
    name: 'set_output',
    description,
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          enum: keys,
          description: 'Declared output name to record.',
        },
        value: {
          type: 'string',
          description: 'String value to record. Max 64KB by default.',
        },
      },
      required: ['key', 'value'],
      additionalProperties: false,
    },
  };
}

/* ─── POST handler ───────────────────────────────────────────────────────── */

export async function POST(req: Request) {
  const auth = requireRunToken(req);
  if (auth instanceof NextResponse) return auth;
  const { entry } = auth;

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

  if (isNotification) {
    return new Response(null, { status: 204 });
  }

  if (method === 'initialize') {
    return jsonRpcSuccess(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      serverInfo: { name: 'infinite_loop_output', version: '0.1.0' },
      capabilities: { tools: {} },
    });
  }

  if (method === 'tools/list') {
    return jsonRpcSuccess(id, { tools: [setOutputToolSpec(entry)] });
  }

  if (method === 'tools/call') {
    const toolParams = params as { name?: string; arguments?: Record<string, unknown> };
    if (toolParams.name !== 'set_output') {
      return jsonRpcSuccess(id, {
        content: [{ type: 'text', text: `Unknown tool "${toolParams.name}".` }],
        isError: true,
      });
    }
    const args = toolParams.arguments ?? {};
    const key = typeof args.key === 'string' ? args.key : '';
    const value = args.value;

    const result = setOutput(auth.token, key, value);
    if (!result.ok) {
      return jsonRpcSuccess(id, {
        content: [{ type: 'text', text: result.message }],
        isError: true,
      });
    }
    return jsonRpcSuccess(id, {
      content: [{ type: 'text', text: `ok: recorded ${key}` }],
    });
  }

  return jsonRpcError(id, -32601, `Method not found: ${method}`);
}
