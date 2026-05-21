#!/usr/bin/env bash
# Echoes each argv element on its own line, prefixed with "ARG:", so the
# provider-runner tests can assert how resolveCliArgs / dangerousArgs shaped
# the spawned command line. Reads no stdin and ignores its environment.
for a in "$@"; do
  printf 'ARG:%s\n' "$a"
done
exit 0
