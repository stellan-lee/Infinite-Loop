/*
 * Data-directory writability probe — the shared readiness check behind both
 * `/api/health` and the `infloop_data_dir_writable` metric.
 *
 * The process can be alive and still answering scrapes while its data
 * directory has become unwritable (a full disk, a permissions change on the
 * volume) — in which case it silently cannot persist runs, triggers, or the
 * audit log. `/api/health` turns a failed probe into a `503 degraded`
 * response so the Docker healthcheck flips the container `unhealthy`;
 * `/api/metrics` turns it into the `infloop_data_dir_writable` gauge so
 * Prometheus can alert on it (`InfiniteLoopDataDirNotWritable`).
 *
 * Both endpoints must judge the *same* condition — sharing this one function
 * guarantees the healthcheck and the alert cannot drift apart.
 */

import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { dataDir } from './paths';

/**
 * Confirm the data directory is writable by creating and removing a tiny
 * probe file. Returns `false` on any failure rather than throwing — every
 * caller turns that into a not-ready signal, never into a 500.
 */
export async function dataDirWritable(): Promise<boolean> {
  const dir = dataDir();
  // Random per-probe name: a fixed name would let two concurrent probes — a
  // metrics scrape racing a health check, or a load balancer racing an
  // operator — collide so one `unlink` hits ENOENT and falsely reports
  // degraded.
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
