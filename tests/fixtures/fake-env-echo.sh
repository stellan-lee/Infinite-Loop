#!/usr/bin/env bash
# Echoes selected environment variables, one per line, prefixed "ENV:<name>=",
# so the provider-runner tests can assert how the child's environment was
# built (notably the egress-proxy overrides). Reads no stdin, ignores argv.
for v in HTTPS_PROXY HTTP_PROXY NO_PROXY; do
  printf 'ENV:%s=%s\n' "$v" "${!v}"
done
exit 0
