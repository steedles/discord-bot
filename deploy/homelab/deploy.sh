#!/usr/bin/env bash
#
# Deploys the bot + dashboard to the homelab, published on a Cloudflare named
# tunnel. Runs FROM the Mac and is idempotent - re-run it to redeploy. The
# MongoDB volume persists across deploys.
#
#   cp deploy/homelab/.env.example deploy/homelab/.env.homelab   # fill it in
#   ./deploy/homelab/deploy.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
ENV_FILE="$HERE/.env.homelab"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  echo "Copy deploy/homelab/.env.example to .env.homelab and fill it in." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${HOMELAB_SSH:?HOMELAB_SSH not set in .env.homelab}"
: "${REMOTE_DIR:?REMOTE_DIR not set in .env.homelab}"
: "${SUBDOMAIN:?SUBDOMAIN not set in .env.homelab}"
: "${TUNNEL_NAME:?TUNNEL_NAME not set in .env.homelab}"
: "${DISCORD_TOKEN:?DISCORD_TOKEN not set in .env.homelab}"
: "${DISCORD_CLIENT_ID:?DISCORD_CLIENT_ID not set in .env.homelab}"
: "${DISCORD_CLIENT_SECRET:?DISCORD_CLIENT_SECRET not set in .env.homelab}"
: "${SESSION_SECRET:?SESSION_SECRET not set in .env.homelab}"
DASHBOARD_PORT="${DASHBOARD_PORT:-4300}"

# --- remote calls, all guarded ---------------------------------
#
# Every ssh here used to be bare. A dropped LAN link or a homelab that stops
# answering mid-command leaves ssh waiting forever, and because the deploy holds
# the terminal it looks like a slow build rather than a hang - two runs sat like
# that for hours after their work had already finished.
#
# Keepalives turn a dead connection into an error, and `timeout` bounds the rest.
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4)

# `timeout` is coreutils, which macOS does not ship. Where it is missing the
# guards become no-ops rather than errors - the keepalives above still catch a
# dead link, and a deploy that refuses to start because a helper is absent would
# be worse than the hang this is guarding against.
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_BIN=timeout
elif command -v gtimeout >/dev/null 2>&1; then
  TIMEOUT_BIN=gtimeout
else
  TIMEOUT_BIN=""
  echo "note: coreutils 'timeout' not found - remote calls run unguarded" >&2
fi

guard() {
  local seconds="$1"
  shift
  if [ -n "$TIMEOUT_BIN" ]; then "$TIMEOUT_BIN" "$seconds" "$@"; else "$@"; fi
}

# Short remote command: config, status, logs.
remote() {
  guard 120 ssh "${SSH_OPTS[@]}" "$HOMELAB_SSH" "$@"
}

# The build. Minutes is normal; an hour is not.
remote_build() {
  guard 3600 ssh "${SSH_OPTS[@]}" "$HOMELAB_SSH" "$@"
}

echo "==> Checking SSH to $HOMELAB_SSH"
if ! remote 'echo ok' >/dev/null 2>&1; then
  echo "Cannot reach $HOMELAB_SSH." >&2
  echo "The homelab IP is DHCP-assigned and has moved before. Re-find it with:" >&2
  echo '  for i in $(seq 100 130); do nc -z -G 1 192.168.68.$i 22 && echo "$i open"; done' >&2
  exit 1
fi

# --- 1. tunnel ------------------------------------------------
if ! cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$TUNNEL_NAME"; then
  echo "==> Creating cloudflared tunnel '$TUNNEL_NAME'"
  cloudflared tunnel create "$TUNNEL_NAME"
fi
TUNNEL_ID="$(cloudflared tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" '$2==n{print $1; exit}')"
[ -n "$TUNNEL_ID" ] || { echo "ERROR: could not resolve tunnel id for '$TUNNEL_NAME'." >&2; exit 1; }
CRED_FILE="$HOME/.cloudflared/${TUNNEL_ID}.json"
[ -f "$CRED_FILE" ] || { echo "ERROR: tunnel credentials $CRED_FILE missing." >&2; exit 1; }

echo "==> Routing DNS $SUBDOMAIN -> tunnel $TUNNEL_ID"
cloudflared tunnel route dns "$TUNNEL_NAME" "$SUBDOMAIN" 2>&1 | grep -viE 'already (exists|configured)' || true

# --- 2. render the cloudflared ingress config -----------------
RENDERED_CFG="$(mktemp)"
trap 'rm -f "$RENDERED_CFG"' EXIT
# Defaults to fomo-login.<zone> derived from SUBDOMAIN, so an existing
# .env.homelab needs no new variable for the route to render correctly.
FOMO_LOGIN_SUBDOMAIN="${FOMO_LOGIN_SUBDOMAIN:-fomo-login.${SUBDOMAIN#*.}}"

sed -e "s/__TUNNEL_ID__/$TUNNEL_ID/g" \
    -e "s/__SUBDOMAIN__/$SUBDOMAIN/g" \
    -e "s/__FOMO_LOGIN_SUBDOMAIN__/$FOMO_LOGIN_SUBDOMAIN/g" \
    -e "s/__DASHBOARD_PORT__/$DASHBOARD_PORT/g" \
    "$HERE/cloudflared/config.yml.template" > "$RENDERED_CFG"

