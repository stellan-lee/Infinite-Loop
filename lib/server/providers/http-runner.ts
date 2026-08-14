import type { RunnerOptions, RunnerResult } from '../../shared/types';
import type { HttpProviderManifest } from './types';

const PROTECTED_REQUEST_FIELDS = new Set([
  'model',
  'input',
  'messages',
  'stream',
  'text',
  'response_format',
  'n',
]);

/** HTTP providers deliberately use one protocol: the OpenAI Responses API.
 * Keeping this check at the transport boundary prevents an old manifest from
 * quietly sending a Responses-shaped payload to Chat Completions (or vice
 * versa), which would otherwise produce an opaque provider error. */
function responsesEndpointError(manifest: HttpProviderManifest): string | null {
  if (manifest.endpoint.replace(/\/+$/, '') === '/responses') return null;
  return `http-runner(${manifest.id}): Responses API required; endpoint "${manifest.endpoint}" is not "/responses". Reconfigure this provider to use /responses.`;
}

/** Provider settings are intentionally applied first. The node executor owns
 * protocol-critical request fields so a global setting cannot make a strict
 * JSON Schema request non-strict or redirect its selected model. */
function requestBody(
  manifest: HttpProviderManifest,
  fields: Record<string, unknown>,
): string {
  const options = Object.fromEntries(
    Object.entries(manifest.requestOptions ?? {}).filter(([key]) => !PROTECTED_REQUEST_FIELDS.has(key)),
  );
  return JSON.stringify({ ...options, ...fields });
}

/** Same precedence rule for headers: custom headers are useful for gateways,
 * but they cannot replace content negotiation or bearer authorization. */
