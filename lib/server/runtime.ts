/**
 * Bound HTTP server port for the in-process Next runtime.
 *
 * `server.ts` walks forward on EADDRINUSE (see listenWithFallback), so the
 * actually-bound port can differ from `process.env.PORT`. Anything that
 * needs to call back into our own routes (notably the SetOutput MCP server
 * injected into agent CLIs) must read the resolved port from here, not from
 * the env.
 *
 * In-process module state. Single-process by design — see server.ts.
 */

let boundPort: number | null = null;

export function setBoundPort(port: number): void {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`setBoundPort: port must be a positive integer ≤ 65535 (got ${port})`);
  }
  boundPort = port;
}

export function getBoundPort(): number {
  if (boundPort == null) {
    throw new Error(
      'server port not yet bound (setBoundPort must be called after listen)',
    );
  }
  return boundPort;
}

/** Test hook. Do not call from production code. */
export function __resetBoundPortForTests(): void {
  boundPort = null;
}