echo "==> Routing DNS $FOMO_LOGIN_SUBDOMAIN -> tunnel $TUNNEL_ID"
cloudflared tunnel route dns "$TUNNEL_NAME" "$FOMO_LOGIN_SUBDOMAIN" 2>&1 | grep -viE 'already (exists|configured)' || true

# --- 3. rsync the repo to the homelab -------------------------
echo "==> Syncing repo to $REMOTE_DIR"
remote "mkdir -p '$REMOTE_DIR' '$REMOTE_DIR/deploy/homelab/cloudflared'"
guard 600 rsync -az --delete --timeout=60 -e "ssh ${SSH_OPTS[*]}" \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.env' \
  --exclude '.env.*' \
  --exclude 'discord-creds.txt' \
  --exclude 'deploy/homelab/cloudflared/config.yml' \
  --exclude 'deploy/homelab/cloudflared/*.json' \
  "$REPO_ROOT/" "$HOMELAB_SSH:$REMOTE_DIR/"

# --- 4. ship secrets + tunnel creds (out of band) -------------
echo "==> Shipping env + tunnel credentials"
# cloudflared writes creds 0400, so a prior deploy's file blocks scp overwrite - clear first.
remote "rm -f '$REMOTE_DIR/deploy/homelab/cloudflared/'*.json '$REMOTE_DIR/deploy/homelab/cloudflared/config.yml'" 2>/dev/null || true
guard 120 scp -q "${SSH_OPTS[@]}" "$ENV_FILE"     "$HOMELAB_SSH:$REMOTE_DIR/deploy/homelab/.env.homelab"
guard 120 scp -q "${SSH_OPTS[@]}" "$RENDERED_CFG" "$HOMELAB_SSH:$REMOTE_DIR/deploy/homelab/cloudflared/config.yml"
guard 120 scp -q "${SSH_OPTS[@]}" "$CRED_FILE"    "$HOMELAB_SSH:$REMOTE_DIR/deploy/homelab/cloudflared/${TUNNEL_ID}.json"
remote "chmod 600 '$REMOTE_DIR/deploy/homelab/.env.homelab' '$REMOTE_DIR/deploy/homelab/cloudflared/config.yml' '$REMOTE_DIR/deploy/homelab/cloudflared/${TUNNEL_ID}.json'"

# --- 5. build + up --------------------------------------------
echo "==> Building and starting containers (this takes a few minutes on first run)"
remote_build "cd '$REMOTE_DIR/deploy/homelab' && \
  docker compose --env-file ./.env.homelab up -d --build --remove-orphans"

# --- 6. health check ------------------------------------------
# Asks the container how it is rather than grepping for a line it printed at
# startup: a busy bot writes hundreds of lines a minute, so "discord ready"
# scrolls out of any fixed tail and a perfectly healthy deploy reports failure.
# The compose healthcheck already answers this question properly.
echo "==> Waiting for the bot to report healthy"
CONNECTED=0
for _ in $(seq 1 45); do
  STATE="$(remote "docker inspect --format '{{.State.Health.Status}}' discord-bot-bot-1" 2>/dev/null || true)"
  if [ "${STATE//[$'\r\n ']/}" = "healthy" ]; then
    CONNECTED=1
    break
  fi
  sleep 4
done

if [ "$CONNECTED" -ne 1 ]; then
  echo "Bot did not become healthy in time. Recent logs:" >&2
  remote "cd '$REMOTE_DIR/deploy/homelab' && docker compose --env-file ./.env.homelab logs --tail 80 bot" >&2 || true
  exit 1
fi

# cloudflared is restarted by the compose step and a fresh tunnel can take a
# couple of minutes to be routable, so this waits five rather than two.
echo "==> Waiting for https://$SUBDOMAIN to answer"
for _ in $(seq 1 60); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$SUBDOMAIN/api/health" || true)"
  if [ "$CODE" = "200" ]; then
    echo
    echo "  Deployed."
    echo "    Dashboard   https://$SUBDOMAIN"
    echo "    Privacy     https://$SUBDOMAIN/privacy"
    echo "    Terms       https://$SUBDOMAIN/terms"
    echo
    echo "  Discord app -> OAuth2 -> Redirects must contain, exactly:"
    echo "    https://$SUBDOMAIN/auth/callback"
    echo
    # Cosmetic: a hung status call must not strand a finished deploy.
    remote "cd '$REMOTE_DIR/deploy/homelab' && docker compose --env-file ./.env.homelab ps" || true
    exit 0
  fi
  sleep 5
done

echo "Tunnel did not serve https://$SUBDOMAIN (last status: ${CODE:-none})." >&2
echo "DNS can take a minute to propagate. cloudflared logs:" >&2
remote "cd '$REMOTE_DIR/deploy/homelab' && docker compose --env-file ./.env.homelab logs --tail 40 cloudflared" >&2 || true
exit 1
