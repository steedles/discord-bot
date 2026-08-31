#!/usr/bin/env bash
# Starts a virtual display, then the sidecar on it.
#
# Replaces `xvfb-run`, which started Xvfb, silently failed to launch the command
# (its error output defaults to /dev/null) and left a container that looked
# perfectly healthy while running nothing at all. Explicit is better here: three
# lines we can read beats a wrapper that hides its own failure.
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
SCREEN="${SCREEN:-1280x900x24}"

echo "{\"ts\":\"$(date -u +%FT%TZ)\",\"level\":\"info\",\"msg\":\"starting Xvfb\",\"display\":\"${DISPLAY}\",\"screen\":\"${SCREEN}\"}"
Xvfb "${DISPLAY}" -screen 0 "${SCREEN}" -nolisten tcp &
XVFB_PID=$!

# Wait for the display to accept connections rather than sleeping a guess -
# Chromium started against a half-open display fails in ways that read as
# application errors.
for _ in $(seq 1 50); do
  if xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then break; fi
  sleep 0.2
done
xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 || {
  echo "Xvfb never came up on ${DISPLAY}" >&2
  exit 1
}

# exec so node becomes PID 1's child properly and receives SIGTERM directly -
# the sidecar's own shutdown handler flushes queued events on the way out.
trap 'kill "${XVFB_PID}" 2>/dev/null || true' EXIT
exec node dist/index.js
