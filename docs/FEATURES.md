# Features

A **feature** is a unit of bot behaviour that can be switched on or off, and
tuned, independently per Discord channel.

Everything about a feature is declared in one file. The dashboard, its API, the
settings validator and the `/feature` slash command are all generic over that
declaration — none of them contains per-feature code. Adding a feature means
writing one descriptor and registering it.

---

## The shipped features

| Feature | ID | Kind | Commands | Default |
|---|---|---|---|---|
| Market Lookup | `market-lookup` | command | `/price` `/scan` | on |
| Price Alerts | `price-alerts` | command | `/alert` | on |
| Coin Tracker | `coin-tracker` | command | `/track` | on |
| Launch Scanner | `launch-scanner` | push | – | off |
| Token Brief | `token-brief` | listener | – | off |
| Call Tracker | `call-tracker` | listener | – | off |
| Volume Spikes | `volume-spikes` | push | – | off |
| Whale Buys | `whale-buys` | push | – | off |
| Trending Momentum | `trending` | push | – | off |
| Dip Hunter | `dip-hunter` | push | – | off |
| Level Break | `level-break` | push | – | off |
| PvP Coins | `pvp-coins` | push | – | off |
| Vamp Watch | `vamp-watch` | push | – | off |

The last seven are the **volume monitor**, and they are unusual in one way: they
are seven descriptors served by *one* worker (`src/monitor/worker.ts`) over one
shared watchlist. They share a poll, so running them separately would spend seven
times the request budget to learn the same facts. `MONITOR_FEATURES` in the
registry is the list anything iterating "the monitor" should use. Setup, data
sources and threshold tuning are in [VOLUME-MONITOR.md](VOLUME-MONITOR.md).

`/help` is not gated by anything and never should be: it is how somebody finds
out that a feature exists and that it is switched off, which is precisely the
question a gate would refuse to answer.

The monitor's watchlist is managed with `/watch`, which is deliberately **not**
gated by any of them: it is one shared bot-wide resource, and tying it to a
single feature's per-channel switch would mean turning off volume spikes in one
channel stopped anyone managing the tokens whale alerts depend on. It checks the
Manage Server permission instead.

**Rug Watch (`rug-watch`) is parked.** Its descriptor and worker still exist but
it is not in `FEATURES` and its worker is not started, so stored rows for it
resolve to nothing. Token Brief replaced it: same trigger, same providers, but
it explains the token rather than scoring it, and answers privately instead of
in the channel. Re-list it in `src/features/registry.ts` and start
`RugWatchWorker` in `src/index.ts` to bring it back.

### Kinds

- **`command`** — answers slash commands. Runs server-wide, with optional
  per-channel overrides. Defaults to on, because a command nobody runs costs
  nothing.
- **`push`** — sends messages on its own schedule. Every instance *must* name a
  channel, since each row is a destination rather than an override. Defaults to
  off, because a bot posting somewhere unasked is never acceptable.
- **`listener`** — reacts to messages in whatever channel they appear in. Scopes
  like `command` (server-wide plus overrides), but it talks unprompted, so it
  defaults to off.

`requiresChannel(kind)` is the single predicate that decides whether an instance
needs a channel. Add a kind there rather than testing `kind === 'push'` at each
call site.

### Token Brief needs a privileged intent

`token-brief` reads token addresses out of *other* bots' messages, which Discord
gates behind the **Message Content** privileged intent. It must be enabled in
two places or nothing happens:

1. Discord portal → your app → Bot → Privileged Gateway Intents → **Message
   Content Intent**
2. `ENABLE_MESSAGE_CONTENT=true` in the environment (the default)

If the environment asks for it and the portal has not granted it, **login fails
outright** with `Used disallowed intents` — the whole bot, not just this
feature. Set `ENABLE_MESSAGE_CONTENT=false` to run everything else without it.

Under 100 servers the portal toggle needs no approval.

---

## How scope resolution works

Configuration is stored as **feature instances**. One row is one feature
configured for one place:

```
{ guildId, featureId, channelId, enabled, settings }
```

`channelId: null` is the server-wide row.

When the bot needs to know "is this feature on here, and with what settings",
`resolveFeature(featureId, guildId, channelId)` checks in order:

```
1. the row for this exact channel     ← wins outright if present
2. the server-wide row (channelId null)
3. the feature's built-in defaults
```

**A channel row replaces the server-wide row completely — it does not merge
field by field.** That is a deliberate choice. Partial merging makes "why is
this channel behaving like that?" nearly impossible to answer once a few
overrides exist; whole-row replacement means exactly one row explains any
channel's behaviour.

