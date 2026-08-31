# Fomo login desktop

A browser on a screen, for a server that has no screen.

The homelab is headless, and signing into Fomo means clicking through Google
OAuth in a visible browser. This container supplies a throwaway desktop — Xvfb
for a framebuffer, x11vnc to serve it, noVNC to put it in a web page — with one
Chromium pointed at Fomo, writing into the same profile volume the sidecar reads.

It is **not** part of the running stack. It sits in the `login` compose profile,
so ordinary `docker compose up -d` never starts it, and `https://fomo-login.…`
answers 502 the rest of the time. That is the intended steady state.

---

## ⚠ Read this before exposing it

While this container runs, that hostname serves **a browser logged into a Google
account and a Fomo account, running inside the homelab network**. Anyone who can
reach it and get past the VNC password can read the email, open the trading
account, and browse the LAN from inside it.

That is a far bigger blast radius than the Fomo account the burner was protecting.

Two independent locks, and you want both:

1. **Cloudflare Access on the hostname** — decides who reaches the origin at all.
   Unauthenticated requests never touch the container. This is the important one.
2. **`FOMO_VNC_PASSWORD`** — decides who can drive the browser once there. The
   container refuses to start without it, and refuses anything under 8
   characters. On its own it is a brute-force target on a public URL, which is
   why it is the second lock and not the first.

A third, free: **keep it stopped.** An hour a month of exposure is a different
risk from permanent exposure.

### Setting up Cloudflare Access

In the Cloudflare Zero Trust dashboard:

1. **Access → Applications → Add an application → Self-hosted**
2. Application domain: `fomo-login.dohbelisk.com`
3. Session duration: short — **1 hour** is plenty for a login
4. **Add a policy**: Action `Allow`, rule `Emails` → your address. One rule, one
   address; do not use "Everyone" or a whole-domain match.
5. Save.

Verify it worked before trusting it: open the hostname in a private window. You
should get Cloudflare's login page, **not** a VNC prompt. If you see VNC, Access
is not in front of it — stop the container and fix that first.

---

## Use

```bash
cd ~/discord-bot/deploy/homelab
P="docker compose -p discord-bot --env-file ./.env.homelab"

$P stop fomo-sidecar                      # Chrome locks the profile - only one holder
$P --profile login up -d --build fomo-login

#   → https://fomo-login.dohbelisk.com
#   → Cloudflare Access, then the VNC password
#   → log into Fomo, confirm the feed loads

$P --profile login down fomo-login        # stop it the moment you are done
$P start fomo-sidecar
$P logs -f --tail 50 fomo-sidecar         # expect "websocket open"
```

**The stop/start is not optional.** Chrome locks the profile directory, so the
sidecar and this container can never hold it at the same time. Skipping it gives
a sidecar that cannot open its profile and restarts forever.

## Config

| Variable | |
|---|---|
| `FOMO_VNC_PASSWORD` | required, min 8 chars. In `.env.homelab`, never committed |
| `FOMO_APP_URL` | page to open; must be an app route, not `fomo.family/` |
| `FOMO_LOGIN_SUBDOMAIN` | defaults to `fomo-login.<your zone>` |

## When you will need this

Whenever the Fomo session expires. How often that is, nobody yet knows — it is
the open question the spike was measuring, and it decides whether this is a rare
chore or a daily one. Privy's JWT lasts ~30 minutes and refreshes while the
browser is alive, so the sidecar holding a session open is what keeps it valid;
this container is only for when that chain has been broken.

The sidecar reports `AUTH_REQUIRED` when it can no longer find a session, and the
bot sends that to Telegram. That message is your cue to come here.

## Notes

- No `ports:` in the compose service, deliberately. The only route in is the
  tunnel, because the tunnel is the only place access control is enforced.
- `x11vnc` binds `-localhost`, so the VNC port is not reachable from the compose
  network either; only websockify, inside this same container, can connect.
- The profile volume is a credential. Do not copy it off the host, do not bake it
  into an image, and delete it if the account is retired.
