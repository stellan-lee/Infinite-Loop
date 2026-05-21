import { NextResponse } from 'next/server';
import pkg from '@/package.json';

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
 * `force-dynamic` is an explicit guard: the response embeds live values
 * (uptime, timestamp) and must never be statically cached.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(
      {
        status: 'ok',
        version: pkg.version,
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
      },
      { status: 200 },
    );
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
