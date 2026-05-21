import { requireAuth } from '@/lib/server/auth';
import { eventBus } from '@/lib/server/event-bus';
import { workflowEngine } from '@/lib/server/workflow-engine';
import type { RunSnapshot, WorkflowEvent } from '@/lib/shared/workflow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KEEPALIVE_MS = 25_000;

function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * SSE stream of run events.
 *
 *   GET /api/events             — multi-run firehose (all runs + queue events)
 *   GET /api/events?runId=<id>  — single-run filter (only events for that run)
 *
 * Initial `state_snapshot` shape:
 *   - filtered:   { type: 'state_snapshot', state: RunSnapshot, runId }
 *   - unfiltered: { type: 'state_snapshot', state: RunSnapshot, runs: RunSnapshot[] }
 *
 * The unfiltered `runs` array lists every currently-alive controller. The
 * `state` field stays as the most-recent run for back-compat with the
 * existing client. Future stages can flip the client to read `runs` directly.
 */
export async function GET(req: Request): Promise<Response> {
  // The browser's EventSource sends the session cookie on this same-origin
  // request automatically; MCP / API clients pass a bearer token.
  const unauth = requireAuth(req);
  if (unauth) return unauth;

  const encoder = new TextEncoder();
  const url = new URL(req.url);
  const filterRunId = url.searchParams.get('runId') ?? undefined;

  let unsubscribe: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let abortListener: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };

      // Initial snapshot.
      if (filterRunId) {
        const run = workflowEngine.getRun(filterRunId);
        const state: RunSnapshot = run
          ? run.getState()
          : { status: 'idle', iterationByLoopId: {}, scope: {}, events: [] };
        send(sseFrame({ type: 'state_snapshot', state, runId: filterRunId }));
      } else {
        const runs: RunSnapshot[] = workflowEngine.list().map((c) => c.getState());
        send(
          sseFrame({
            type: 'state_snapshot',
            state: workflowEngine.getState(),
            runs,
          }),
        );
      }

      unsubscribe = eventBus.subscribe((event: WorkflowEvent) => {
        if (filterRunId) {
          // Run-scoped events carry runId; queue events do not. Filter on
          // exact match. Queue events are dropped when a filter is set —
          // they aren't run-specific.
          const evRunId = (event as { runId?: string }).runId;
          if (evRunId !== filterRunId) return;
        }
        send(sseFrame(event));
      });

      keepalive = setInterval(() => send(': keep-alive\n\n'), KEEPALIVE_MS);

      abortListener = () => cleanup();
      req.signal.addEventListener('abort', abortListener);
    },
    cancel() {
      cleanup();
    },
  });

  function cleanup() {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (keepalive) {
      clearInterval(keepalive);
      keepalive = null;
    }
    if (abortListener) {
      try {
        req.signal.removeEventListener('abort', abortListener);
      } catch {
        // request may already be torn down
      }
      abortListener = null;
    }
  }

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
