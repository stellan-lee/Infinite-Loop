#!/usr/bin/env bash
# Deterministic stub agent for the Infinite Loop production-smoke E2E suite.
#
# Wired in as the `e2e-echo` CLI provider (see tests/e2e/lib/server.ts). It
# never contacts a real model, so the suite is fast, offline, and spends no API
# credits. The provider manifest declares outputFormat "plain", so each line
# printed below is surfaced verbatim as a streamed token chunk.
#
# The prompt arrives as $1 (provider manifest: promptVia "arg", args ["{prompt}"]).
#
# Env knobs:
#   FAKE_AGENT_SLEEP_MS  Hang this many ms before the final line (default 0).
#                        The crash-recovery spec sets this so a run stays
#                        in-flight while its server is SIGKILLed.

ms="${FAKE_AGENT_SLEEP_MS:-0}"

echo "[e2e-echo] stub agent online"
echo "[e2e-echo] prompt: ${1:-<none>}"

if [ "$ms" != "0" ]; then
  sleep "$(awk -v m="$ms" 'BEGIN { printf "%.3f", m / 1000 }')"
fi

echo "[e2e-echo] done"
exit 0
