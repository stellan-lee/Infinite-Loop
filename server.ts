import { createServer } from 'http';
import { networkInterfaces } from 'node:os';
import next from 'next';
import {
  activeChildCount,
  killAllChildren,
} from './lib/server/child-registry';
import { setBoundPort } from './lib/server/runtime';
import { evaluatePosture, isLoopbackHost } from './lib/server/network-posture';

const dev = process.env.NODE_ENV !== 'production';
const startPort = Number(process.env.PORT ?? 3000);
// Bind to loopback only by default: Infinite Loop executes arbitrary code
// (Script / Condition-command / Agent nodes), so a network-reachable server
// is unauthenticated remote code execution. Opt into LAN exposure with
// HOST=0.0.0.0 — the posture gate below then requires either an API token
// or an explicit INFLOOP_ALLOW_INSECURE=1 acknowledgement.
const host = process.env.HOST ?? '127.0.0.1';

// Fail closed before doing any work: refuse to start a network-reachable,
// unauthenticated server. `authEnabled` mirrors requireAuth() in
// lib/server/auth.ts, which treats an unset/empty INFLOOP_API_TOKEN as
// open mode (Boolean('') === false).
const posture = evaluatePosture({
  host,
  authEnabled: Boolean(process.env.INFLOOP_API_TOKEN),
  allowInsecure: process.env.INFLOOP_ALLOW_INSECURE === '1',
});
if (!posture.ok) {
  console.error(posture.error);
  process.exit(1);
}

// If the requested port is taken, walk forward up to this many ports.
const MAX_PORT_FALLBACK = 20;

const app = next({ dev, turbopack: dev });
const handle = app.getRequestHandler();

await app.prepare();

const httpServer = createServer((req, res) => {
  void handle(req, res);
});

const port = await listenWithFallback(httpServer, startPort, host, MAX_PORT_FALLBACK);
// Publish the resolved port so in-process callers (notably the SetOutput
// MCP server injected into agent CLIs) can build accurate callback URLs
// without re-reading process.env.PORT, which may be stale after fallback.
setBoundPort(port);
console.log(`Infinite Loop ready on http://${host}:${port}`);
if (port !== startPort) {
  console.log(`  (port ${startPort} was in use; fell through to ${port})`);
}
if (!isLoopbackHost(host)) {
  for (const url of lanUrls(port)) console.log(`  also: ${url}`);
}
if (posture.warning) {
  console.warn(`\n${posture.warning}\n`);
}

installShutdownHandlers(httpServer);

/**
 * Try to bind to `start`; on EADDRINUSE, bump the port and retry up to `maxTries` times.
 * Resolves to the port actually bound. Rejects if every port in the range is busy
 * or any other listen error occurs.
 */
function listenWithFallback(
  server: ReturnType<typeof createServer>,
  start: number,
  bindHost: string,
  maxTries: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    const tryListen = () => {
      const candidate = start + attempt;
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if (err.code === 'EADDRINUSE' && attempt < maxTries) {
          attempt += 1;
          console.warn(`port ${candidate} in use, trying ${start + attempt}...`);
          tryListen();
          return;
        }
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(candidate);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(candidate, bindHost);
    };

    tryListen();
  });
}

/**
 * Reap detached child processes on shutdown. Provider/script spawns use
 * `detached: true` (so per-run cancel can kill grandchildren); the side
 * effect is they sit in their own process group and don't receive the
 * server's SIGINT. Without this hook, Ctrl+C leaves provider CLIs running
 * as orphans. SIGTERM first, then SIGKILL after a short grace period.
 *
 * A second signal during shutdown forces immediate exit, so an impatient
 * Ctrl+C still escapes if a child ignores SIGTERM.
 */
function installShutdownHandlers(server: ReturnType<typeof createServer>): void {
  const GRACE_MS = 2000;
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      console.warn(`received second ${signal}; forcing exit`);
      killAllChildren('SIGKILL');
      process.exit(1);
    }
    shuttingDown = true;
    const count = activeChildCount();
    if (count > 0) {
      console.log(`shutting down (${signal}); terminating ${count} child process(es)...`);
    }
    killAllChildren('SIGTERM');
    const graceTimer = setTimeout(() => {
      killAllChildren('SIGKILL');
      process.exit(0);
    }, GRACE_MS);
    graceTimer.unref();
    server.close(() => {
      // HTTP drain finished — if children are also gone, exit early instead
      // of sitting on the full grace window.
      if (activeChildCount() === 0) {
        clearTimeout(graceTimer);
        process.exit(0);
      }
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => shutdown('SIGHUP'));
}

/** Best-effort enumeration of non-loopback IPv4 addresses for log output. */
function lanUrls(p: number): string[] {
  const out: string[] = [];
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        out.push(`http://${addr.address}:${p}`);
      }
    }
  }
  return out;
}
