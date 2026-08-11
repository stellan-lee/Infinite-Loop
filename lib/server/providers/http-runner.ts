import type { RunnerOptions, RunnerResult } from '../../shared/types';
import type { HttpProviderManifest } from './types';

function resolveBearerToken(
  manifest: HttpProviderManifest,
): { token?: string; error?: string } {
  if (manifest.auth?.type !== 'bearer') return {};

  // Inline token (from a *.hermes.local.json file the user configured via
  // the UI) wins; the env-var path is for committed manifests where the
  // secret deliberately lives off-disk.
  if (manifest.auth.token) return { token: manifest.auth.token };
  if (manifest.auth.envVar) {
    const token = process.env[manifest.auth.envVar]?.trim();
    if (token) return { token };
    return {
      error: `http-runner(${manifest.id}): env var ${manifest.auth.envVar} is not set`,
    };
  }
  return {};
}

/**
 * Drive an OpenAI-compatible `/chat/completions` endpoint with streaming,
 * mapping the SSE delta stream into the same RunnerResult contract the CLI
 * runner produces. Honors abort + timeoutMs the same way as the spawn-based
 * runner, so the engine doesn't have to care which transport ran.
 *
 * The request body is intentionally minimal — `model` + `messages` +
 * `stream:true`. Manifests can extend this later; for now the goal is "talk
 * to Hermes / OpenRouter / vLLM and stream tokens back".
 */