function requestHeaders(
  manifest: HttpProviderManifest,
  accept: string,
  token?: string,
): Record<string, string> {
  const customHeaders = Object.fromEntries(
    Object.entries(manifest.headers ?? {}).filter(([name]) => {
      const normalized = name.toLowerCase();
      return normalized !== 'authorization' && normalized !== 'content-type' && normalized !== 'accept';
    }),
  );
  const headers: Record<string, string> = {
    ...customHeaders,
    'content-type': 'application/json',
    accept,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

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
 * Drive an OpenAI-compatible `/responses` endpoint with streaming, mapping
 * Responses API output-text deltas into the same RunnerResult contract the CLI
 * runner produces. Honors abort + timeoutMs the same way as the spawn-based
 * runner, so the engine doesn't have to care which transport ran.
 *
 * The request body is intentionally minimal — `model` + `input` +
 * `stream:true`. Manifests can extend this later; for now the goal is "talk
 * to Hermes / OpenRouter / vLLM and stream tokens back".
 */
export async function runHttpProvider(
  manifest: HttpProviderManifest,
  opts: RunnerOptions,
): Promise<RunnerResult> {
  const startedAt = Date.now();
  const endpointError = responsesEndpointError(manifest);
  if (endpointError) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: endpointError,
      durationMs: Date.now() - startedAt,
      timedOut: false,
    };
  }
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

  const headers = requestHeaders(manifest, 'text/event-stream', auth.token);

  const body = requestBody(manifest, {
    model: profile,
    input: opts.messages ?? opts.prompt,
    stream: true,
  });

  let stdout = '';
  let stderr = '';
  let streamError = '';
  let streamRefusal = '';
  let streamCompleted = false;
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

  // Parse one fully-buffered Responses SSE event. The event name and payload
  // both identify `response.output_text.delta`; checking either keeps the
  // parser compatible with servers that omit one of the redundant fields.
  const handleEvent = (event: string): boolean => {
    // Each line within an event can be `data: …`, `event: …`, `:comment`, etc.
    // Split on /\r?\n/ because Cloudflare-fronted endpoints send CRLF.
    let done = false;
    let eventName = '';
    for (const rawLine of event.split(/\r?\n/)) {
      if (rawLine.startsWith('event:')) {
        eventName = rawLine.slice(6).trim();
        continue;
      }
      if (!rawLine.startsWith('data:')) continue;
      const payload = rawLine.slice(5).trim();
      if (payload === '[DONE]') {
        streamCompleted = true;
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
      const text = extractResponseDeltaText(parsed, eventName);
      if (text) emitDelta(text);
      const refusal = extractResponseStreamRefusal(parsed, eventName);
      if (refusal) streamRefusal += refusal;
      if (isResponseStreamCompleted(parsed, eventName)) {
        streamCompleted = true;
        done = true;
      }
      const providerError = extractResponseStreamError(parsed, eventName);
      if (providerError) {
        streamError = providerError;
        done = true;
      }
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
  if (streamError) {
    return {
      exitCode: 1,
      stdout,
      stderr: `http-runner(${manifest.id}) provider error: ${streamError.slice(0, 8192)}`,
      durationMs: Date.now() - startedAt,
      timedOut: false,
    };
  }
  if (streamRefusal) {
    return {
      exitCode: 1,
      stdout,
      stderr: `http-runner(${manifest.id}) provider refusal: ${streamRefusal.slice(0, 8192)}`,
      durationMs: Date.now() - startedAt,
      timedOut: false,
    };
  }
  if (!streamCompleted) {
    return {
      exitCode: 1,
      stdout,
      stderr: `http-runner(${manifest.id}) Responses stream ended before response.completed`,
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
 * Perform one non-streaming OpenAI Responses API request that requires strict
 * JSON Schema output. This intentionally does not reuse the streaming Agent
 * path: its response and `Accept` contracts are different.
 */
export async function runHttpStructuredOutput(
  manifest: HttpProviderManifest,
  opts: RunnerOptions,
  schema: Record<string, unknown>,
): Promise<RunnerResult> {
  const startedAt = Date.now();
  const endpointError = responsesEndpointError(manifest);
  if (endpointError) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: endpointError,
      durationMs: Date.now() - startedAt,
      timedOut: false,
    };
  }
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

  const headers = requestHeaders(manifest, 'application/json', auth.token);

  let resp: Response;
  try {
    resp = await fetch(manifest.baseUrl + manifest.endpoint, {
      method: 'POST',
      headers,
      body: requestBody(manifest, {
        model: profile,
        input: opts.prompt,
        stream: false,
        text: {
          format: {
            type: 'json_schema',
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
  if (message.error) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `http-runner(${manifest.id}) provider error: ${message.error.slice(0, 8192)}`,
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
  error?: string;
} {
  if (!payload || typeof payload !== 'object') return {};
  const root = payload as {
    output?: unknown;
    status?: unknown;
    error?: unknown;
    incomplete_details?: unknown;
  };
  const error = responseErrorMessage(root.error);
  if (error) return { error };
  if (typeof root.status === 'string' && root.status !== 'completed') {
    if (root.status === 'failed') return { error: 'response failed without an error message' };
    if (root.status === 'cancelled') return { error: 'response cancelled' };
    if (root.status !== 'incomplete') return { error: `response ${root.status}` };
    const reason = root.incomplete_details && typeof root.incomplete_details === 'object'
      ? (root.incomplete_details as { reason?: unknown }).reason
      : undefined;
    return { error: `response incomplete${typeof reason === 'string' ? `: ${reason}` : ''}` };
  }
  const output = root.output;
  if (!Array.isArray(output)) return {};
  let content = '';
  let refusal = '';
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const parts = (item as { content?: unknown }).content;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const value = part as { type?: unknown; text?: unknown; refusal?: unknown };
      if (value.type === 'output_text' && typeof value.text === 'string') content += value.text;
      if (value.type === 'refusal' && typeof value.refusal === 'string') refusal += value.refusal;
    }
  }
  return {
    ...(content ? { content } : {}),
    ...(refusal ? { refusal } : {}),
  };
}

/** Pull the text delta out of a Responses API stream event:
 * `{type: "response.output_text.delta", delta: "..."}`. */
function extractResponseDeltaText(parsed: unknown, eventName: string): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const obj = parsed as { type?: unknown; delta?: unknown };
  if (obj.type !== 'response.output_text.delta' && eventName !== 'response.output_text.delta') return '';
  return typeof obj.delta === 'string' ? obj.delta : '';
}

function responseStreamType(parsed: unknown, eventName: string): string {
  if (!parsed || typeof parsed !== 'object') return eventName;
  const type = (parsed as { type?: unknown }).type;
  return typeof type === 'string' ? type : eventName;
}

/** A Responses stream is only successful after its canonical completed event.
 * `[DONE]` remains accepted solely for gateways that terminate a valid
 * Responses stream with the older marker. */
function isResponseStreamCompleted(parsed: unknown, eventName: string): boolean {
  if (responseStreamType(parsed, eventName) !== 'response.completed') return false;
  const response = (parsed as { response?: unknown }).response;
  return !response || typeof response !== 'object' || (response as { status?: unknown }).status === 'completed';
}

/** Responses streaming reports terminal provider failures as `error` and
 * non-completed `response.*` events. Do not turn either into a successful
 * empty Agent result. */
function extractResponseStreamError(parsed: unknown, eventName: string): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const obj = parsed as { type?: unknown; message?: unknown; error?: unknown; response?: unknown };
  const type = responseStreamType(parsed, eventName);
  if (type === 'error') return typeof obj.message === 'string' ? obj.message : 'stream error';
  if (type !== 'response.failed' && type !== 'response.incomplete' && type !== 'response.cancelled') return '';
  const response = obj.response && typeof obj.response === 'object'
    ? obj.response as { error?: unknown; incomplete_details?: unknown }
    : undefined;
  const error = responseErrorMessage(response?.error);
  if (error) return error;
  if (type === 'response.incomplete') {
    const reason = response?.incomplete_details && typeof response.incomplete_details === 'object'
      ? (response.incomplete_details as { reason?: unknown }).reason
      : undefined;
    return `response incomplete${typeof reason === 'string' ? `: ${reason}` : ''}`;
  }
  if (type === 'response.cancelled') return 'response cancelled';
  return 'response failed without an error message';
}

/** Refusals are not successful empty responses. We accumulate deltas until
 * the final refusal event, and also report a truncated stream that only sent
 * one or more refusal deltas. */
function extractResponseStreamRefusal(parsed: unknown, eventName: string): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const obj = parsed as { delta?: unknown; refusal?: unknown };
  const type = responseStreamType(parsed, eventName);
  if (type === 'response.refusal.delta') return typeof obj.delta === 'string' ? obj.delta : '';
  if (type === 'response.refusal.done') return typeof obj.refusal === 'string' ? obj.refusal : '';
  return '';
}

function responseErrorMessage(value: unknown): string {
  if (typeof value === 'string' && value) return value;
  if (!value || typeof value !== 'object') return '';
  const message = (value as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
}
