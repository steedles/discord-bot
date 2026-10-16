#!/usr/bin/env bash
# Brings up a throwaway desktop containing one browser, pointed at Fomo, so a
# human can log in and leave a session behind in the mounted profile.
set -euo pipefail

: "${VNC_PASSWORD:?VNC_PASSWORD must be set - refusing to serve an unauthenticated browser holding a live Google session}"

if [[ ${#VNC_PASSWORD} -lt 8 ]]; then
  echo "VNC_PASSWORD must be at least 8 characters" >&2
  exit 1
fi

echo "==> starting Xvfb on ${DISPLAY} (${SCREEN})"
Xvfb "${DISPLAY}" -screen 0 "${SCREEN}" -nolisten tcp &
for _ in $(seq 1 50); do
  xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 && break
  sleep 0.2
done

echo "==> starting window manager"
fluxbox >/dev/null 2>&1 &

# x11vnc's own password file. This is the second lock: Cloudflare Access decides
# who reaches the page at all, this decides who can drive the browser once there.
# Two independent locks, because what is behind them is a logged-in Google account.
mkdir -p /tmp/.vnc
x11vnc -storepasswd "${VNC_PASSWORD}" /tmp/.vnc/passwd >/dev/null 2>&1

echo "==> starting x11vnc"
# -localhost so the VNC port itself is never reachable from the compose network;
# only websockify, in this same container, can connect to it.
x11vnc -display "${DISPLAY}" -rfbauth /tmp/.vnc/passwd -localhost -forever -shared -noxdamage -quiet &

echo "==> starting noVNC on :6080"
websockify --web=/usr/share/novnc 6080 localhost:5900 &

mkdir -p "${PROFILE_DIR}"

# fluxbox pops an xmessage complaining it has no wallpaper setter. It is
# harmless but it sits on top of the browser, in the way of the login.
( sleep 3; pkill -f "xmessage" 2>/dev/null || true ) &

CHROME="$(ls -d /ms-playwright/chromium-*/chrome-linux/chrome 2>/dev/null | head -1)"
[[ -x "$CHROME" ]] || { echo "no chromium found under /ms-playwright" >&2; exit 1; }

echo "==> launching ${CHROME} against ${PROFILE_DIR}"
echo "    open the noVNC page, log into Fomo, confirm the feed loads, then stop this container"

# Supervised in a loop, in the FOREGROUND, and deliberately outside `set -e`.
#
# The previous version backgrounded Chromium and ended on `wait -n`. Two things
# went wrong with that: `wait -n` returns the exit status of whichever child
# died, and under `set -e` a non-zero status aborts the script instantly - so
# closing the browser window killed PID 1, and the whole container with it,
# before the "stay up" line below could ever run. That is exactly what happened
# mid-login.
#
# Now a closed or crashed window simply reopens. The desktop, the VNC server and
# the session outlive it, because none of them are this process.
set +e
while true; do
  # Chromium locks a profile by writing SingletonLock as a symlink naming the
  # HOSTNAME that holds it. A container gets a new hostname every time it is
  # recreated, so the lock left by the previous run always looks like it belongs
  # to someone else, and Chromium exits rc=21 rather than starting - forever,
  # once a supervisor is retrying it. Forty-four times, in the run that found it.
  #
  # Safe to clear here because this container is the only thing that ever opens
  # this profile: the sidecar must be stopped while it runs (see README.md), and
  # nothing else mounts the volume.
  rm -f "${PROFILE_DIR}/SingletonLock" \
        "${PROFILE_DIR}/SingletonCookie" \
        "${PROFILE_DIR}/SingletonSocket"

  "$CHROME" \
    --user-data-dir="${PROFILE_DIR}" \
    --no-sandbox \
    --disable-dev-shm-usage \
    --no-first-run \
    --no-default-browser-check \
    --window-position=0,0 \
    --window-size=1280,880 \
    --remote-debugging-port=9222 \
    --remote-debugging-address=127.0.0.1 \
    "${START_URL}"
  echo "==> chromium exited (rc=$?); reopening in 3s - close the CONTAINER when you are done, not the window"
  sleep 3
done
