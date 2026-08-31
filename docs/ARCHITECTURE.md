# Architecture

One Node process runs three things against one MongoDB: the Discord gateway
client, two background workers, and the dashboard HTTP server.

```
                    ┌──────────────────────────────────────────┐
                    │              bot process                 │
                    │                                          │
  Discord  ◄────────┤  discord/    slash commands, embeds      │
  gateway           │      │                                   │
                    │      ▼                                   │
                    │  features/   registry + settings schema   │
                    │      ▲                                   │
                    │      │                                   │
  Browser  ◄────────┤  web/        Fastify + OAuth + SPA       │
                    │      │                                   │
                    │      ▼                                   │
                    │  db/         feature instances, alerts    │
                    │      ▲                                   │
                    │      │                                   │
                    │  workers/    alerts, scanner, tracker     │
                    │      │                                   │
                    │      ▼                                   │
                    │  market/  risk/   outbound data providers │
                    └──────┬───────────────────────────────────┘
                           │
  DexScreener · GeckoTerminal · RugCheck · honeypot.is · GoPlus · PumpPortal (ws)
```

`features/` is the hub. Commands, workers and the dashboard all ask it the same
question — *is this on here, and with what settings* — and none of them knows
anything feature-specific.

---

## Directory map

| Path | Responsibility |
|---|---|
| `src/config.ts` | Zod-validated env. The only place `process.env` is read |
| `src/features/` | Feature descriptors, settings schema, validation |
| `src/db/` | Mongo client, models, feature instance CRUD + resolution, migration |
| `src/discord/` | Client, slash commands, embeds, the channel `gate()` |
| `src/market/` | DexScreener, GeckoTerminal candles, token resolution, pinned tickers, pump.fun websocket, the shared rate limiter |
| `src/monitor/` | Volume monitor: chain providers, pure detectors, watchlist, history, its worker |
| `src/risk/` | RugCheck / honeypot.is / GoPlus behind one `assessToken()`, plus holder distribution |
| `src/analysis/` | Turns numbers into sentences, and candles into signals. Pure, no Discord types |
| `src/integrations/` | Outbound hand-offs to services outside the bot. Off unless configured |
| `src/workers/` | Price alert loop, launch scanner loop, coin tracker loop, Token Brief listener |
| `src/web/` | Fastify server, OAuth, REST API, static dashboard |
| `src/scripts/` | Command deployment, provider smoke test, brief and TA previews |

---

## Configuration model

See [FEATURES.md](FEATURES.md) for the full picture. In short: configuration is
rows of `(guildId, featureId, channelId) → { enabled, settings }`, and
resolution is *channel row → server-wide row → built-in defaults*, with the
channel row replacing rather than merging.

Everything that behaves differently per channel goes through
`resolveFeature()`. There is no other source of per-guild configuration.

---

## Collections

| Collection | Holds | Lifecycle |
|---|---|---|
| `feature_instances` | Per-channel feature config | Permanent; unique on `(guildId, featureId, channelId)` |
| `alerts` | User price alerts | Until fired (non-repeating) or deleted |
| `coin_trackers` | Coins being watched for a trend turn | Until removed, or retired after 20 failed chart reads |
| `sessions` | Dashboard logins | TTL on `expiresAt` |
| `seen_tokens` | Scanner dedupe, per channel | TTL 14 days |
| `pending_mints` | pump.fun mints awaiting a DEX pool | TTL 48 hours |
| `watched_tokens` | Volume monitor watchlist | Manual entries permanent; discovered ones TTL on `expiresAt` |
| `volume_snapshots` | Per-poll readings, the monitor's baselines | TTL 48 hours |
| `monitor_alerts` | Monitor cooldown and hourly-cap history | TTL 7 days |
| `guilds` | *Legacy* pre-feature scanner config | Read once by the migration; never written |

The TTL collections are self-managing: `seen_tokens` forgets a token after 14
days so a genuine relaunch can be posted again, a pump.fun mint that has not
reached a DEX within 48 hours never will, and `volume_snapshots` keeps twice the
longest baseline window and no more.

`watched_tokens` uses a TTL index on a field only *some* documents carry — Mongo
ignores documents without it — so auto-discovered tokens expire after 24 hours
while manual entries persist, with no sweeper job to write.

---

## Request and event paths

### A slash command

```
interaction → client.ts → commandMap → command.execute()
                                          │
                                          ├─ gate(interaction, featureId)
                                          │    resolveFeature() → off? reply and stop
                                          │
                                          ├─ resolveToken()        market/
                                          ├─ checkToken()          risk/
                                          └─ editReply(embed)
```

`gate()` is the single place that answers "is this feature on in this channel".
Every gated command calls it, so the behaviour cannot drift between commands.

### The launch scanner

```
every LAUNCH_POLL_SECONDS
  └─ listEnabledPushInstances('launch-scanner')   → one Destination per channel
       ├─ DexScreener token profiles ─┐
       ├─ pump.fun pending mints ─────┤ (only sources some channel asked for)
       │                              ▼
       │                    cheap filters, per destination
       │                    (chain, liquidity, volume, age, socials)
       │                              │
       │                    any destination still interested?
       │                              ▼
       └──────────────────► checkToken()  ← paid for once, cached 10 min
                                          │
                            per destination: risk score vs its own maxRiskScore
                                          │
                              any destination still qualifies?
                                          ├─────────────────────────────┐
                                          ▼                             ▼
                            void sendLaunchSignal()          insert seen_tokens (unique index = dedupe)
                            src/integrations/                          │
                            (never awaited, off unless                 ▼
                             configured - see below)          pingFor() → post embed
```