### What this buys you

The same feature can run several times with different settings. The intended
use for a trading server:

```
#alpha-calls   Launch Scanner   min liquidity $250k, max risk 15, socials required
#degen-plays   Launch Scanner   min liquidity $5k,   max risk 75, no socials, <2h old
```

Two independent scanners, one bot. The launch scanner's dedupe is scoped per
channel too, so a token that qualifies for both is posted to both.

---

## How Token Brief reads other bots

Token Brief answers "someone just posted a token — what am I looking at?" in
plain English.

### Where it replies

`delivery` is `channel` (default) or `dm`.

There is deliberately no third option for "visible only to one person in the
channel": Discord allows a hidden ("ephemeral") message solely as the **reply to
an interaction**, and someone else's post is not an interaction. A DM is the
only private answer that exists here.

In `dm` mode, recipients come from the `recipients` setting. If that is empty
the brief goes to `instance.updatedBy`, whoever last saved the feature, so
`/feature enable token-brief` works on its own instead of silently sending
nothing. With no valid recipient the worker returns before any provider call —
a feature with nobody listening should cost nothing.

### It never parses Rick's layout

It takes the **address** out of the message and nothing else. Every number in
the brief is then fetched from our own providers, which is what lets it survive
Rick's next redesign, say things Rick does not, and be explicit about what
nobody checked.

Rick's embed format is not documented, other token bots differ, and formats
change. So instead of a layout parser,
`src/discord/token-extract.ts` sweeps every piece of text a message carries —
content, and each embed's title, description, url, author, footer and fields —
and pulls out anything address-shaped:

1. **Links that name a chain** — DexScreener, DexTools, Birdeye, Solscan,
   Etherscan/Basescan/BscScan/Arbiscan, Bubblemaps, pump.fun. These rank first,
   because the chain is unambiguous.
2. **Bare addresses** — EVM `0x…40` and Solana base58 32–44, with a chain taken
   from surrounding prose only when it matches the address family.

Precision comes from the far end, not the regex: a candidate is only reported
once DexScreener confirms it is a real traded token. That is what makes a loose
match safe.

Two details worth knowing:

- **DexScreener and DexTools links carry the *pool* address, not the token.**
  Refs from those sources are flagged `mayBePair`, and the resolver retries a
  failed token lookup as a pair lookup.
- **Solana transaction signatures are 86–88 base58 chars**, so the 32–44 bound
  excludes them. Same for 64-char hex hashes on the EVM side.

Add a new link shape by appending to `URL_PATTERNS` — no other code changes.

### What the brief is allowed to say

`src/analysis/brief.ts` builds the wording, and holds two rules:

1. **Every sentence is tied to a number we hold.** Nothing is inferred or
   softened. A provider that did not answer produces a line under *Nobody
   checked* rather than a guess — the same reason the risk score is always a
   vendor's. Rick's "85% fresh wallets" has no equivalent in our providers, so
   the brief says so instead of approximating it.
2. **Vendor findings and ours stay in separate lists.** The *Safety checks*
   section is what RugCheck/GoPlus/honeypot.is said; *What the numbers say* is
   what the market and distribution figures say. They never restate each other,
   so it is visible when the two disagree — which is when a token is most worth
   a second look.

`src/risk/holders.ts` supplies distribution, deliberately outside `RiskReport`:
it is fact, not verdict, and it never feeds a score. Both vendors list pool
accounts alongside wallets (a bonding curve holding 31% is normal and says
nothing about concentration), so AMMs, lockers and burn addresses are stripped
there rather than at each call site.

```bash
pnpm brief WIF 0x6982…    # renders a brief as terminal text
```

---

## How Coin Tracker reads a chart

`/track add WIF` stores a row in `coin_trackers`; `CoinTrackerWorker` re-reads
each tracked pool's one-minute candles every `TRACK_POLL_SECONDS` and announces
turns.

### The signal

Three published indicators vote on the latest **closed** candle:

| Signal | Turns up when | Turns down when |
|---|---|---|
| EMA 9/21 | fast crosses above slow | fast crosses below slow |
| MACD 12/26/9 | histogram turns positive | histogram turns negative |
| RSI 14 | crosses above 50 | crosses below 50 |

`confirmations` (default 2) is how many must agree. A cross counts if it
happened within the last 3 closed candles, but **at least one must have crossed
on the latest one** — otherwise a cross three bars back would re-announce itself
every minute until it left the window.

