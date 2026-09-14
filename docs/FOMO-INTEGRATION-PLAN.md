# Fomo.family activity monitoring — implementation plan

Plan for adding real-time BUY / SELL / THESIS monitoring of followed Fomo traders.

Written against protocol captured from live traffic on 2026-08-31, not against
assumptions. The capture and full field schemas are in the spike's `PROTOCOL.md`;
this document is what we build from it and **supersedes the original
`FOMO_FAMILY_MONITORING_SERVICE.md` wherever they disagree**. Every disagreement is
listed under [Deviations](#deviations-from-the-original-spec) with its evidence.

---

## 1. What is already proven

| Question | Answer | How we know |
|---|---|---|
| Real-time buys/sells? | **Yes** | `swap_buy` and `swap_sell` captured live |
| Theses? | **Yes, on the same WebSocket** | `payload.type: "thesis"` on `trading_activity` |
| Feed scope | the authenticated user's follows | `topicId` = own user UUID |
| Thesis ↔ trade link | **Yes**, via `tradeId` | thesis carried the buy's `tradeId` |
| Auth | Privy, localStorage only, no cookies | `cookieNames: []` across every capture |

**Still unknown, and it gates everything: how long a Fomo session survives.**
See [Phase 0](#phase-0--the-gate).

## 2. Architecture

```
┌─────────────────────────┐         ┌──────────────────────────────┐
│  fomo-sidecar           │  HTTP   │  bot (existing container)    │
│  (new container)        │ ──────► │                              │
│                         │  POST   │  Fastify  /api/fomo/events   │
│  Playwright + Chrome    │         │      │                       │
│  ws: trading_activity   │         │      ▼                       │
│  filters noise          │         │  FomoWatchWorker             │
│  posts raw payloads     │         │   normalise → dedupe →       │
└─────────────────────────┘         │   filter → Discord           │
                                    └──────────────────────────────┘
```

### Why a sidecar, not in-process

1. **The bot image is `node:24-alpine`.** Playwright's browsers are not built for musl;
   the official images are Debian. Putting Chrome in the bot means abandoning Alpine and
   taking the image from ~200MB to ~1.8GB, rebuilt on every deploy, for one feature.
2. **Failure isolation is a stated requirement.** "A Playwright crash must not crash the
   bot" is free across a process boundary and awkward inside one.
3. **It matches how `fomofaster-ws` does it** — its sidecar POSTs structured payloads to
   its backend.
4. The bot already runs Fastify for the dashboard, so the receiving end is a new route,
   not a new server.

The sidecar owns everything Fomo-specific about *transport*. It does not normalise, does
not dedupe, and knows nothing about Discord. It forwards raw `trading_activity` payloads
and its own health.

## 3. Files

### New — sidecar (`deploy/homelab/fomo-sidecar/`)

| File | Purpose |
|---|---|
| `Dockerfile` | `mcr.microsoft.com/playwright:v1.49.0-jammy`, non-root |
| `src/index.ts` | launch persistent context → app route → subscribe → forward |
| `src/forward.ts` | POST batches to the bot, retry with backoff, never lose on 5xx |
| `src/health.ts` | state machine, `/healthz` |

### New — bot

| File | Purpose |
|---|---|
| `src/integrations/fomo/types.ts` | raw Fomo payload types + `FomoActivityEvent` |
| `src/integrations/fomo/normalise.ts` | raw → normalised, **the only file that knows Fomo's field names** |
| `src/integrations/fomo/networks.ts` | `networkId` → our `chains.ts` id |
| `src/integrations/fomo/__tests__/` | fixtures from the real capture |
| `src/features/definitions/fomo-watch.ts` | `FeatureDescriptor` |
| `src/workers/fomo-watch.ts` | `FomoWatchWorker` — ingest queue → Discord |
| `src/discord/embeds.ts` (edit) | `fomoTradeEmbed`, `fomoThesisEmbed` |

### Edited

| File | Change |
|---|---|
| `src/web/routes.ts` | `app.post('/api/fomo/events')`, shared-secret auth |
| `src/features/registry.ts` | add `FOMO_WATCH` to `FEATURES` |
| `src/index.ts` | construct + `start()` the worker, `stop()` on shutdown |
| `src/config.ts` | `FOMO_*` zod entries |
| `src/db/models.ts` | `FomoSeenEvent`, `FomoWatchedTrader` |
| `src/db/mongo.ts` | collections + indexes |
| `deploy/homelab/docker-compose.yml` | `fomo-sidecar` service |

### Reused, not rebuilt

- `src/market/fomo.ts` — `fomoUrl()` and its **verified** chain-slug map (`bsc`→`bnb`).
  Alerts link to the Fomo token page through it.
- `src/monitor/detect/dedupe.ts` — cooldown and hourly cap, so a busy trader cannot
  bury a channel.
- `src/discord/mentions.ts` — `pingFor`, matching every other feature.

## 4. Data model

```ts
/** One activity event, already proven unique by Fomo's own id. */
export interface FomoSeenEvent {
  eventId: string      // payload.id  - THE dedup key
  tradeId: string      // payload.tradeId - correlation, NOT unique
  type: 'BUY' | 'SELL' | 'THESIS'
  traderHandle: string
  createdAt: Date      // Fomo's timestamp
  seenAt: Date         // ours; TTL index expires rows after 7 days
}

export interface FomoWatchedTrader {
  userId: string
  handle: string
  enabled: boolean
  monitorBuys: boolean
  monitorSells: boolean
  monitorTheses: boolean
}
```

Indexes: unique on `eventId`; TTL on `seenAt` (7 days). The unique index is the dedup
mechanism — an insert that throws duplicate-key *is* the "already seen" answer, with no
read-then-write race.

`FomoActivityEvent` is the normalised shape the rest of the bot sees. It keeps
`raw: unknown` — Fomo is undocumented and a field we ignore today may matter later.

## 5. Phases

### Phase 0 — the gate

**Do not start Phase 1 until the session-lifetime number is in.**

- `watch.mjs` running; `check.mjs` at +12h, +24h, +72h.
- **≥ 1 week** → build as planned.
- **~24h** → build only if a daily re-login is acceptable; say so out loud first.
- **< 12h** → **stop.** Reconsider entirely; no amount of good code survives this.

### Phase 1 — sidecar to console

Persistent profile, launch, navigate to an app route, subscribe, log `trading_activity`
to stdout. Nothing else.

*Done when:* your next real trade appears in `docker logs fomo-sidecar` within seconds.

Two traps, both already paid for: **the app only boots on an app route** (`/` is a static
marketing page that opens no socket), and `trending_tokens`+`prices` are ~2000 frames/min
of noise that must be dropped at the socket.

### Phase 2 — ingest and normalise

- `POST /api/fomo/events`, `Authorization: Bearer ${FOMO_INGEST_SECRET}`, batched.
- `normalise.ts` maps `swap_buy|swap_sell|thesis` → `BUY|SELL|THESIS`.
- Insert into `fomo_seen_events`; duplicate key → drop silently.
- **Backfill guard:** on boot, discard anything with `createdAt` older than
  `FOMO_MAX_EVENT_AGE_MIN` (default 10). Prevents a restart flooding the channel — the
  same principle `whale-buys` already states: *posting an hour-old event as if it just
  happened is worse than not posting it.*

*Done when:* events persist, restart replays nothing, unit tests pass on real fixtures.

### Phase 3 — Discord

Feature descriptor (`kind: 'push'`, `defaultEnabled: false`) with settings:
`minUsd`, `postBuys`, `postSells`, `postTheses`, plus the standard mention fields.
Worker fetches the channel and sends an embed, exactly as `PriceAlertWorker` does.

**Buys and theses post separately.** They arrive ~53s apart; folding them into one
notification would mean holding every buy for a minute on the chance a thesis follows.
The thesis embed references its trade instead.

Then apply `dedupe.ts`'s cooldown and hourly cap — dedup stops *repeats*, this stops a
*flood*.

*Done when:* a real buy and a real thesis land in a test channel, correctly formatted.

### Phase 4 — watched traders

Config-driven allowlist applied after ingestion, per the spec. Seed from
`GET /v2/users/current/followingIds`.

Document the constraint plainly: **the upstream universe is whoever the Fomo account
follows.** Adding a trader means following them in Fomo's UI, not editing config.

### Phase 5 — health and the silent-breakage alarm

Sidecar state: `DISABLED | STARTING | AUTH_REQUIRED | CONNECTED | DEGRADED | DISCONNECTED`,
reported on the ingest channel and surfaced in `/monitor status`.

**The staleness alarm is the most important thing in this phase.** This is an
undocumented API: when Fomo changes a field or a topic, we get *silence*, not an error.
If no `trading_activity` frame arrives in `FOMO_STALE_MIN` (default 60), post a warning.
A feed that quietly died four hours ago is worse than no feed.

Reconnect with exponential backoff; `AUTH_REQUIRED` must say so loudly and never
retry-loop against a dead session.

### Phase 6 — tests and docs

Fixtures from the real capture (`captures/frames.ndjson`), never invented:
BUY / SELL / THESIS normalisation · unknown `payload.type` → `UNKNOWN`, no throw ·
duplicate `id` suppressed · thesis-and-buy sharing a `tradeId` both survive ·
`minUsd` and watched-trader filtering · restart backfill discard ·
malformed JSON frame ignored · missing optional fields.

Then `docs/FOMO.md`: how it works, why it is unofficial, first login, where the profile
lives, re-authentication, enabling/disabling, and how to repair parsers when Fomo changes.

## 6. Config

```
FOMO_ENABLED              boolish(false)
FOMO_INGEST_SECRET        required when enabled
FOMO_MAX_EVENT_AGE_MIN    10
FOMO_STALE_MIN            60
FOMO_MIN_USD              0
FOMO_WEBHOOK_URL          blank = mirror off. A CREDENTIAL - see below
FOMO_WEBHOOK_NAME         'Fomo Alerts'
```

### The webhook mirror

Reaches a server the bot has **not** been invited to, which is otherwise
impossible: a bot can post only to guilds it belongs to, and no permission can
be granted remotely. A webhook inverts the direction - an admin in the
destination creates it and hands over a URL, and whatever holds that URL can
post without any membership at all.

Follows the same rule as `telegram-alerts.ts` and `signal-intake.ts`: fired
without awaiting, every failure caught and logged, short timeout, no retry. A
dead webhook is a quiet log line, never a missing or delayed Discord post.

It applies the bot-wide `FOMO_MIN_USD` floor and nothing else. Per-channel
settings are deliberately not consulted - they belong to channels in guilds this
bot is in, and the mirror's destination is neither. Theses are always mirrored,
the same call the per-channel filter makes.

Two things that are easy to get wrong, both commented at the call site:

- **The URL is a credential.** Anyone holding it can post to that channel under
  any name and avatar. It lives in `.env.homelab` beside `FOMO_INGEST_SECRET`,
  is never committed, and is never logged - `describeTarget` logs the webhook
  id without its token, so an operator can tell two webhooks apart without the
  logs becoming a way to post.
- **A redirect is a refusal**, not a destination - the same reasoning
  `signal-intake.ts` documents. A 3xx from a webhook URL means the URL is wrong,
  and following it could POST an alert somewhere unintended.

Sidecar-side: `FOMO_PROFILE_PATH`, `FOMO_HEADLESS`, `FOMO_APP_URL`,
`FOMO_RECONNECT_MIN_MS`, `FOMO_RECONNECT_MAX_MS`, `FOMO_BOT_URL`, `FOMO_INGEST_SECRET`.

Browser profile is a **mounted volume**, never baked into the image and never committed.
It holds a live session; treat it as a credential.

## 7. Deviations from the original spec

| Spec said | We do | Why |
|---|---|---|
| REST polling for theses (P1) | **dropped** | theses arrive on the WebSocket |
| Direct WS is a P2 optimisation | **investigation only, not a goal** | Privy JWT expires ~30 min and refreshes via the browser; removing Playwright means reimplementing Privy refresh, not writing a WS client |
| Fingerprint events if no id | **always `payload.id`** | Fomo supplies stable ids; a fingerprint would be strictly worse |
| Fold thesis into the buy notification | **post separately** | they are ~53s apart |
| Provider abstraction | **sidecar + worker + `integrations/fomo/`** | `ProviderRegistry` here means per-chain price data — a different concept |
| Capture token amount, tx hash | **not available** | swap payloads carry `usdAmount` and `price` only |
| — | **added: rate limiting** | spec had dedup but no flood control |
| — | **added: staleness alarm** | spec had no detection for silent breakage |
| — | **added: backfill guard** | spec required the outcome, specified no mechanism |

## 8. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Session too short | **blocks everything** | Phase 0 gate, before any code |
| Silent protocol change | high | staleness alarm; `UNKNOWN` events logged with raw payload |
| ToS — account suspension | high | disposable account; conservative footprint; see below |
| Chrome instability | medium | own container, `restart: unless-stopped`, health state |
| `networkId` 143 unidentified | low | **do not guess it**; unmapped ids → `UNKNOWN` chain, event still posts |
| Profile leak | high | volume-mounted, gitignored, never in an image |

**Terms of service.** Fomo's ToS explicitly prohibits automated access, scraping and data
extraction — naming transaction data — and prohibits reverse-engineering. This is not
ambiguous. The realistic consequence is account suspension, which is why this runs on a
disposable account and not the trading one. Written permission is the only clean route;
the ToS has a carve-out for it.

## 9. Definition of done

- bot starts normally with `FOMO_ENABLED` true **and** false
- sidecar down / Fomo down / auth expired → bot unaffected
- a followed trader's BUY, SELL and THESIS each reach Discord, correctly formatted
- duplicates suppressed; restart replays nothing
- watched-trader and `minUsd` filtering work
- events flow through the feature system, not around it
- session data never enters git or an image
- reconnect works; `AUTH_REQUIRED` is loud
- staleness alarm fires when the feed goes quiet
- `pnpm typecheck && pnpm test` clean
- protocol and setup documented