The ordering matters: cheap local filters run before the risk lookup, and the
risk lookup is shared across every destination that wants the token. A token
rejected by all channels on liquidity costs zero API calls.

The intake signal and the Discord posts fan out from the same point rather than
one waiting on the other - `src/integrations/signal-intake.ts` describes why.

### Token Brief

```
MessageCreate (any channel)
  └─ ignore self  →  resolveFeature('token-brief', guild, channel)
       ├─ source allowed? (bots / members, bot allowlist)
       ├─ anywhere to send? (sendable channel, or DM recipients)  ← else stop
       ├─ extractFromMessage()   sweep content + every embed part
       │     links-with-chain first, then bare addresses
       ├─ per ref: token lookup, falling back to pair lookup
       ├─ chain allowed? pool big enough? cooldown clear?
       ├─ assessToken() ‖ getHolderProfile()   different vendors, so parallel
       ├─ buildBrief()   pure: numbers in, sentences out
       └─ reply in channel, or DM each recipient
```

Only the address comes from the message; every number is re-derived from our own
providers. The "anywhere to send?" check runs before any network call - a
feature with nobody listening should cost nothing.

Ignoring our own messages is not optional: the brief quotes the contract
address, so a bot that read its own replies would brief itself forever.

Cooldown is in-memory and per channel+token: a restart simply forgets it, which
is fine because the trigger is a new message anyway.

### A coin tracker

```
every TRACK_POLL_SECONDS
  └─ active trackers, least-recently-checked first   ← fair under a tight budget
       ├─ group by pool          one candle fetch serves every subscriber
       ├─ getMinuteCandles()     closed 1m bars, GeckoTerminal
       │     rate limited? leave the row stale and retry next tick
       ├─ per tracker: resolveFeature() at signal time
       ├─ detectTurn()           EMA 9/21 · MACD · RSI, majority agreement
       ├─ news? opposite direction, past cooldown, moved enough
       └─ post to the channel (or DM), mentioning the owner
```

Two caps exist and both are logged rather than silent: 15 pools per tick, and a
tracker retired after 20 consecutive empty chart reads. A rate-limited read is
explicitly *not* one of those failures - `CandleRateLimitError` is separate from
"this pool has no chart", because conflating them would retire every healthy
tracker after a busy few minutes.

### A price alert

```
every PRICE_POLL_SECONDS
  └─ load active alerts
       ├─ getPairsForTokens(unique addresses)   one request per token
       ├─ selectPricePair()                     reject broken pools
       ├─ crossed and armed? → fire
       │     └─ resolveFeature() at fire time → channel post or DM
       └─ price back on the other side? → re-arm (repeating alerts only)
```

Settings are read when the alert **fires**, not when it is created, so an admin
switching the feature off or to DM-only affects alerts already set.

---

## Non-obvious decisions

**Everything in one process.** The dashboard needs the Discord guild and channel
caches and the same database. Splitting it out would mean duplicating both or
adding an internal API, for a tool a handful of admins use.

**No frontend bundler.** The dashboard's forms are generated from a schema, so
there is little frontend logic to bundle. A toolchain would add build complexity
and a second dependency tree to a bot repo for no benefit.

**The dashboard fails closed.** Missing auth config means it does not start, and
the bot runs without it. There is no unauthenticated mode.

**Alert firing is armed/disarmed, not cooldown-based.** A repeating alert
disarms on fire and re-arms only when the price returns to the other side of the
target. A time-based cooldown would either spam while the condition held or miss
a genuine re-cross.

**Workers guard against overlap with a `running` flag** rather than queueing. A
slow cycle should be skipped, not stacked — stale launch data is worthless.

---

## Market data constraints

These are upstream behaviours that are easy to get wrong and fail silently
rather than erroring. All three are enforced in `src/market/`:

1. **Never query `/tokens/{a,b,c}` with many addresses.** The response caps at 30
   pairs *in total*, so 20 addresses come back with about one arbitrary pool
   each. Use `getPairsForToken` (one address) or `getPairsForTokens` (parallel,
   one request per token).

2. **Price through `selectPricePair()`, never `bestPair()` alone.** The deepest
   pool is not always the correct price. BONK has had a $2M pool quoting 5000x
   what every other pool agreed on. `selectPricePair` takes the median across a
   token's pools as consensus and drops anything more than 3x away.

3. **A ticker is a guess; an address is a fact.** DexScreener's search returns
   impostors and sometimes omits the canonical token entirely. Majors are pinned
   in `known-tokens.ts`; everything else is ranked on the geometric mean of
   liquidity and volume and returned with `verified: false`, which the commands
   surface as a visible warning.

At default poll intervals the bot uses roughly 100 requests/minute against
DexScreener's 300/minute limit, leaving headroom for slash commands.