The indicators are the textbook formulas, verified against a published RSI
series. That is the same rule as the risk score: a number the bot shows should
be one the reader can reproduce in a charting tool.

### Why it does not fire more often

A one-minute memecoin chart crosses something constantly. Three rules:

1. **Direction must change.** The same direction twice is not a turn, it is a
   continuation. This is the state machine (`lastDirection`), and it is the one
   that matters.
2. **Cooldown.** No second message inside `cooldownMinutes`, whatever happens.
3. **Minimum move.** `minMovePct` since the last signal price, which is what
   silences a chart chopping across a crossover.

### Two things about the candle feed

- **A minute with no trades produces no candle.** GeckoTerminal returns what
  traded, so 150 "one-minute candles" can span 17 hours on a quiet pool. An EMA
  over those is a perfectly valid number describing something that is not a
  one-minute trend. `cadence()` measures the real density of the window and
  `detectTurn` declines above `MAX_GAP_RATIO` (2.0, i.e. half gaps).
- **Charts come from the busiest pool, not the deepest.** `busiestPair()` picks
  by 24h volume from the same consensus-price-filtered set `selectPricePair()`
  uses. Depth answers "whose price do we quote"; trade frequency answers "whose
  chart can be read minute by minute". One of WIF's deepest pools prints a
  candle every seven minutes.

Rate limiting is a third state, not a failure: the free tier allows ~30 requests
a minute across the whole bot, so `CandleRateLimitError` is raised separately and
the worker leaves that tracker untouched — no error count, no `lastCheckedAt`,
so it goes first next tick.

```bash
pnpm ta SOL 2     # replay the detector and the three noise rules over the chart
```

---

## Adding a feature

### 1. Write the descriptor

Create `src/features/definitions/my-feature.ts`:

```ts
import type { FeatureDescriptor } from '../types.js'

export const MY_FEATURE: FeatureDescriptor = {
  id: 'my-feature',              // stable: it is the database key
  name: 'My Feature',
  description: 'One line. Shown on the dashboard card.',
  icon: '📈',                    // emoji, used as the card icon
  kind: 'command',               // or 'push'
  defaultEnabled: true,
  commands: ['mycommand'],       // slash commands this feature gates
  help: {                        // what `/help my-feature` prints
    detail: [
      'What it does, and where it matters, what it refuses to claim.',
    ],
    seeAlso: ['`/watch add <token>` - commands it does not own but you need'],
    firstStep: 'One line on what to do after switching it on.',
  },
  settings: [
    {
      key: 'threshold',
      type: 'number',
      label: 'Threshold',
      description: 'Explain the trade-off, not the type.',
      default: 100,
      min: 0,
      max: 10_000,
      step: 10,
      unit: 'USD',
    },
  ],
}
```

### 2. Register it

```ts
// src/features/registry.ts
export const FEATURES: FeatureDescriptor[] = [MARKET_LOOKUP, PRICE_ALERTS, LAUNCH_SCANNER, MY_FEATURE]
```

That is the whole integration. The dashboard now renders a card with a working
form, the API validates writes against the schema, `/feature enable my-feature
#channel` works, and the feature appears in `/help` with its own page under
`/help my-feature`.

`help` is optional in the type and required in practice: a feature without one
falls back to its one-line `description`, which is what the dashboard card
already says and is not an explanation. A test asserts every registered feature
has one, and that no feature's help exceeds Discord's embed limits - a page too
long is a 400 at send time, which would break `/help` for every feature rather
than just its own.

### 3. Read the settings where the behaviour lives

In a command, gate first — `gate()` handles the "switched off here" reply:

```ts
import { gate } from '../gate.js'

async execute(interaction) {
  const resolved = await gate(interaction, MY_FEATURE.id)
  if (!resolved) return                       // gate already replied

  const threshold = resolved.read.num('threshold', 100)
  // …
}
```

In a worker, iterate the enabled destinations:

```ts
import { listEnabledPushInstances } from '../db/features.js'

const rows = await listEnabledPushInstances(MY_FEATURE.id)
```

---

## Setting field types

All fields share `key`, `label`, optional `description`, and optional
`showWhen`.