export async function runHttpProvider(
  manifest: HttpProviderManifest,
  opts: RunnerOptions,
): Promise<RunnerResult> {
  const startedAt = Date.now();
  const url = manifest.baseUrl + manifest.endpoint;

  const profile = opts.profile ?? manifest.defaultProfile;
  if (!profile) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `http-runner(${manifest.id}): no profile selected and no defaultProfile in manifest`,
      durationMs: Date.now() - startedAt,
      timedOut: false,
    };
  }

  const auth = resolveBearerToken(manifest);
  if (auth.error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: auth.error,
      durationMs: Date.now() - startedAt,
      timedOut: false,
    };
  }

  // Compose an AbortController that fires on either the caller's signal or
  // our local timeout. We can't reuse opts.signal directly because we need
  // to distinguish "user aborted" from "we timed out" in the result.
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort();

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  if (opts.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.timeoutMs);
  }

  if (opts.signal.aborted) {
    controller.abort();
  } else {
    opts.signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  const cleanup = (): void => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    opts.signal.removeEventListener('abort', onCallerAbort);
  };

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
  };
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;

  const body = JSON.stringify({
    model: profile,
    messages: [{ role: 'user', content: opts.prompt }],
    stream: true,
  });

  let stdout = '';
  let stderr = '';
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    cleanup();
    const aborted = (err as Error)?.name === 'AbortError';
    return {
      exitCode: aborted ? null : 1,
      stdout,
      stderr:
        `http-runner(${manifest.id}) fetch error: ${(err as Error).message}`,
      durationMs: Date.now() - startedAt,
      timedOut,
    };
  }

  if (!resp.ok || !resp.body) {
    let errText = '';
    try {
      errText = await resp.text();
    } catch {
      // ignore
    }
    cleanup();
    // 8KB cap on the error body in stderr. Most provider 4xx responses are
    // a short JSON object, but some echo the request back or include the
    // full prompt — without a cap one bad call could balloon the run log.
    return {
      exitCode: 1,
      stdout,
      stderr:
        `http-runner(${manifest.id}) HTTP ${resp.status}: ${errText.slice(0, 8192)}`,
      durationMs: Date.now() - startedAt,
      timedOut,
    };
  }

  // SSE framing: events separated by `\n\n`, each event has one or more
  // `data: <payload>` lines. We buffer raw bytes, decode incrementally so
  // multi-byte UTF-8 codepoints split across chunks survive, and flush
  // whole events as `\n\n` boundaries land.
  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';

  // Some fetch implementations don't reliably propagate an AbortController
  // abort to an in-flight `reader.read()` promise — particularly when the
  // server has sent headers but no body bytes yet. Wire the controller's
  // abort directly to `reader.cancel()` so the read loop always unblocks.
  const onAbortCancelReader = (): void => {
    reader.cancel().catch(() => {
      // ignore — we're tearing down anyway
    });
  };
  controller.signal.addEventListener('abort', onAbortCancelReader, { once: true });

  const emitDelta = (text: string): void => {
    if (text.length === 0) return;
    stdout += text;
    opts.onStdoutChunk?.(text);
  };

  // Parse one fully-buffered SSE event. Returns true if the stream signals
  // [DONE]; otherwise pushes any text delta and returns false.
  const handleEvent = (event: string): boolean => {
    // Each line within an event can be `data: …`, `event: …`, `:comment`, etc.
    // OpenAI streams only use `data:`; we ignore others. Split on /\r?\n/
    // because Cloudflare-fronted endpoints send CRLF.
    let done = false;
    for (const rawLine of event.split(/\r?\n/)) {
      if (!rawLine.startsWith('data:')) continue;
      const payload = rawLine.slice(5).trim();
      if (payload === '[DONE]') {
        done = true;
        continue;
      }
      if (payload.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload);
      } catch {
        stderr +=
          (stderr.length > 0 ? '\n' : '') +
          `http-runner(${manifest.id}): non-JSON SSE payload: ${payload.slice(0, 200)}`;
        continue;
      }
      const text = extractDeltaText(parsed);
      if (text) emitDelta(text);
    }
    return done;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // SSE event boundary is two consecutive line endings — accept both
      // \n\n (Unix, default for Node) and \r\n\r\n (CRLF, sent by some
      // Cloudflare-fronted endpoints). exec gives us the matched separator's
      // length so we can advance past it without rescanning.
      const sepRe = /\r?\n\r?\n/g;
      let match: RegExpExecArray | null;
      let consumed = 0;
      let doneSeen = false;
      while ((match = sepRe.exec(buf)) !== null) {
        const event = buf.slice(consumed, match.index);
        consumed = match.index + match[0].length;
        if (handleEvent(event)) {
          // [DONE] received — drop the rest of the stream defensively.
          doneSeen = true;
          break;
        }
      }
      buf = buf.slice(consumed);
      if (doneSeen) {
        buf = '';
        try {
          await reader.cancel();
        } catch {
          // ignore — already tearing down
        }
        break;
      }
    }
    // Decoder flush — surfaces any final UTF-8 codepoint, but we deliberately
    // do NOT try to parse a trailing partial event here. A connection cut
    // mid-`data:` line would otherwise show up as "non-JSON SSE payload" noise
    // in stderr; if the stream ended cleanly the server already terminated
    // with `\n\n` and there's nothing left to flush.
    buf += decoder.decode();
  } catch (err) {
    const aborted = (err as Error)?.name === 'AbortError';
    cleanup();
    return {
      exitCode: aborted ? null : 1,
      stdout,
      stderr:
        stderr +
        (stderr.length > 0 ? '\n' : '') +
        `http-runner(${manifest.id}) stream error: ${(err as Error).message}`,
      durationMs: Date.now() - startedAt,
      timedOut,
    };
  }

  cleanup();

  if (timedOut) {
    return {
      exitCode: null,
      stdout,
      stderr,
      durationMs: Date.now() - startedAt,
      timedOut: true,
    };
  }
  if (opts.signal.aborted) {
    return {
      exitCode: null,
      stdout,
      stderr,
      durationMs: Date.now() - startedAt,
      timedOut: false,
    };
  }
  return {
    exitCode: 0,
    stdout,
    stderr,
    durationMs: Date.now() - startedAt,
    timedOut: false,
  };
}

/**
 * Perform one non-streaming OpenAI-compatible chat completion that requires
 * strict JSON Schema output. This intentionally does not reuse the streaming
 * Agent path: its response and `Accept` contracts are different.
 */
