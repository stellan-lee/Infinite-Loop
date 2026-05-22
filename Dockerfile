# syntax=docker/dockerfile:1
#
# Infinite Loop — supervised deployment image.
#
# DEVIATION FROM THE TYPESCRIPT DOCKERFILE STANDARD: that standard mandates a
# distroless final image with no Bun, no node_modules, and no TypeScript at
# runtime. None of that is possible here, and the deviation is deliberate.
# Infinite Loop is a Next.js custom-server app whose *production runtime is
# Bun itself*: the entry point `server.ts` is executed as TypeScript and is
# never compiled to JavaScript, so a distroless-Node image cannot run it. The
# rest of the standard is kept — a Bun-only multi-stage build, a
# production-deps-only runtime on the slim base, and a non-root final image.
# See docs/deployment.md.

# Single source of truth for the Bun version — pinned to a full patch for
# reproducible builds. docker-compose.yml inherits this default.
ARG BUN_VERSION=1.3.13

# --- builder: full dependency set + `next build` ----------------------------
FROM oven/bun:${BUN_VERSION} AS builder
WORKDIR /app
# Install from the lockfile first so this layer caches across source edits.
# devDependencies are needed here: `next build` type-checks the app.
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile
COPY . .
# Drop the build cache after building: it is not needed at runtime, and
# pruning it here (rather than in a later stage) actually shrinks the image —
# a delete in a later layer would only mask it, not reclaim the space.
RUN bun run build && rm -rf .next/cache

# --- prod-deps: production-only node_modules --------------------------------
FROM oven/bun:${BUN_VERSION} AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
# --production omits devDependencies. Bun strips TypeScript types at runtime,
# so `typescript` / `@types/*` are build-only and correctly excluded here.
RUN bun install --frozen-lockfile --production

# --- runtime ----------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS runtime

# Crash recovery (lib/server/crash-recovery.ts) shells out to `ps` for orphan
# PID-reuse protection. The slim base omits it; without `ps` that protection
# silently degrades. Install procps so crash recovery is fully functional.
RUN apt-get update \
  && apt-get install -y --no-install-recommends procps \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3000 \
    INFLOOP_DATA_DIR=/data

WORKDIR /app

# Production dependencies only.
COPY --from=prod-deps /app/node_modules ./node_modules

# Next.js build output and static assets.
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public

# The custom server and the modules Bun executes as TypeScript at runtime.
# Request handlers are already compiled into .next; server.ts and lib/ are
# not part of `next build` and must ship as source.
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/lib ./lib

# next.config.js: Next's runtime config. tsconfig.json: the `@/` path-alias
# map Bun resolves while running server.ts. package.json: `"type": "module"`
# and the version reported by /api/health.
COPY --from=builder /app/next.config.js ./next.config.js
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/package.json ./package.json

# Operator CLIs (data-directory backup and restore) — run with
# `docker compose exec`/`run`. See docs/backup-restore.md.
COPY --from=builder /app/scripts ./scripts

# Read-mostly inputs resolved from the working directory at runtime: shipped
# library presets, provider manifests, and webhook plugins.
COPY --from=builder /app/workflows ./workflows
COPY --from=builder /app/providers ./providers
COPY --from=builder /app/webhook-plugins ./webhook-plugins

# All mutable state (workflows, runs, triggers, connections, and the
# crash-recovery pid / active-run markers) lives under INFLOOP_DATA_DIR.
# chown before dropping privileges so a volume mounted at /data inherits
# writable ownership for the unprivileged `bun` user on first creation.
RUN mkdir -p /data && chown -R bun:bun /data

# $HOME for the unprivileged user. Agent CLIs spawned inside the container
# (Claude Code, git, the Bun transpile cache) write config and credentials
# under $HOME; the hardened docker-compose.yml backs it with a writable named
# volume on an otherwise read-only root filesystem. Create the directory and
# chown it so a fresh volume inherits bun-writable ownership.
RUN mkdir -p /home/bun && chown -R bun:bun /home/bun

USER bun
EXPOSE 3000

# Liveness probe against the unauthenticated /api/health endpoint. The port
# is hardcoded: HEALTHCHECK exec form does not expand environment variables,
# and PORT is fixed at 3000 in this image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# `--preload` sets globalThis.AsyncLocalStorage before server.ts (and Next's
# App Router internals) are evaluated. Without it Next 16 falls back to a
# throwing AsyncLocalStorage stub and the container crash-loops on the first
# request. See lib/server/async-local-storage-global.ts.
CMD ["bun", "--preload", "./lib/server/async-local-storage-global.ts", "server.ts"]
