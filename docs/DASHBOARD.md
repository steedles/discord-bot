# Dashboard

A web UI for turning features on and off per channel and tuning their settings.
It runs inside the bot process — one deployment, one database, no separate app.

Two ways in:

- **Discord OAuth2** — you see exactly the servers where you hold **Manage
  Server** *and* the bot is present.
- **Login + password** — for people who need to tune the bot without holding
  Manage Server on the guild it sits in. The login is whatever the account is
  named, an email or a bare username. These accounts reach **every** server the
  bot is in, so treat one as full admin.

---

## Where it runs

| | |
|---|---|
| Production | <https://steedlescrypto.dohbelisk.com> (homelab, Cloudflare tunnel) |
| Development | <http://localhost:4300> |
| Preview (no Discord app needed) | `pnpm dashboard:preview` |

The production instance is reachable only through the Cloudflare tunnel — the
container publishes no host port, so nothing is exposed on the LAN.

It also serves the app's legal pages at `/privacy` and `/terms`, which are the
URLs Discord asks for on the application listing.

## Setup

### 1. Discord app

In the [developer portal](https://discord.com/developers/applications), open
your app:

- **OAuth2 → Client Secret** → Reset Secret, copy it.
- **OAuth2 → Redirects** → add your callback URL, **exactly**:

  ```
  <DASHBOARD_URL>/auth/callback
  ```

  For local development that is `http://localhost:4300/auth/callback`.
  Discord matches this string literally — a trailing slash or `http` vs
  `https` mismatch fails the login.

### 2. Environment

```bash
DASHBOARD_ENABLED=true
DASHBOARD_PORT=4300
DASHBOARD_HOST=0.0.0.0
DASHBOARD_URL=http://localhost:4300      # public base URL, no trailing slash
DISCORD_CLIENT_SECRET=<from the portal>
SESSION_SECRET=<openssl rand -base64 32>
SESSION_DAYS=7
```

### 3. Run

```bash
pnpm dev
```

Then open `DASHBOARD_URL` and sign in.

### Login + password accounts

```bash
pnpm dashboard:hash ashrobin 'their-password'
# → ashrobin:scrypt.<salt>.<hash>
```

Paste the printed line into `DASHBOARD_USERS` in `.env` (comma-separate several).
Only the scrypt hash is stored, so a leaked `.env` hands over a work factor
rather than a login, and there is no user table to drift out of step with
anything. There is no registration or reset flow on purpose — rotating a
password means generating a new line.

A wrong login and a wrong password give the same answer in the same time (an
unknown login still runs a derivation), and eight failures from one client locks
that client out for fifteen minutes.

### Fails closed by design

If `DISCORD_CLIENT_SECRET`, `SESSION_SECRET` or `DASHBOARD_URL` is missing, the
dashboard **does not start** and logs which are absent. The bot carries on
without it. An unauthenticated panel that can reconfigure a trading server is
worse than no panel, so there is no "skip auth" mode. An empty `DASHBOARD_USERS`
follows the same rule: the password route rejects everything rather than letting
anyone in.

---

## Using it

The page lists every feature. Under each is a row per scope:

- **Server-wide** — command features only. Applies wherever no channel override
  exists. Shown even before it is saved, so the effective default is visible
  rather than implied.
- **#channel** — one row per configured channel.

Each row has a toggle, and a **Settings** expander with the feature's own form.
Edits are held locally until **Save** (an `● unsaved changes` marker appears);
**Discard** reverts. Toggles apply immediately — they are one-click and
trivially reversible.

**Add channel** at the bottom of a card creates a new instance. For a push
feature that is a new destination with its own filters; for a command feature it
is an override of the server-wide setting in that channel.

Channels the bot cannot post in are labelled in the dropdown, so a
misconfiguration is visible before it is saved rather than after nothing shows up.

### The forms are generated

Every control is rendered from `GET /api/features`. There is no per-feature code
in the frontend — adding a setting to a feature makes it appear here on the next
reload. See [FEATURES.md](FEATURES.md).

---

## Security

| Concern | Handling |
|---|---|
| Who can sign in | Any Discord account, seeing only guilds where they have Manage Server and the bot is present; plus any `DASHBOARD_USERS` account, which reaches every guild the bot is in |
| Password storage | scrypt with a per-account random salt; the plaintext is never written anywhere |
| Password guessing | Same reply for unknown email and wrong password, derived in constant time; 8 failures per client per 15 minutes |
| Session storage | Random 32-byte id in Mongo; the cookie holds only the id plus an HMAC signature |
| Cookie | `httpOnly`, `sameSite=lax`, `Secure` when `DASHBOARD_URL` is `https://` |
| Signature check | Constant-time compare, so it cannot be brute-forced by timing |
| CSRF on login | `state` parameter, set as a short-lived cookie and verified on callback |
| Expiry | Checked on every request *and* reaped by a Mongo TTL index |
| Guild authorisation | Re-checked per request against the session's guild list, never trusted from the request body |
| Settings payloads | Validated against the feature schema; unknown keys dropped, invalid values rejected with 400 |

Permissions are captured at login. If someone loses Manage Server, their session
keeps that access until it expires — sign them out by deleting their row from
the `sessions` collection, or shorten `SESSION_DAYS`.

### Exposing it

The dashboard binds to `0.0.0.0` so Docker can publish it, which on the homelab
means it is reachable by anything on the LAN. Sign-in still protects it. To
reach it from outside the house, put it behind a Cloudflare tunnel or Tailscale
rather than forwarding a port, and set `DASHBOARD_URL` to the public
`https://` hostname (which also enables the `Secure` cookie flag).

---

## API reference

All routes are same-origin and cookie-authenticated. Guild-scoped routes return
`401` without a session and `403` without Manage Server on that guild.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/auth/login` | Starts the OAuth redirect |
| `GET` | `/auth/callback` | OAuth return; sets the session cookie |
| `POST` | `/auth/password` | Login + password sign-in; sets the session cookie |
| `POST` | `/auth/logout` | Destroys the session |
| `GET` | `/api/me` | `{ authenticated, user, guilds[] }` |
| `GET` | `/api/features` | Feature descriptors — the settings schema |
| `GET` | `/api/guilds/:id/channels` | Postable channels, each with a `sendable` flag |
| `GET` | `/api/guilds/:id/roles` | Mentionable roles, each with a `pingable` flag. Fills the "Roles to ping" picker |
| `GET` | `/api/guilds/:id/instances` | Stored configuration rows |
| `PUT` | `/api/guilds/:id/instances` | Create or update a row |
| `PATCH` | `/api/guilds/:id/instances/:instanceId` | `{ enabled }` only |
| `DELETE` | `/api/guilds/:id/instances/:instanceId` | Remove a row |
| `GET` | `/api/guilds/:id/stats` | Alert and launch counters |
| `GET` | `/api/health` | Liveness; no auth required |
| `GET` | `/fomo` | The Fomo feed page (see below) |
| `GET` | `/api/fomo/alerts` | Kept alerts, newest first. `kind`, `trader`, `ticker`, `limit` |
| `GET` | `/api/fomo/trades` | Trades taken on alerts, plus per-mode totals |
| `GET` | `/api/fomo/stream` | SSE. Live alerts and trades as they land |
| `GET` | `/api/fomo/health` | Sidecar feed state; no auth required |
| `POST` | `/api/fomo/events` | Sidecar ingest. **Shared secret**, not a session |
| `POST` | `/api/fomo/trades` | Report a trade taken on an alert. **Shared secret** |

### `PUT /api/guilds/:id/instances`

```jsonc
{
  "featureId": "launch-scanner",
  "channelId": "123456789012345678",   // null = server-wide (command features only)
  "enabled": true,
  "label": "Blue chips only",          // optional, free text
  "settings": { "minLiquidityUsd": 250000, "maxRiskScore": 15 }
}
```

Upserts on `(guildId, featureId, channelId)`. Omitted settings keep their stored
value. Returns `400` with an `errors[]` array if validation fails, and writes
nothing.

---

## The Fomo feed page

`/fomo` shows what the `fomo-sidecar` is delivering - buys, sells and theses -
as it arrives, and what has been traded on the back of it.

**Why it stores anything at all.** `fomo_events` already existed and looks like
a history, but it is a dedup ledger: six fields, a seven-day TTL, and no USD
amount, market cap or thesis text. The normaliser was building a rich event,
posting it to Discord and dropping it. `fomo_alerts` keeps that event -
ninety days, every parsed field - and `FomoSeenEvent` stays exactly what it
was. Two collections because they answer two questions: "have I posted this"
and "what happened last week".

**`raw` is kept only for `UNKNOWN`.** On the homelab `/` is a 5400rpm disk
already at the limit of its write IOPS, and a full payload per event buys
nothing for a kind we parsed cleanly. An UNKNOWN means Fomo changed something,
which is the one case worth the bytes.

**Live is SSE, not a websocket.** The traffic is one-directional and rare - a
handful of events an hour against the ~2000 frames a minute the sidecar filters
out - and `EventSource` reconnects on its own, which a raw websocket does not.
The page re-runs its backfill on every reconnect, so a drop leaves no hole.
`X-Accel-Buffering: no` is not optional: the Cloudflare tunnel this bot sits
behind buffers a proxied response by default, which turns a live stream into
one that arrives all at once when it closes.

**The subscriber cap is a leak guard.** Every subscriber is an open response
holding a socket, and a page reconnecting in a loop - what a broken deploy looks
like - would accumulate them until the process runs out of handles. The 51st
connection is refused visibly and the page says "too many tabs", because
refusing is a failure somebody can see and leaking is not.

**Everything on the page is built with `textContent`, never `innerHTML`.** A
thesis is arbitrary text written by a stranger on a site we do not control, and
it arrives unescaped. Rendering it as markup would be stored XSS with extra
steps.

**Trades are grouped by execution mode and never summed across it.**
`fresh-start` runs `dry_run`, `paper` and `live`, and a single P&L figure
that adds a paper fill to a live one is exactly the kind of number that gets
believed. The `mode` column exists so the dashboard can refuse to add them.

### Nothing writes a trade yet

`POST /api/fomo/trades` exists to be called rather than because something is
calling it. T6 (`fresh-start`'s Fomo frontrunner) detects and records but has
no executor - `services/fomo-frontrun/src/main.ts` emits "entry signal, no
executor wired" - and this bot only posts to Discord. The trades panel is
therefore empty by construction, and says so on the page rather than looking
broken.

The contract, for whatever executes first:

```jsonc
{
  "tradeRef": "t6-0001",        // yours, unique. A retry with the same ref updates
  "eventId": "<FomoAlert.eventId>",
  "source": "fomo-frontrun",
  "side": "BUY",
  "mode": "paper",              // dry_run | paper | live
  "status": "intent",           // intent | open | closed | failed
  "ticker": "TENDIES",
  "usdAmount": 50,
  "pnlUsd": 12.4                // on close
}
```

Upserts on `tradeRef`, so the natural lifecycle is three reports - intent,
fill, close - against one row.

---

## Frontend notes

`src/web/public/` — three files, no bundler and no build step beyond copying
them into `dist/` (`scripts/copy-public.mjs`, wired into `pnpm build`).

| File | Role |
|---|---|
| `index.html` | Shell |
| `styles.css` | All styling. Design tokens are the `:root` custom properties |
| `app.js` | State, rendering, API calls |
| `fomo.html` | The Fomo feed page |
| `fomo.css` | Layout for that page only. Redefines no token, so a palette change carries |
| `fomo.js` | Backfill, SSE, filtering |

A bundler was deliberately not added. The dashboard is a handful of screens
whose forms are data-driven, so a toolchain would add build complexity and a
second dependency tree to a bot repo for no gain.

Fonts come from Google Fonts (IBM Plex Mono/Sans) with a full system fallback
stack, so the UI stays legible if that fetch fails on an offline LAN.
