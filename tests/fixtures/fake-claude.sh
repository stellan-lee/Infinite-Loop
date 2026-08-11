#!/usr/bin/env bash
# Fake CLI for testing the provider runner (lib/server/providers/runner.ts).
# Backs both the "claude-stream-json" and "plain" output-format paths.
#
# Configurable via env vars:
#   FAKE_STDOUT_LINES           Newline-delimited stdout payload (default: two lines).
#   FAKE_DELAY_MS_BETWEEN_LINES Sleep between lines in ms (default 0).
#   FAKE_SLEEP_MS_BEFORE_EXIT   Sleep at end before exiting in ms (default 0).
#   FAKE_EXIT_CODE              Numeric exit code (default 0).
#   FAKE_STDERR                 Optional stderr line.
#
# CLI args (e.g. --print and the prompt) are intentionally ignored.

ms_to_s() {
  # Convert integer milliseconds to a decimal seconds string for `sleep`.
  local ms="$1"
  if [ -z "$ms" ] || [ "$ms" = "0" ]; then
    echo "0"
    return
  fi
  awk -v m="$ms" 'BEGIN { printf "%.3f", m / 1000 }'
}

LINES="${FAKE_STDOUT_LINES:-line one
line two}"
BETWEEN_MS="${FAKE_DELAY_MS_BETWEEN_LINES:-0}"
END_MS="${FAKE_SLEEP_MS_BEFORE_EXIT:-0}"
EXIT_CODE="${FAKE_EXIT_CODE:-0}"

if [ -n "${FAKE_STDERR:-}" ]; then
  printf '%s\n' "$FAKE_STDERR" >&2
fi


between_s="$(ms_to_s "$BETWEEN_MS")"
first=1
while IFS= read -r line; do
  if [ "$first" -eq 0 ] && [ "$between_s" != "0" ]; then
    sleep "$between_s"
  fi
  printf '%s\n' "$line"
  first=0
done <<EOF
$LINES
EOF

end_s="$(ms_to_s "$END_MS")"
if [ "$end_s" != "0" ]; then
  sleep "$end_s"
fi

exit "$EXIT_CODE"