| `type` | Extra keys | Dashboard control |
|---|---|---|
| `boolean` | `default` | toggle switch |
| `number` | `default`, `min`, `max`, `step`, `unit` | numeric input with unit |
| `string` | `default`, `maxLength`, `placeholder` | text input |
| `select` | `default`, `options[]` | dropdown |
| `multiselect` | `default[]`, `options[]`, `emptyMeansAll` | toggle chips |
| `roles` | `default[]`, `maxRoles` | toggle chips, filled from the guild's roles |
| `bands` | `default[]`, `edgeLabel`, `valueLabel`, `edgeUnit`, `valueUnit`, `min`, `max`, `maxRows` | editable table of size bands |

### `roles`

Discord roles to mention, picked from the guild's own role list rather than
typed as ids.

```ts
mentionRolesField()   // src/features/fields.ts
```

The options are **not** in the descriptor, because they are not knowable there:
they are whatever roles that server has today. The dashboard fills them from
`/api/guilds/:guildId/roles` and the validator checks only the shape - a
descriptor cannot name a role a guild may not have, and a role deleted after it
was picked has to fail as "nobody to ping" rather than as a settings save the
admin cannot complete. `@everyone` and integration-managed roles are left out of
the list: the first needs a permission the bot is not given, the second is one
row per bot in the server and cannot be assigned to anyone.

Read it through `pingFor()` rather than off the settings directly - that is what
makes "roles to ping" mean the same thing in every feature:

```ts
const ping = pingFor(destination.read, { priority: trigger.priority })
await channel.send({
  ...(ping ? { content: ping.content, allowedMentions: ping.allowed } : {}),
  embeds: [embed],
})
```

Two rules live in there. Mentions are listed explicitly in `allowedMentions`, so
a message can only ping exactly who the settings name. And `priority` is passed
only by features that grade their alerts - `pingOn` is not consulted otherwise,
because a launch has no low-priority version to hold a ping back for.

### `bands`

A threshold that varies by size, for when one number cannot serve both ends of a
range - $1k of five-minute volume is a living $30k coin and a dead $5m one.

```ts
{
  key: 'volumeFloors',
  type: 'bands',
  label: 'Counts as no volume',
  edgeLabel: 'Market cap up to',
  valueLabel: 'Minimum 5m volume',
  edgeUnit: 'USD',
  valueUnit: 'USD',
  default: [
    { upTo: 50_000, value: 500 },
    { upTo: null, value: 10_000 },
  ],
}
```

Each row is `{ upTo, value }`, read low to high, with `upTo` exclusive. The last
row always has `upTo: null` and answers for everything above the final edge -
the validator sorts the rows, drops duplicate edges and forces that catch-all,
because a set of bands with a hole above the top edge reads as "no limit here"
and silently stops filtering.

Read it with `read.bands(key)` and look a value up with `bandValue`:

```ts
const floor = bandValue(read.bands('volumeFloors'), snapshot.marketCapUsd)
if (floor !== undefined && volume < floor) …
```

`bandValue` returns `undefined` when the size is unknown, rather than falling
back to a band. Picking one would be inventing the very fact the caller does not
have - so the rule that depends on it simply does not apply.

### `emptyMeansAll`

On a multiselect, selecting nothing usually means "no filter" rather than
"nothing allowed". Set `emptyMeansAll: true` and the dashboard says so. Your
code must honour it:

```ts
const chains = resolved.read.list('chains')
if (chains.length > 0 && !chains.includes(pair.chainId)) return false
```

### `showWhen`

Hides a field until another setting has a given value:

```ts
{ key: 'webhookUrl', type: 'string', label: 'Webhook', default: '',
  showWhen: { key: 'deliveryMode', equals: 'webhook' } }
```

---

## Validation

`validateSettings()` in `src/features/types.ts` coerces and checks every write
against the schema. It runs on the API path, so a malformed or malicious
payload cannot reach the database.

Two behaviours worth knowing:

- **Unknown keys are dropped, not rejected.** A dashboard running an older
  schema cannot write junk into a newer bot.
- **Invalid values fall back rather than wiping.** A rejected field keeps its
  stored value; the request returns 400 listing what failed, and nothing is
  written.

Reads are equally forgiving: `resolveFeature()` merges stored settings over the
current defaults, so a setting added after a row was written appears with its
default instead of `undefined`.

---

## Changing a feature later

- **Adding a setting** is safe. Existing rows pick up the default.
- **Renaming a `key`** orphans the stored value. Treat it as add-plus-remove,
  and migrate in `src/db/migrate.ts` if the old value matters.
- **Changing `id`** orphans every stored row for that feature. Avoid it; if
  unavoidable, migrate.
- **Removing a feature** leaves its rows in `feature_instances`. They are
  ignored (`getFeature()` returns undefined) and can be deleted at leisure.
