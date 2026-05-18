import { afterEach, describe, expect, it } from 'bun:test';
import {
  __resetRegistryForTests,
  consumeOutputs,
  mintToken,
  releaseRun,
  requireRunToken,
  resolveToken,
  setOutput,
} from './output-registry';

afterEach(() => {
  __resetRegistryForTests();
  delete process.env.INFLOOP_MCP_TOKEN_TTL_MS;
  delete process.env.INFLOOP_MCP_VALUE_MAX_BYTES;
});

describe('output-registry', () => {
  describe('mintToken / resolveToken', () => {
    it('returns a 64-char hex token and resolves the entry', () => {
      const token = mintToken({
        runId: 'run-1',
        nodeId: 'agent-1',
        outputDecls: [{ name: 'PR_LINK' }, { name: 'PR_ID', description: 'pr id' }],
      });
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      const entry = resolveToken(token);
      expect(entry).not.toBeNull();
      expect(entry!.runId).toBe('run-1');
      expect(entry!.nodeId).toBe('agent-1');
      expect(Array.from(entry!.allowedKeys).sort()).toEqual(['PR_ID', 'PR_LINK']);
    });

    it('returns null for an unknown token', () => {
      expect(resolveToken('deadbeef')).toBeNull();
    });

    it('mints distinct tokens per call', () => {
      const a = mintToken({ runId: 'r', nodeId: 'n', outputDecls: [] });
      const b = mintToken({ runId: 'r', nodeId: 'n', outputDecls: [] });
      expect(a).not.toBe(b);
    });
  });

  describe('setOutput', () => {
    it('records a declared key and returns ok', () => {
      const token = mintToken({
        runId: 'r', nodeId: 'n',
        outputDecls: [{ name: 'PR_LINK' }],
      });
      const res = setOutput(token, 'PR_LINK', 'https://x');
      expect(res).toEqual({ ok: true });
      expect(resolveToken(token)!.outputs).toEqual({ PR_LINK: 'https://x' });
    });

    it('rejects an undeclared key', () => {
      const token = mintToken({
        runId: 'r', nodeId: 'n',
        outputDecls: [{ name: 'PR_LINK' }],
      });
      const res = setOutput(token, 'OTHER', 'x');
      expect(res.ok).toBe(false);
      if (res.ok === false) expect(res.code).toBe('unknown_key');
    });

    it('rejects a non-string value', () => {
      const token = mintToken({
        runId: 'r', nodeId: 'n',
        outputDecls: [{ name: 'K' }],
      });
      const res = setOutput(token, 'K', 123);
      expect(res.ok).toBe(false);
      if (res.ok === false) expect(res.code).toBe('invalid_value');
    });

    it('rejects an oversized value', () => {
      process.env.INFLOOP_MCP_VALUE_MAX_BYTES = '16';
      const token = mintToken({
        runId: 'r', nodeId: 'n',
        outputDecls: [{ name: 'K' }],
      });
      const res = setOutput(token, 'K', 'x'.repeat(64));
      expect(res.ok).toBe(false);
      if (res.ok === false) expect(res.code).toBe('value_too_large');
    });

    it('returns unknown_token for a revoked token', () => {
      const token = mintToken({
        runId: 'r', nodeId: 'n',
        outputDecls: [{ name: 'K' }],
      });
      consumeOutputs(token);
      const res = setOutput(token, 'K', 'x');
      expect(res.ok).toBe(false);
      if (res.ok === false) expect(res.code).toBe('unknown_token');
    });

    it('rejects after the sliding-window TTL elapses', () => {
      process.env.INFLOOP_MCP_TOKEN_TTL_MS = '1';
      const token = mintToken({
        runId: 'r', nodeId: 'n',
        outputDecls: [{ name: 'K' }],
      });
      // sleep ~10ms via busy wait — small but exceeds 1ms TTL.
      const until = Date.now() + 10;
      while (Date.now() < until) { /* spin */ }
      const res = setOutput(token, 'K', 'x');
      expect(res.ok).toBe(false);
      if (res.ok === false) expect(res.code).toBe('unknown_token');
    });

    it('refreshes the TTL on successful setOutput (sliding window)', () => {
      process.env.INFLOOP_MCP_TOKEN_TTL_MS = '50';
      const token = mintToken({
        runId: 'r', nodeId: 'n',
        outputDecls: [{ name: 'K' }],
      });
      const wait = (ms: number) => {
        const until = Date.now() + ms;
        while (Date.now() < until) { /* spin */ }
      };
      wait(30);
      const r1 = setOutput(token, 'K', 'a');
      expect(r1).toEqual({ ok: true });
      wait(30);
      // Without sliding refresh, total wait > TTL would revoke. With
      // refresh, the entry is still alive.
      const r2 = setOutput(token, 'K', 'b');
      expect(r2).toEqual({ ok: true });
    });
  });

  describe('consumeOutputs', () => {
    it('drains and revokes the token', () => {
      const token = mintToken({
        runId: 'r', nodeId: 'n',
        outputDecls: [{ name: 'K' }],
      });
      setOutput(token, 'K', 'v');
      expect(consumeOutputs(token)).toEqual({ K: 'v' });
      expect(resolveToken(token)).toBeNull();
    });

    it('returns an empty object for an unknown token', () => {
      expect(consumeOutputs('deadbeef')).toEqual({});
    });

    it('is idempotent (second call returns {})', () => {
      const token = mintToken({
        runId: 'r', nodeId: 'n',
        outputDecls: [{ name: 'K' }],
      });
      setOutput(token, 'K', 'v');
      expect(consumeOutputs(token)).toEqual({ K: 'v' });
      expect(consumeOutputs(token)).toEqual({});
    });
  });

  describe('releaseRun', () => {
    it('sweeps all tokens for the given runId', () => {
      const a = mintToken({
        runId: 'run-A', nodeId: 'n1',
        outputDecls: [{ name: 'K' }],
      });
      const b = mintToken({
        runId: 'run-A', nodeId: 'n2',
        outputDecls: [{ name: 'K' }],
      });
      const c = mintToken({
        runId: 'run-B', nodeId: 'n3',
        outputDecls: [{ name: 'K' }],
      });
      releaseRun('run-A');
      expect(resolveToken(a)).toBeNull();
      expect(resolveToken(b)).toBeNull();
      expect(resolveToken(c)).not.toBeNull();
    });
  });

  describe('requireRunToken', () => {
    function req(headers: Record<string, string>): Request {
      return new Request('http://localhost/api/mcp/output', { headers });
    }

    it('rejects requests without an Authorization header', () => {
      const res = requireRunToken(req({}));
      expect(res).toBeInstanceOf(Response);
      if (res instanceof Response) expect(res.status).toBe(401);
    });

    it('rejects malformed Authorization headers', () => {
      const res = requireRunToken(req({ Authorization: 'Basic xyz' }));
      expect(res).toBeInstanceOf(Response);
      if (res instanceof Response) expect(res.status).toBe(401);
    });

    it('rejects an unknown bearer token', () => {
      const res = requireRunToken(req({ Authorization: 'Bearer deadbeef' }));
      expect(res).toBeInstanceOf(Response);
      if (res instanceof Response) expect(res.status).toBe(401);
    });

    it('resolves a known bearer token', () => {
      const token = mintToken({
        runId: 'r', nodeId: 'n',
        outputDecls: [{ name: 'K' }],
      });
      const res = requireRunToken(req({ Authorization: `Bearer ${token}` }));
      expect(res).not.toBeInstanceOf(Response);
      if (!(res instanceof Response)) {
        expect(res.entry.runId).toBe('r');
        expect(res.token).toBe(token);
      }
    });

    it('accepts lowercase "bearer" scheme', () => {
      const token = mintToken({
        runId: 'r', nodeId: 'n',
        outputDecls: [{ name: 'K' }],
      });
      const res = requireRunToken(req({ Authorization: `bearer ${token}` }));
      expect(res).not.toBeInstanceOf(Response);
    });

    it('rejects (and evicts) an expired token instead of resurrecting it', () => {
      process.env.INFLOOP_MCP_TOKEN_TTL_MS = '1';
      const token = mintToken({
        runId: 'r', nodeId: 'n',
        outputDecls: [{ name: 'K' }],
      });
      const until = Date.now() + 10;
      while (Date.now() < until) { /* spin */ }
      const res = requireRunToken(req({ Authorization: `Bearer ${token}` }));
      expect(res).toBeInstanceOf(Response);
      if (res instanceof Response) expect(res.status).toBe(401);
      // Also confirm the entry was evicted, not just rejected.
      expect(resolveToken(token)).toBeNull();
    });
  });
});