export async function runHttpStructuredOutput(
  manifest: HttpProviderManifest,
  opts: RunnerOptions,
  schema: Record<string, unknown>,
): Promise<RunnerResult> {
  const startedAt = Date.now();
  const profile = opts.profile ?? manifest.defaultProfile;
  if (!profile) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `http-runner(${manifest.id}): no profile selected and no defaultProfile in manifest`,
      durationMs: Date.now() - startedAt,
      timedOut: false,
    };
  }

  const auth = resolveBearerToken(manifest);
  if (auth.error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: auth.error,
      durationMs: Date.now() - startedAt,
      timedOut: false,
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = () => controller.abort();
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  if (opts.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.timeoutMs);
  }
  if (opts.signal.aborted) controller.abort();
  else opts.signal.addEventListener('abort', onCallerAbort, { once: true });

  const cleanup = (): void => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    opts.signal.removeEventListener('abort', onCallerAbort);
  };

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;

  let resp: Response;
  try {
    resp = await fetch(manifest.baseUrl + manifest.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: profile,
        messages: [{ role: 'user', content: opts.prompt }],
        stream: false,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'structured_output',
            strict: true,
            schema,
          },
        },
      }),
      signal: controller.signal,
    });
  } catch (err) {
    cleanup();
    const aborted = (err as Error)?.name === 'AbortError';
    return {
      exitCode: aborted ? null : 1,
      stdout: '',
      stderr: `http-runner(${manifest.id}) fetch error: ${(err as Error).message}`,
      durationMs: Date.now() - startedAt,
      timedOut,
    };
  }

  if (!resp.ok) {
    let errText = '';
    try {
      errText = await readTextUntilAbort(resp, controller.signal);
    } catch (err) {
      const aborted = (err as Error)?.name === 'AbortError';
      if (aborted) {
        cleanup();
        return {
          exitCode: null,
          stdout: '',
          stderr: '',
          durationMs: Date.now() - startedAt,
          timedOut,
        };
      }
      // Ignore body-read failure and retain the HTTP status.
    }
    cleanup();
    return {
      exitCode: 1,
      stdout: '',
      stderr: `http-runner(${manifest.id}) HTTP ${resp.status}: ${errText.slice(0, 8192)}`,
      durationMs: Date.now() - startedAt,
      timedOut,
    };
  }

  let payload: unknown;
  try {
    payload = await readJsonUntilAbort(resp, controller.signal);
  } catch (err) {
    cleanup();
    const aborted = (err as Error)?.name === 'AbortError';
    return {
      exitCode: aborted ? null : 1,
      stdout: '',
      stderr: aborted ? '' : `http-runner(${manifest.id}) invalid JSON response: ${(err as Error).message}`,
      durationMs: Date.now() - startedAt,
      timedOut,
    };
  }
  cleanup();

  if (timedOut || opts.signal.aborted) {
    return {
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: Date.now() - startedAt,
      timedOut,
    };
  }

  const message = extractStructuredMessage(payload);
  if (message.refusal) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `http-runner(${manifest.id}) provider refusal: ${message.refusal.slice(0, 8192)}`,
      durationMs: Date.now() - startedAt,
      timedOut: false,
    };
  }
  if (!message.content) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `http-runner(${manifest.id}) response did not contain assistant content`,
      durationMs: Date.now() - startedAt,
      timedOut: false,
    };
  }
  return {
    exitCode: 0,
    stdout: message.content,
    stderr: '',
    durationMs: Date.now() - startedAt,
    timedOut: false,
  };
}

/**
 * Some fetch implementations do not reject an in-flight `Response.json()`
 * when its signal aborts while an incomplete body is still open. Race the
 * decode with the same controller so the runner honours its timeout/caller
 * abort regardless of that implementation detail.
 */
async function readJsonUntilAbort(resp: Response, signal: AbortSignal): Promise<unknown> {
  return readResponseUntilAbort(() => resp.json(), signal);
}

function readTextUntilAbort(resp: Response, signal: AbortSignal): Promise<string> {
  return readResponseUntilAbort(() => resp.text(), signal);
}

async function readResponseUntilAbort<T>(
  read: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException('response read aborted', 'AbortError'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([read(), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function extractStructuredMessage(payload: unknown): {
  content?: string;
  refusal?: string;
} {
  if (!payload || typeof payload !== 'object') return {};
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return {};
  const message = (choices[0] as { message?: unknown } | undefined)?.message;
  if (!message || typeof message !== 'object') return {};
  const obj = message as { content?: unknown; refusal?: unknown };
  return {
    ...(typeof obj.content === 'string' ? { content: obj.content } : {}),
    ...(typeof obj.refusal === 'string' ? { refusal: obj.refusal } : {}),
  };
}

/** Pull the text delta out of an OpenAI chat-completions stream chunk:
 * `{choices: [{delta: {content: "..."}}]}`. */
function extractDeltaText(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const obj = parsed as { choices?: unknown };
  if (!Array.isArray(obj.choices) || obj.choices.length === 0) return '';
  const first = obj.choices[0] as { delta?: { content?: unknown } } | undefined;
  if (
    first?.delta &&
    typeof first.delta === 'object' &&
    typeof first.delta.content === 'string'
  ) {
    return first.delta.content;
  }
  return '';
}
