import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import pkg from '@/package.json';
import { dataDir } from '@/lib/server/paths';

/**
 * GET /api/health — unauthenticated liveness/readiness probe.
 *
 * Intentionally open: a health probe must answer without credentials. The
 * payload is deliberately limited to non-sensitive fields — status, version,
 * process uptime, and a timestamp. Live workload telemetry (run / child-
 * process counts) is intentionally NOT exposed here: this endpoint answers
 * unauthenticated even in token-gated network mode, where activity counts
 * would be a reconnaissance signal. It also serves as the version endpoint —
 * a separate /api/version would be redundant.
 *
 * Beyond liveness it does one readiness check: that the data directory is
 * writable. A probe that only confirms the process is up would let the
 * supervisor (Docker `restart: unless-stopped`) report healthy while the app
 * silently cannot persist runs, triggers, or the audit log. A failed check
 * answers `503 { status: 'degraded' }` so the supervisor / load balancer
 * treats the instance as not-ready.
 *
 * `force-dynamic` is an explicit guard: the response embeds live values
 * (uptime, timestamp, the probe result) and must never be statically cached.
 */
export const dynamic = 'force-dynamic';

/**
 * Confirm the data directory is writable by creating and removing a tiny
 * probe file. Returns `false` on any failure rather than throwing — the
 * caller turns that into a degraded response.
 */
async function dataDirWritable(): Promise<boolean> {
  const dir = dataDir();
  // Random per-probe name: a fixed name would let two concurrent probes
  // (a load balancer and an operator, or a port-fallback second instance)
  // race so one `unlink` hits ENOENT and falsely reports degraded.
  const probe = path.join(dir, `.health-probe-${randomBytes(6).toString('hex')}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(probe, 'ok');
    await fs.unlink(probe);
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  try {
    const base = {
      version: pkg.version,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };

    if (!(await dataDirWritable())) {
      // The process is alive but cannot persist state — report not-ready.
      // The message is kept path-free: this endpoint is unauthenticated.
      return NextResponse.json(
        { status: 'degraded', error: 'data directory is not writable', ...base },
        { status: 503 },
      );
    }

    return NextResponse.json({ status: 'ok', ...base }, { status: 200 });
  } catch (err) {
    // A health endpoint that 500s on its own bug is worse than one that
    // reports degraded — surface the failure as 503 instead.
    const message = err instanceof Error ? err.message : 'health check failed';
    return NextResponse.json(
      { status: 'error', error: message },
      { status: 503 },
    );
  }
}
