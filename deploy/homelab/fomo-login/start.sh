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

echo "==> launching Chromium against ${PROFILE_DIR}"
echo "    open the noVNC page, log into Fomo, confirm the feed loads, then stop this container"
# The same profile directory the sidecar will use. Chrome locks it, which is why
# the sidecar must be stopped while this runs - see README.md.
/ms-playwright/chromium-*/chrome-linux/chrome \
  --user-data-dir="${PROFILE_DIR}" \
  --no-sandbox \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  --window-position=0,0 \
  --window-size=1280,880 \
  "${START_URL}" &

# If the browser is closed the container has no further purpose, but the desktop
# should outlive it so a mis-click does not end the session before login.
wait -n
echo "==> a process exited; container staying up so the desktop survives a closed window"
sleep infinity
