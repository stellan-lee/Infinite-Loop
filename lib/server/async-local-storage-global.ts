/*
 * Expose Node's AsyncLocalStorage as a global before Next.js initializes.
 *
 * Next.js 16's App Router internals (`work-async-storage`, the `after` API)
 * build their AsyncLocalStorage instances through Next's
 * `createAsyncLocalStorage()`, which reads `globalThis.AsyncLocalStorage`.
 * When that global is unset, Next falls back to a stub whose every method
 * throws `Invariant: AsyncLocalStorage accessed in runtime where it is not
 * available` — and the first request through the Next request pipeline then
 * escapes as an uncaughtException and crash-loops the process.
 *
 * `next start` sets this global in its own server bootstrap. Infinite Loop
 * ships a custom server (`server.ts`) which never runs that bootstrap, so we
 * set it ourselves. Bun provides a fully working `AsyncLocalStorage` via
 * `node:async_hooks`; this only makes it discoverable under the name Next
 * probes for.
 *
 * This module has no exports — it runs purely for the side effect, and it
 * MUST finish before `server.ts` is evaluated. It is therefore wired as a Bun
 * `--preload` on every command that launches `server.ts` (the Dockerfile CMD,
 * the `dev`/`start` package.json scripts, and the Playwright E2E harness),
 * enforced by async-local-storage-global.test.ts. Two non-obvious points:
 *
 *   - A plain first-`import` inside `server.ts` is NOT enough: Bun begins
 *     evaluating Next's `work-async-storage` module graph before `server.ts`'s
 *     own first import runs, so the stub is captured before that import can
 *     set the global. Only a true `--preload` runs early enough.
 *   - It is deliberately NOT wired via `bunfig.toml`'s `preload`: bunfig.toml
 *     is not copied into the runtime Docker image, so a bunfig preload would
 *     silently not apply in production — the one place that must not crash.
 *
 * Idempotent: an already-set global (e.g. a future runtime that provides one)
 * is left untouched.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const globalRef = globalThis as typeof globalThis & {
  AsyncLocalStorage?: typeof AsyncLocalStorage;
};

globalRef.AsyncLocalStorage ??= AsyncLocalStorage;
