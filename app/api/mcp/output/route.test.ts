import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { POST } from './route';
import {
  __resetRegistryForTests,
  consumeOutputs,
  mintToken,
  resolveToken,
} from '@/lib/server/mcp/output-registry';

function rpc(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request('http://localhost/api/mcp/output', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  __resetRegistryForTests();
});

afterEach(() => {
  __resetRegistryForTests();
});

describe('POST /api/mcp/output — auth', () => {
  it('returns 401 without Authorization header', async () => {
    const res = await POST(rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
    expect(res.status).toBe(401);
  });

  it('returns 401 with an unknown bearer token', async () => {
    const res = await POST(
      rpc(
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        { Authorization: 'Bearer deadbeef' },
      ),
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 for a non-bearer scheme', async () => {
    const token = mintToken({
      runId: 'r', nodeId: 'n',
      outputDecls: [{ name: 'K' }],
    });
    const res = await POST(
      rpc(
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        { Authorization: `Basic ${token}` },
      ),
    );
    expect(res.status).toBe(401);
  });

  it('accepts a valid bearer token', async () => {
    const token = mintToken({
      runId: 'r', nodeId: 'n',
      outputDecls: [{ name: 'K' }],
    });
    const res = await POST(
      rpc(
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        { Authorization: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(200);
  });
});

describe('POST /api/mcp/output — initialize', () => {
  it('returns protocolVersion + serverInfo', async () => {
    const token = mintToken({
      runId: 'r', nodeId: 'n',
      outputDecls: [{ name: 'K' }],
    });
    const res = await POST(
      rpc(
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        { Authorization: `Bearer ${token}` },
      ),
    );
    const body = (await res.json()) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(body.result.protocolVersion).toBeTruthy();
    expect(body.result.serverInfo.name).toBe('infinite_loop_output');
  });
});

describe('POST /api/mcp/output — tools/list', () => {
  it('returns set_output with the declared keys in its enum', async () => {
    const token = mintToken({
      runId: 'r', nodeId: 'n',
      outputDecls: [
        { name: 'PR_LINK', description: 'PR URL' },
        { name: 'PR_ID' },
      ],
    });
    const res = await POST(
      rpc(
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { Authorization: `Bearer ${token}` },
      ),
    );
    const body = (await res.json()) as {
      result: {
        tools: Array<{
          name: string;
          description: string;
          inputSchema: {
            properties: { key: { enum: string[] } };
          };
        }>;
      };
    };
    expect(body.result.tools).toHaveLength(1);
    const tool = body.result.tools[0]!;
    expect(tool.name).toBe('set_output');
    expect(tool.inputSchema.properties.key.enum.sort()).toEqual(['PR_ID', 'PR_LINK']);
    expect(tool.description).toContain('PR_LINK: PR URL');
  });

  it('omits the per-key description block when no descriptions are declared', async () => {
    const token = mintToken({
      runId: 'r', nodeId: 'n',
      outputDecls: [{ name: 'K' }],
    });
    const res = await POST(
      rpc(
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { Authorization: `Bearer ${token}` },
      ),
    );
    const body = (await res.json()) as {
      result: { tools: Array<{ description: string }> };
    };
    expect(body.result.tools[0]!.description).not.toContain('Declared outputs');
  });
});

describe('POST /api/mcp/output — tools/call set_output', () => {
  it('records a declared value and stores it on the entry', async () => {
    const token = mintToken({
      runId: 'r', nodeId: 'n',
      outputDecls: [{ name: 'PR_LINK' }],
    });
    const res = await POST(
      rpc(
        {
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'set_output', arguments: { key: 'PR_LINK', value: 'https://x' } },
        },
        { Authorization: `Bearer ${token}` },
      ),
    );
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    expect(body.result.isError).toBeUndefined();
    expect(resolveToken(token)!.outputs).toEqual({ PR_LINK: 'https://x' });
  });

  it('returns isError + reason for an unknown key', async () => {
    const token = mintToken({
      runId: 'r', nodeId: 'n',
      outputDecls: [{ name: 'PR_LINK' }],
    });
    const res = await POST(
      rpc(
        {
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'set_output', arguments: { key: 'OTHER', value: 'x' } },
        },
        { Authorization: `Bearer ${token}` },
      ),
    );
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }>; isError: boolean };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain('not declared');
  });

  it('401s a late call after the token has been consumed (no silent buffering)', async () => {
    const token = mintToken({
      runId: 'r', nodeId: 'n',
      outputDecls: [{ name: 'K' }],
    });
    consumeOutputs(token);
    const res = await POST(
      rpc(
        {
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'set_output', arguments: { key: 'K', value: 'v' } },
        },
        { Authorization: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(401);
  });

  it('returns isError for an unknown tool name', async () => {
    const token = mintToken({
      runId: 'r', nodeId: 'n',
      outputDecls: [{ name: 'K' }],
    });
    const res = await POST(
      rpc(
        {
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'frobnicate', arguments: {} },
        },
        { Authorization: `Bearer ${token}` },
      ),
    );
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }>; isError: boolean };
    };
    expect(body.result.isError).toBe(true);
  });
});

describe('POST /api/mcp/output — JSON-RPC envelope', () => {
  it('returns 204 for notifications (no id)', async () => {
    const token = mintToken({
      runId: 'r', nodeId: 'n',
      outputDecls: [{ name: 'K' }],
    });
    const res = await POST(
      rpc(
        { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
        { Authorization: `Bearer ${token}` },
      ),
    );
    expect(res.status).toBe(204);
  });

  it('returns -32601 for unknown method', async () => {
    const token = mintToken({
      runId: 'r', nodeId: 'n',
      outputDecls: [{ name: 'K' }],
    });
    const res = await POST(
      rpc(
        { jsonrpc: '2.0', id: 1, method: 'totally/made_up' },
        { Authorization: `Bearer ${token}` },
      ),
    );
    const body = (await res.json()) as { error?: { code: number } };
    expect(body.error?.code).toBe(-32601);
  });

  it('returns -32700 for invalid JSON body', async () => {
    const token = mintToken({
      runId: 'r', nodeId: 'n',
      outputDecls: [{ name: 'K' }],
    });
    const res = await POST(
      new Request('http://localhost/api/mcp/output', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: 'not json',
      }),
    );
    const body = (await res.json()) as { error?: { code: number } };
    expect(body.error?.code).toBe(-32700);
  });
});
