# Changelog

What changed, and why. Entries are grouped by what they affect rather than
strictly by date, because most of it landed together.

---

## 2026-08-25 ("My Alerts" picks from the shared watchlist first)

Adding a coin to "My Alerts" was always a paste-a-CA form, same as My Charts. It now leads with a
dropdown of the shared watchlist's coins you aren't already tracking, with **"+ New tracked coin"** as
the first option - picking that reveals the original chain-select + paste-a-CA fields for anything not
already there; picking an existing coin tracks it directly, no address to re-type.

This isn't just convenience. **Only watchlist coins (or a token with an open Call Tracker call) can ever
actually fire a personal alert** - `notifyPersonalWatchers` is called from the two places a `Trigger`
already exists (`postCallSpike`, `post` in `monitor/worker.ts`), both of which only run for tokens the
monitor is evaluating. A coin tracked via manual CA entry that isn't on the watchlist and has no open call
would sit in "My Alerts" forever without ever generating a trigger to forward - not broken, just silently
inert. Leading with the watchlist steers toward coins that actually work; "+ New tracked coin" still
exists for anything not there yet, understanding that it won't alert until something else adds it to the
watchlist too.

`app.js`: new `state.myAlertsWatchlist` (fetched alongside the personal list in `loadMyAlerts()`, best-
effort - losing it only loses the shortcut, manual entry still works), `renderAlertsTrackOptions()`
(watchlist minus already-tracked, by `chainId:tokenAddress`), and `updateAlertsNewCoinVisibility()`
toggling the manual fields. `addAlertsCoin()` now branches on the dropdown's value instead of always
reading the chain-select/CA-input pair.

---

## 2026-08-25 ("My Alerts" - personal tracked-coin lists, delivered to your own Telegram)

Telegram alerts were bot-wide and text-only: one chat (`TELEGRAM_CHAT_ID`), fed only by `priority:
'high'` triggers. A new dashboard tab, "My Alerts", now lets each dashboard user (Wayne, Ash - keyed by
`session.userId` the same way "My Charts" is, never by guild) pick their own coins and their own
Telegram chat, and get a message **with a chart attached** whenever *any* trigger fires on one of them,
regardless of priority - a coin someone chose to track is worth knowing about at any grade.

New model `TelegramWatch` (`src/db/models.ts`, collection `telegram_watches`): `userId`, an optional
`telegramChatId` (absent until someone messages the bot and pastes the chat ID back in - a real,
intended state, not an error; delivery is simply skipped for it), and a flat `coins` list. Routes mirror
`custom-board`'s per-user pattern (`src/web/routes.ts`): `GET`/`PUT .../chat-id` and
`POST`/`DELETE .../coins/...`, the add step resolving through `resolveToken()` exactly like My Charts
does, so a tracked coin can never point at a pair nobody proved trades it.

`src/monitor/chart-card.ts` gained `renderChartPng()` - everything `renderCard()` already did, minus the
final `AttachmentBuilder` wrap, so a non-Discord caller gets the same chain/candle/sparse-series gating
without pulling in `discord.js`. `railsFor()` is now exported too. New `src/monitor/personal-alerts.ts`
calls both: it builds the same rail a Discord alert would (`railsFor`), and where that would come back
empty (Volume Spikes, Whale Buys, Trending, PvP, Vamp Watch - kinds Discord never charts, per this
file's own "a chart is evidence or it is not attached" rule), falls back to a plain "current price" rail
rather than repurposing `seriesIsTheClaim` or loosening that rule for every other channel.

A chart is mandatory here, not best-effort, per Wayne's explicit follow-up the same day: where
`renderChartPng` genuinely cannot produce one (a chain with no candle feed, a failed/rate-limited fetch,
too few/too sparse candles), the personal alert does not go out as text instead - it does not go out at
all, logged as a skip rather than sent half-informative. The caption is not a thin summary either: the
caller passes in the same `telegramMonitorText(...)`/`telegramCallText(...)` string already built for the
bot-wide chat (trigger detail lines, liquidity, divergence/flow, the copyable CA and trade links), so a
personal alert never carries less detail than the one it stands in for - computed once per hook point and
reused for both sends rather than built twice.

`src/integrations/telegram-alerts.ts` gained `sendTelegramPhoto()` (Telegram's `sendPhoto`, multipart -
Node's global `FormData`/`Blob` cover it, no new dependency) and refactored `sendTelegramAlert()` onto a
shared `sendTelegramMessage(chatId, text)` primitive, since chat ID is now per-recipient rather than
always `config.TELEGRAM_CHAT_ID`. Wired into both of `monitor/worker.ts`'s existing Telegram hook points
(`postCallSpike`, `post`) alongside the existing bot-wide mirror, not gated on `priority === 'high'`.
Because `post()` runs once per (Discord destination, candidate) - a token watched by several channels
for the same feature would otherwise fire this several times for what a personal watcher experiences as
one event - `personal-alerts.ts` collapses repeats of the same token+trigger-kind within a 30s window
(comfortably inside "one poll cycle fanning out to several channels", comfortably outside "this
genuinely fired again next cycle").

New `pnpm telegram-watch-test <chainId> <address> <telegramChatId>` sends one real chart + message
through the pipeline against a live token, so the dashboard-to-Telegram round trip can be verified
without waiting for a market trigger. Rollout is deliberately staged: Ash's row can hold tracked coins
with no chat ID yet - delivery is skipped, not broken, until his ID is known.

The homelab's bot-wide mirror (`TELEGRAM_CHAT_ID` in `deploy/homelab/.env.homelab`) is commented out as
of this same day, at Wayne's request - it pointed at his own chat, the same one his "My Alerts" now
delivers to, so leaving both on meant every high-priority trigger on any watched token duplicated on top
of his own tracked-coin alerts. `TELEGRAM_BOT_TOKEN` stays set; "My Alerts" never reads
`TELEGRAM_CHAT_ID`. Re-add the value to bring the bot-wide mirror back.

---

## 2026-08-25 (Telegram alerts get a copyable CA, FOMO and Axiom)

`integrations/telegram-alerts.ts`'s high-priority mirror (`telegramMonitorText`,
`telegramCallText`) posted a headline, the figures and a bare DexScreener link
- no contract address and no trade venue, so acting on one meant switching
back to Discord first. Both now add the raw contract address on its own line
(copyable without any Telegram formatting - selection treats a line with no
spaces as one word, the same reason a bare URL is already tappable with no
`parse_mode` set) plus `FOMO: <url>` / `Axiom: <url>` lines from
`market/trade-links.ts`'s `tradeLinks()`, filtered to just those two venues -
GMGN and Jupiter stay Discord-card-only, since a phone notification is
answering "do I need to look at this now", not listing every venue.
Deliberately still plain text, not `[label](url)` markdown - this file's
whole reason for skipping `parse_mode` (upstream token names can carry
Markdown-special characters) is unchanged.

---

## 2026-08-25 (a second, independent rug signature: holder-distribution flatness)

The funding-graph rug check is fitted to launches where the buyer wallets are
fresh and single-use. NINE1NINE (`V6hhzCkoBqaiw5E8bdKoaMo7VrS1f29tGBn7LC1pump`)
defeated it with aged, reused wallets instead - all 20 of its top holders came
back `not-fresh`, so the funding graph returned `unknown`. What gave it away
was its *distribution*: eleven wallets holding between 1.448% and 1.508% of
supply, a spread of six hundredths of a percentage point. Organic holders
follow a power law; a flat line is a script.

`risk/rugSignature.ts` now runs a second, independent test alongside the
funding graph: the coefficient of variation (population stdev / mean) of the
top 10 non-pool, non-insider holders' `pct`, which costs zero RPC calls - it
reads the same holder list the funding graph already resolved from the
RugCheck report `getHolderProfile` fetches for free. `OwnedHolder` (in
`risk/holders.ts`) now carries `insider?: boolean` so a disclosed team/creator
allocation can be excluded before sampling, rather than anchoring the sample
flat for a non-deceptive reason.

`DISTRIBUTION_CV_FLAG_THRESHOLD` (0.10) came from a live-fetched control set
of 60 recently-graduated pump.fun coins (57 scored), not a guess. Two things
the investigation resolved before picking a number: a cluster of five exact-
zero-CV controls turned out to be real, independently corroborated by
RugCheck's own "High holder correlation" risk flag rather than a data
artifact; and `coins?complete=true` only returns already-graduated tokens, so
the whole control set is measured *post*-decay while this check runs
*pre*-graduation in production (`maybeRugCheck` in `launch-scanner.ts`,
unchanged) - NINE1NINE itself moved from 0.066 CV pre-graduation to 0.594 CV
hours later, re-measured as part of this same investigation. The threshold
sits in the one clean gap the control set actually has (nothing scored
between 0.015 and 0.108 across 57 coins) rather than reaching for the
control set's own median (0.974), biased deliberately toward under-flagging -
see the threshold's own comment in `rugSignature.ts` for the full numbers.

Combined verdict, both here and in `db/models.ts`'s `RugCheck`: `flag` if
either test flags, `clean` only if at least one ran to completion and neither
flagged, `unknown` if both were inconclusive - the same fail-loud discipline
the funding graph already followed (absence of data is never read as
"clean"). `RugCheckResult` gained `fundingVerdict`, `distributionVerdict`,
`distributionCv` and `distributionCohort`; every consumer that renders a flag
(`discord/embeds.ts`, `web/public/app.js`'s dashboard tooltip,
`integrations/signal-intake.ts`) now shows whichever sub-signal actually
fired instead of assuming it was always the funding graph.

---

## 2026-08-25 (Wallet Scout replaced by an imported Tracked Wallets list)

Wallet Scout tagged a wallet's quality from one signal - buying early into a
fresh pump.fun launch - which turned out too weak a heuristic to build a
reputation on. It's gone: `src/monitor/wallet-scout.ts`, the launch
scanner's `maybeScoutWallets`/`sweepWalletScout`/`runWalletScoring` hooks,
and `earliestBuyers`/`transactionTokenBuyers` in `solana-rpc.ts` are all
removed, along with the `wallet_entries`/`wallet_scores` collections (dropped
in production; the 10 rows they held were backed up first, then cleared).

In its place: `tracked_wallets`, populated only by
`pnpm import:wallets <file.csv> [chainId]`
(`src/scripts/import-tracked-wallets.ts`) - a hand-rolled CSV parser (quoted
fields, embedded commas) that upserts by `(chainId, wallet)`, matching
whatever columns a source file actually has rather than assuming one shape.
Seeded from strategic-scalp's own vetted list: 245 general wallets
(`tracked-wallets.csv`: score, 30d win rate, PnL, avg hold/position size) plus
20 from its `moonshot-frontrunner` cohort (cohort-tagged, not trade-scored -
no `score` field, shown as "not scored" rather than zero). 265 total, Solana
only for now.

`/wallet` now takes an optional `chain` choice and, when omitted, searches
every chain - an EVM address can be tracked on more than one of them at once,
since it's the same account everywhere (see `HOLDINGS_EVM_WALLET`). The
dashboard's "Wallet Scout" tab is now "Tracked Wallets": a filterable
leaderboard (search, chain, favourited-only) reading `GET
/api/guilds/:id/tracked-wallets`, still bot-wide data with per-guild auth
like every other dashboard route.

EVM tracking (Robinhood Chain, Base, BSC, Ethereum) is wired into the schema
(`TrackedWallet.chainId` already includes all four) but has no data yet - no
curated EVM wallet list exists anywhere on this machine. Import one the same
way once it does: `pnpm import:wallets <file.csv> <chainId>`, which lowercases
the wallet column for any chain but `solana`.

---

## 2026-08-25 (high-priority alerts mirrored to Telegram)

Every alert graded `priority: 'high'` - the same grade that is allowed to
ping a Discord role (see `pingFor` in `src/discord/mentions.ts`) - is now
also sent to a personal Telegram chat, bot-wide rather than per-guild.
`src/integrations/telegram-alerts.ts` follows the same rule
`signal-intake.ts` set for this kind of side-channel: fired in parallel with
the Discord post and never awaited, so a Telegram outage can never cost or
delay the alert it accompanies.

Off unless both `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set. Sent as
plain text with no `parse_mode` - a token's symbol or name is upstream data
and can carry Markdown/HTML-special characters, and Telegram auto-links a
bare URL in plain text anyway.

Wired into the volume monitor's `post()` and Call Tracker's
`postCallSpike()` - the only two places a `Trigger` (with its own
`priority`) gets posted. Launch alerts and price alerts have no priority
grade (see `launch-scanner.ts`), so neither reaches Telegram.

---

## 2026-08-24 (Holdings reads two wallets directly)

The Holdings page asked fresh-start what it currently held; it now reads two
wallets' on-chain balances itself instead - `HOLDINGS_SOLANA_WALLET` and
`HOLDINGS_EVM_WALLET`, config only, never tracked or stored.

Solana needed nothing new: `getTokenAccountsByOwner` against the RPC endpoint
already configured lists every SPL and Token-2022 mint an owner holds in two
calls, filtered to nonzero balances (confirmed live - one wallet had 91
Token-2022 accounts and only 3 with anything actually in them, the rest
closed-out or swept-empty spam).

EVM has no equivalent single call, so `src/market/blockscout.ts` is new: free,
keyless "list every token balance for an address" on whichever chains happen
to run a public Blockscout instance - confirmed live for ethereum, base and
Robinhood Chain via `chains.blockscout.com`'s own registry, each against a
real wallet. BSC has none: BscScan's equivalent (`addresstokenbalance`) is
gated to Etherscan's paid Standard plan and above, so it's left out of
`HOLDINGS_EVM_CHAINS` rather than silently returning nothing for it forever.

Both feed the same downstream this page already had - `resolveToken()` prices
whatever a wallet holds a real pool for, and a mint search discovery has
never been reliable (spam, an airdropped fake, a graveyard account) fails to
resolve and is dropped, the same as anywhere else on this dashboard a token
with nothing to quote it shows nothing rather than a guess.

`FRESH_START_POSITIONS_URL` is gone - `SIGNAL_INTAKE_URL`/`SIGNAL_INTAKE_TOKEN`
(the *outbound* direction, posting launch alerts to fresh-start) are untouched.

---

## 2026-08-24 (per-slot resolution on My Charts)

A My Charts slot now picks its own candle width when the coin is loaded,
instead of every card being fixed at 15m. The six options
(`RESOLUTION_OPTIONS` in `web/routes.ts`) aren't guessed - each was confirmed
live against GeckoTerminal's embed by watching the candlestick request it
actually made: `1m`/`5m`/`15m`/`1h`/`4h`/`1d` each produced a distinct
`resolution` value, while `30m`, `6h`, `1w` and capitalised `1D` all silently
fell back to the 15m default instead of erroring - worse than a rejection,
since nothing would ever tell a user their choice did nothing. `resolution`
survives `clearBoardSlot` ("change coin"): it's a display setting independent
of which coin is showing, so re-picking a coin in a slot keeps whatever
zoom level was already there.

---

## 2026-08-24 (My Charts, and gating the rug check for deploy)

New dashboard tab, "My Charts" - a freeform chart board, unlike every other
tab: it's keyed by the signed-in user (`CustomBoard.userId`, a Discord
snowflake or `local:<email>`), not by guild, so Wayne and Ash each get their
own regardless of which server they're viewing. A slot is a rectangle in grid
cells (`x/y/w/h`) that's either empty - grayed out, asking for a network and a
contract address - or resolved to a live GeckoTerminal embed, the same
provider Live Charts uses. Resolution always goes through the server's
`resolveToken()`, never a pool address typed in directly, so a slot can never
point at a pair nobody can prove trades that coin.

Drag and resize are hand-rolled (no grid library, matching this dashboard's
no-bundler rule): a slot leaves grid flow for absolute pixel positioning for
the duration of the gesture, snaps back to a `grid-column`/`grid-row`
placement on release, and only ever commits a position that doesn't overlap
another slot - an invalid drop reverts to wherever the pointer last passed
over a valid one. Iframes get `pointer-events: none` for the duration of any
drag, since a GeckoTerminal embed under the pointer would otherwise swallow
the move/up events.

Separately: the rug-signature checker (built 2026-08-24, still not validated
against a live Solana RPC) is now behind its own `ENABLE_RUG_SIGNATURE_CHECK`
flag, checked by both the automatic scan and `/rugcheck`. It defaults true,
but the homelab's own `.env.homelab` sets it false for this deploy -
`SOLANA_RPC_URL` there is already configured for price streaming, so without
the flag the check would have started making live calls against it the moment
this shipped, not once someone decided it was ready.

---

## 2026-08-24 (Wallet Scout gets a reputation)

Wallet Scout (phase 1) only ever left an early-buy entry `open` until it 5x'd
or sat stuck a full 72h - a pump.fun curve that never bonded and a wallet that
just went sideways both closed the same way, `neutral`, three days apart.
`sweepOpenEntries` now closes an entry `rugged` immediately on either of two
conditions: no $10k graduation liquidity within 2h of entry, or mcap falling
under 20% of its entry value at any age (so a coin that graduated fine and got
rugged afterwards is still caught, not just the ones that never bonded). Both
checks read only pairs DexScreener actually reported for that pass - an
unreported liquidity or mcap is never read as zero, the same trap the pool-
emptiness fix below exists for.

A new `scoreWallets()` (src/monitor/wallet-scout.ts) recomputes each wallet's
median outcome multiple (`mcapAtClose / mcapAtEntry` across its closed
entries, median rather than mean for the same reason `selectPricePair` uses
across pools - one 50x entry should not carry a wallet's whole rating) and win
rate into a new `wallet_scores` collection. It runs on its own hourly interval
in the launch scanner, decoupled from the pricing sweep's tick cadence -
re-summarizing already-closed rows doesn't need per-tick freshness. Below
`MIN_SCORED_ENTRIES` (5) closed entries a wallet reads "insufficient data,"
never a low score - the same unknown-is-not-low rule risk scoring runs on
everywhere else in this bot.

Surfaced read-only, nowhere else yet: `/wallet <address>` and a new "Wallet
Scout" tab on the dashboard. Nothing feeds this into alerting - deliberate,
so real data accumulates before anything acts on it. Next up, once it has:
"Alpha Wallets," an alert that fires when several good-track-record wallets
converge on a brand-new mint, well ahead of the liquidity/volume thresholds
that make today's launch alerts land late.

---

## 2026-08-24 (roles to ping)

Every push feature had its own copy of "who does this alert mention" - the
volume monitor's `mentionsFor()`, a second version inline in the launch
scanner, and Call Tracker and Price Alerts with no role setting at all. All of
it read a role as a single typed-in ID, which meant one role per feature per
channel and no way to see whether the ID was even a real role until a ping
silently did not fire.

`src/discord/mentions.ts` now holds the one `pingFor()` every alerting feature
calls, and `roles` is a new setting-field type (`src/features/types.ts`) whose
options are not in the descriptor - they cannot be, they are whatever roles a
given guild has - so the dashboard fills them from a new
`GET /api/guilds/:id/roles` and renders a click-to-toggle picker instead of an
ID box, coloured and labelled to match Discord's own role list, with a ⚠ on any
role the bot cannot mention. Ten features carry it: the seven monitor push
features, Launch Scanner, and - newly - Call Tracker and Price Alerts, which
had never had a mention setting before.

The old `mentionRoleId` field is not removed. `pingFor()` reads it only when
`mentionRoles` is empty, so a channel configured before today keeps pinging
exactly as it did - the picker is additive until someone actually uses it. And
`/feature`'s reply now renders a role id as `<@&id>`, which Discord shows as the
role's name and colour without pinging anyone, rather than an unreadable
snowflake.

---

## 2026-08-23 (private signal intake)

Wayne's own launch scanner now posts every launch it alerts on to a second
system - `fresh-start`'s trading intake, which queues a buy from it. This is a
personal side channel, not a bot feature: `src/integrations/signal-intake.ts`
is inert unless `SIGNAL_INTAKE_URL` and `SIGNAL_INTAKE_TOKEN` are both set, and
the homelab deploy config leaves both blank by default - a checkout with no
`.env.homelab` sends nothing and makes no request.

Firing happens in `considerLaunch()` (`src/workers/launch-scanner.ts`) once at
least one destination has cleared every filter, in parallel with the Discord
sends rather than after them - the intake refuses anything older than 120
seconds by the time its own worker reaches it, and posting to several channels
is several round trips that signal cannot afford to wait on. It is never
awaited, has a 5-second timeout, and a failure is logged and dropped rather
than surfaced - Discord has already received its post by the time this runs,
and it must never be able to slow or fail a scan cycle.

Retries are deliberately asymmetric: a 5xx or a network error gets two retries
with backoff, a 429 or a 4xx gets none, on the same reasoning `fetchJson`
already runs elsewhere in this codebase - a 429 means the pace was already
wrong, and a 400/401 will fail identically a second time. One token fires one
signal regardless of how many channels post it, tracked in a module-level
`Set` separate from the scanner's own per-channel `seen_tokens` dedupe.

Verifying it live against the real intake found a real bug in the client, not
the server: the intake's dashboard 307-redirects an unauthenticated request to
`/login`, and `fetch` follows a redirect by default - carrying the POST body
with it. Without `redirect: 'manual'` a stale or misconfigured deploy would
have silently posted a live signal's JSON into an HTML login page and logged
success. See the constraints file for the fix.

---

## 2026-08-21 (pools nobody measured)

A Token Brief for a pump.fun coin seven minutes old - $69k traded, 588 holders,
1,069 buys against 747 sells, up 358% on the hour - was headlined **🚫 Cannot be
traded - there is nothing left in the pool**, and listed *"POOL IS EMPTY - $0
liquidity. You would not be able to sell"* among what the numbers say.

DexScreener returns `liquidity: null` for a pump.fun bonding curve. It cannot
value one, so it publishes nothing. `assessMarket` read that through `?? 0` and
turned "nobody told us" into the most severe finding in the file - the same
failure as an early risk score rating a drained token "low 10/100" off absent
GoPlus fields, pointing the other way.

`assessMarket` now separates *unmeasured* from *zero*:

- unmeasured emits a **warn** naming the gap, and names a bonding curve as one
  only where `dexId` says so rather than inferring it from the mint;
- `untradeable` stays false, so the headline and the concerns list stop making a
  claim about depth nobody measured;
- both volume-against-liquidity checks are skipped, because a ratio needs a
  denominator.

A pool that actually drained reports `{usd: 0}`. That is a measurement, and it
still trips every flag it used to - the tests pin both halves.

Deriving a figure for the curve instead was considered and refused. pump.fun's
*virtual* reserves are seeded with about 30 SOL that is not depth, and the real
ones live in the curve account, which needs the PDA, which needs the Solana SDK
this codebase decodes pool accounts by hand to avoid. Saying the depth has not
been checked is the honest answer here.

---

## 2026-08-21 (holder counts)

`/scan 0x1496c649…` reported **2 holders** for a token with 89. The bot was
faithfully printing what GoPlus said: its `holder_count` is a figure from
whenever it last indexed the contract, and for BOMB that was launch hour, with
the whole supply still sitting in the contract address.

honeypot.is is already the risk vendor on Ethereum, BSC and Base, and its
`token.totalHolders` comes from transfer analysis performed for the request. It
now feeds `metrics.holderCount`, and `checkEvmChain` already spreads honeypot's
metrics last - so the corrected number wins on those three chains without any
new precedence rule. Chains honeypot.is does not cover keep GoPlus's count
rather than losing the figure.

### The second figure was the harder half

GoPlus is the only EVM vendor here that reports per-wallet shares, and that
breakdown comes from the same response as the wrong count - so it describes the
same stale moment. Left alone, the brief would have read *"89 holders · top 5
wallets 2% combined · cleanly distributed"*, which is one vendor's present
stapled to another's past and reads as a fact about distribution that nothing
measured.

`sampleIsStale` decides when the breakdown has to go: the two counts must differ
by both a **ratio of 2** and an **absolute gap of 10**. Neither alone is safe -
4 holders against 8 is twice as many and means nothing, while 2 against 89 is
the same ratio forty-four times over. When it fires, the wallets are dropped and
the profile carries a note naming both figures, so a reader can see which vendor
said what rather than finding a section quietly missing.

This also fixes the monitor's **Minimum holders** gate, which was rejecting real
tokens on a count taken at launch.

PEPE checks out unchanged: 575,180 holders, breakdown intact, because both
vendors agree about it.

---

## 2026-08-21 (/help)

`/help` on its own prints the whole bot: every feature grouped by what makes it
speak - answers a command, watches the channel, posts on its own - with a marker
per feature for whether it is switched on **in this channel**. That last part is
the useful half. "The bot is not doing anything" is almost always a feature
nobody turned on, and the answer comes from the same precedence `gate()` uses
rather than a second definition of "is this on".

`/help <feature>` prints one feature in full: what it does, what it refuses to
claim, the commands it owns, the commands it does not own but you need anyway,
how to switch it on, and what its settings are set to **here** rather than what
they ship as.

### The command has no per-feature code, and may never have any

`FeatureDescriptor` gained an optional `help` block - `detail` paragraphs,
`seeAlso` commands, a `firstStep` line. That is the schema-extension rule
applied to prose: `/help` needed more than the one-line `description`, so the
descriptor grew a field rather than the command growing a switch. A new feature
explains itself by filling it in, exactly as it gets a dashboard form by
declaring settings.

`db/features.ts` gained `resolveAllFeatures`, which answers the same question
for every feature off one query. Thirteen `resolveFeature` calls in a loop would
be thirteen round trips re-applying identical precedence, so the precedence
moved into a `resolveFrom` helper both paths share.

### Tests guard the limits, because exceeding one breaks every page

Discord rejects an oversized embed with a 400 rather than truncating it, so a
feature whose help grew too long would break `/help` for all of them. A test
asserts every registered feature has help, and that both views stay inside the
description, field and total caps - in a guild and in a DM.

`pnpm help-preview [feature|all]` renders it as terminal text, needing neither
Discord nor Mongo.

---

## 2026-08-21 (PvP coins and ticker vamps)

Two new monitor features, both push, both off by default: **PvP Coins**
(`pvp-coins`) and **Vamp Watch** (`vamp-watch`). Same worker, same watchlist,
same poll - `MONITOR_FEATURES` is now seven ids and the sentence counting them
has been removed from CLAUDE.md, because that is the line that goes stale.

### PvP Coins costs nothing to run

Every figure it needs was already in the poll: `volume.h1`, `marketCapUsd`,
`txns.h1` and `priceChange.h1`. It fires on turnover (the whole market cap
trading several times over in an hour), a matched book, and price flat or down
over that same hour.

The phrase "PvP coin" is a judgement and the alert does not make it - the
feature's *name* carries the interpretation and the headline carries the
arithmetic: *"1h volume is 6.0x its market cap, price -14.2%"*. Same split as a
spike alert saying "8.2x its baseline" rather than "about to run".

All three legs are required rather than defaulted. A token with no `txns.h1` has
not been shown to be two-sided; it has not been checked, and admitting it would
turn the balance test into "balanced, or nobody looked".

### Vamp Watch alerts on the copy, not the ticker

A copy ticker is minted every few minutes under any coin that is running, and
nearly all of them are an empty pool and a hopeful name. Alerting on the
*existence* of one would be a noise feed that trains the channel to skip the one
that mattered - so the newer mint has to clear its own floors before the
comparison is even computed: **$25k liquidity, 100 trades in the hour, $50k of
volume**, and under 24 hours old.

Those gates sit on the copy deliberately. `passesGates` only ever sees the token
on the watchlist, so a channel set to hear about its own coins being drained
gates the *original* - the copy would arrive completely unfiltered.

`target` picks a side (`original`, `copycat`, `both`) rather than the detector
owning it, the same shape as the direction filter on volume spikes: a channel
holding bags and a channel trading the trenches want opposite halves of the same
event. The alert always renders the watched token, so the links and contract
point where the reader is being sent; the other token is named in the body with
its address and chart link.

Four things it refuses to claim: which mint came second without both pool
creation times, a pairing across chains (usually a bridge, and an hour of volume
compared across two chains is not one audience), a ratio whose denominator is
missing rather than small, and a match on a ticker of two characters or fewer.
Whether the *names* match as well as the tickers is stated either way, because
tickers collide honestly and the reader needs to judge the pairing themselves.

### The search is discovery, so it is paid for like discovery

This is the first monitor alert that costs requests beyond the poll, so
`providers/ticker-search.ts` is capped at four tickers a cycle, oldest first,
and runs only while a channel has the feature on. The streamed path reads its
cache and never fetches - a swap event fanning out to the network would multiply
the one request the prefetch budgeted for.

`/latest/dex/search` caps its response at thirty pairs across every match, so
its figures are a sample. They rank candidates; they never price them. Each
survivor is re-read one request per token, because when the watched token is the
copy an understated sample lands on the *denominator* of the ratio and inflates
the alert - the unsafe direction.

The cost of that cap is stated rather than left to be discovered: on a 120-token
watchlist a given ticker is re-checked roughly every half hour, not every cycle.
Capping is logged, because a silent cap reads as full coverage.

Neither alert gets a chart. One is a claim about volume against market cap, the
other a comparison of two tokens, and the renderer draws a single price series -
the same reason volume spikes go without.

`pnpm alert-preview` renders both from fixtures.

---

## 2026-08-21 (trade links)

Alerts now offer **FOMO · Axiom · GMGN · Jupiter** where each can be built, and
the FOMO link is labelled `FOMO` rather than `Trade on FOMO`. Every format was
confirmed against how the venue actually builds URLs rather than inferred from
its domain.

**Axiom does not take a mint.** Its path is `/meme/<addr>` where the address is
the PumpSwap pool for a graduated token, or the pump.fun bonding-curve PDA
before that. Deriving that PDA needs `findProgramAddressSync`, which needs
ed25519 curve arithmetic, which would mean adding a Solana SDK to a codebase
that decodes pool accounts by hand precisely to avoid one - and it is not
needed, because DexScreener already hands us the pool address and for a
`pumpswap` pair that address *is* the PumpSwap pool. So Axiom is linked for
PumpSwap pairs and omitted otherwise, rather than pointed at a mint that
resolves to nothing. `dexId` is the signal rather than a `pump` suffix on the
mint: PANTS trades on PumpSwap with a mint ending in neither.

**GMGN covers four chains** - Solana, Ethereum, BSC, Base - so Robinhood Chain
gets no GMGN link. **Jupiter** is Solana only and takes the mint.

Only Jupiter could be verified by HTTP: GMGN and Axiom both sit behind
Cloudflare and answer a scripted request with 403 whatever the path. Their
formats come from a real indexed GMGN token URL and from Wayne's own working
memefun code respectively.

`MarketSnapshot` gained `dexId`, taken from the same pool as `pairAddress` so a
caller cannot pair one venue's id with another venue's address.

### Fixed: the log volume was unwritable

Yesterday's persistent-logging change mounted the volume but the bot could not
write to it - the container runs as `USER node` and Docker creates a named
volume's mount point root-owned. The directory is now created in the image with
the right ownership, which Docker copies into the empty volume on start.

---

## 2026-08-21 (persistence)

### Logs survive a redeploy

`docker compose up --build` destroys the logs of the container it replaces. That
is not theoretical: nineteen hours of chart-skip diagnostics were lost to it, on
the one deploy that was meant to be followed by reading them.

The bot now also writes to a dated file on a named volume, alongside stdout
rather than instead of it - `docker compose logs` keeps working unchanged.
Rotation is by date in the filename and files are pruned after 14 days, compared
by the date they *cover* rather than by mtime, since an append-only file's mtime
is the last time anything was logged. A container that cannot open its log
directory still starts: logging to a file is a convenience, running the bot is
the job.

### Candles are stored, so the same pool is not fetched twice for nothing

Worth being precise about what this does and does not buy, because the obvious
expectation is wrong. GeckoTerminal's OHLCV endpoint returns its newest 150
candles or nothing - there is no parameter for "only what I am missing" - so a
pool last seen thirty minutes ago still costs one full request to bring up to
date. **A store cannot make a request cheaper. It can only let one be skipped.**

It skips them two ways. A second chart of the same coin inside the freshness
window costs nothing, which is the common case when a coin is moving enough to
trip more than one alert. And the store outlives the process, so a redeploy no
longer starts every pool cold.

Freshness is a separate field rather than something read off the candles,
because it cannot be: a candle exists only for a minute that traded, so a gap
means either "quiet pool" or "nobody asked" and the rows themselves cannot tell
you which. `candle_pools` records when we last asked.

**Callers say how stale an answer they will take.** The detector default stays
one minute - a trend turn is judged off the newest closed bar, and an older one
reports a cross that may already have un-crossed. Charts ask for five, because
two and a half hours of shape does not move meaningfully in five minutes.

**And a refused fetch can fall back to the store, for callers that opt in.**
"Candle budget spent" was the likeliest reason an alert arrived without a chart,
and in most of those cases the candles were already on disk and thrown away. A
chart up to half an hour behind is worth having; a detector on stale candles is
a wrong signal rather than a late one, so the detectors do not opt in.

The merge is capped at 150. A long-lived pool accumulates more history than one
fetch returns, and handing a detector a longer series than it has always had
would change how its indicators seed - a store is not a licence to alter what
the detectors see.

`pnpm store-check` proves all three branches against real Mongo: fresh store
skips the request entirely, a stale one goes upstream, and a stale one with the
fallback enabled still returns its 150 candles when upstream refuses.

---

## 2026-08-21

### Two new per-channel settings

**Attach a price chart** (`includeChart`, default on) on every feature that can
draw one - Dip Hunter, Level Break, Call Tracker, Price Alerts and the Coin
Tracker. A channel that wants text-only alerts turns it off and the alert posts
unchanged without the image.

**Which direction counts** (`direction`, default `both`) on Volume Spikes. A
spike is a fact about volume, so firing on red candles as well as green is the
honest default and stays the default - a filter that switched itself on would
silently stop alerts nobody asked to stop. Set to *up only* and the same five
minutes that spiked must also have gone up.

Two details in that filter. Direction is judged over the **same window** the
volume spiked in, because a five-minute spike paired with an hourly direction
describes two different events. And a *missing* price change is refused rather
than treated as flat: admitting an unmeasured direction into a filter whose only
job is direction turns "up only" into "up, or nobody checked".

Direction was not added everywhere, because most detectors already own it:
Trending requires rising price by construction, Call Tracker only fires upward,
Level Break has `onFall`/`onRise`, and Whale Buys has had `buysOnly` all along.
Adding a fourth spelling of the same idea would be noise in the settings form.

Both are ordinary schema entries, so the dashboard renders them, the validator
enforces them and `/feature` edits them with no code in any of those places.

---

## 2026-08-20 (robinhood candles)

### Robinhood Chain has candles now

`chains.ts` carried a note that GeckoTerminal had no network for Robinhood
Chain, so `/track` refused there and chart cards skipped it - a third of the live
watchlist. Re-checked rather than trusted: the network exists now, and pulling
OHLCV for a live pool returns 150 candles at a **1.03 gap ratio**, which is
essentially perfect minute-by-minute data. Trend detection and charts both work
there as of this change.

### A sparse series gets no chart, on any chain

Checking that turned up the more interesting problem. The first Robinhood pool
tested returned 150 "one-minute candles" spanning **four and a half days** - the
documented "minute candles are not minutes" trap, on a pool doing $802 a day.

Candles are drawn by *index*, so that series renders identically to 150
consecutive minutes. Labelling the span honestly is necessary and not sufficient:
past a point the picture itself misrepresents time, and the only honest response
is no picture. `renderCard` now measures density with the existing `cadence()`
and refuses above a gap ratio of 3 - looser than the detector's 2, because a
chart only has to be a fair picture where an EMA has to be arithmetic.

The footer changed with it. It used to read `150 x 1m candles`, which is the
nominal interval and was a lie on any quiet pool; it now reads
`150 candles · 2.5h`, the span actually covered. The renderer no longer knows
what an interval is - the caller measures and says.

Across the eleven Robinhood tokens on the watchlist this draws the line where it
belongs: CASHCAT at 38,000 daily trades charts cleanly, LICKINGCAT at twelve does
not, and that is a fact about the pool rather than about the chain.

---

## 2026-08-20 (charts)

### Chart cards on the alerts that have a level

Ported money-maker's `strategies/swing/chart.py` to TypeScript as
`src/analysis/chart.ts`: an RGB framebuffer, a 5x7 bitmap font and a hand-rolled
PNG encoder over `zlib`. No plotting dependency and no native module to build in
the Dockerfile, which is the same reason the original avoids matplotlib and the
same reason the dashboard frontend has no bundler.

**A chart is attached only when the picture is evidence for what the alert says**,
which is true two ways. Either the alert is about a *level* the chart can draw -
Dip Hunter's recorded high, the level Level Break crossed, the price a call was
made at, a price alert's target - or the alert is a claim about the *shape of the
series*, which is what a trend turn is. Volume Spikes and Whale Buys get nothing:
a volume spike is not a price claim, and a swap is a point rather than a level.
A price chart beside either would imply something nobody measured.

Charts now ride on Dip Hunter, Level Break, Call Tracker, Price Alerts and the
Coin Tracker. The Coin Tracker's is free - it already holds the candles the turn
was detected from.

**Three silent no-chart paths, all normal.** No rail to draw; the chain has no
candle feed - Robinhood Chain is not on GeckoTerminal and a third of the live
watchlist sits there; or the candle budget is spent. None is an error and none
may cost the alert. The message goes out either way.

### Candle requests are now rate limited

`getMinuteCandles` called `fetchJson` with no limiter, so nothing enforced the
~30/minute the feed allows. The coin tracker was the only caller and its
concurrency cap held it down by accident. Attaching charts makes every alerting
feature a caller, which is precisely the arithmetic that turned the DexScreener
budget into a steady stream of refusals - so candles got a bucket before charts
shipped rather than after. Found the hard way: the first live chart render came
back `CandleRateLimitError` on the first request.

### Also

- The renderer filters non-positive candles before scaling. A negative low drags
  the axis below zero and produces a clean, readable, entirely wrong chart with a
  `$-106.4K` axis - plausible output rather than an error. Caught by looking at a
  rendered PNG, which no byte-level test would have found.
- CRC32 is written out rather than taken from `zlib.crc32`, which only landed in
  Node 22.2. This is the one place a runtime bump turns into a corrupt file
  instead of a crash.
- The footer names its own interval. The original hardcoded `1h` for a strategy
  that fetched hourly candles; ours are one-minute.
- `pnpm chart-preview <token|demo>` writes a card to a PNG. `demo` renders a
  synthetic series, because the candle feed is limited too hard to iterate on
  pixel spacing against live data.

---

## 2026-08-20 (alerts)

### Alerts read as sentences rather than dashboards

Every alert printed the current value of everything and left the reader to work
out what had changed. The monitor stores ninety readings per token per half hour
and none of it reached the embed.

**Figures are shown as their move.** `MCap $29.71M → $19.50M · -34.4%` rather
than `$19.50M`. Market cap had to be persisted for this - the snapshot row never
carried it - so deltas fill in as history accumulates rather than appearing at
once. A token with no usable "before" falls back to the bare current value
instead of dropping the line.

**One sentence about two measures disagreeing.** Depth and price answer different
questions, so the interesting case is when they part company: a price that falls
while the pool stays put is holders declining to sell into it. `describeDivergence`
covers the six combinations and returns nothing when both are flat, because two
numbers that did nothing is not an observation. It is a restatement of two
percentages, not a prediction - the same rule the Token Brief lives by.

**The transactions behind the move.** DexScreener reports trade *counts*, never
individual trades, so anything built on it can say "liquidity fell 2%" and stop.
Solana swaps arrive by Helius webhook and EVM swaps from `Swap` logs, so the
alert can say *3 sells totalling $412K in the last 5 minutes, one wallet 0x8f2a…*
instead. A chain with no per-transaction source omits the line rather than
estimating one out of aggregate volume.

**Every alert names the span it measured**, not the window it asked for - the
rule Dip Hunter already followed, applied everywhere. Plus a real disclaimer
instead of "always DYOR" buried in a footer.

**The token image** now comes from any pool that carries one rather than from the
busiest pool, which is routinely a fresh pool with no listing metadata - which is
how a token with a perfectly good icon posted without one.

### New feature: Level Break

Alerts when a watched token crosses a round market-cap level in either direction.
A slow bleed from $31M to $19M never registers as a spike and is the single most
talked-about thing that can happen to a coin that size.

The levels are a fixed **1-2-5 ladder** - $10M, $20M, $50M - and that is the
whole design decision. A level fitted to where price previously turned would
always find something, and calling it support is the same invention as a
hand-rolled risk score. So a fall from $29.71M to $28.32M crosses nothing and the
detector says nothing, which is the honest answer even though a competitor's
alert would have printed a number there.

Two guards: a crossing is measured against the *most recent* prior reading, since
comparing against two hours ago re-reports old crossings as news; and a
configurable buffer keeps a coin resting on $10M from re-alerting every cycle as
the last digit wobbles across it.

### Also

- `pnpm alert-preview` renders alerts from fixtures as terminal text. A layout is
  the product here, and the only way to know one reads well is to look at it.

---

## 2026-08-20 (later)

### DexScreener rate limiting

The bot was drawing a steady stream of 429s - 115 refusals in a quarter of an
hour - and the earlier fix of lowering the budget from 280/minute to 120 had not
stopped them. Three causes, three changes.

**The monitor spent one request per token per poll.** Thirty tokens on a
20-second interval is 90 requests a minute out of 120, before the launch scanner,
price alerts or anything a user typed. The monitor's own warning had been saying
so every five minutes: `watched:30 sustainable:24`.

Snapshots now come from two request shapes instead of one. The *token* endpoint
is the only call that can discover which pools a token trades in, so it is still
used - but only to discover, per token, every ten minutes. In between, those
pools are re-read by address through
`/latest/dex/pairs/{chain}/{…30 pool addresses}`, which returns exactly the pools
named rather than a capped sample. `trustedPairs` therefore still sees a token's
whole pool set and the cross-pool price consensus is unchanged.

Measured against the live watchlist rather than estimated: 15 Solana tokens went
from 15 requests a poll to 5, 11 Robinhood-chain tokens from 11 to 5, and the
whole 30-token watchlist from 30 to **12** - with identical snapshots either way.

Two things this deliberately does not do. Pool sets are re-discovered a few per
chain per cycle, because every set expiring in the cycle it was created would
restore the spike the cache exists to remove; but a token nobody has looked up
yet is *never* rationed, since it has no set to fall back on and a coin lands on
the watchlist precisely when something is happening to it. And a pool set that
returns nothing is forgotten rather than trusted, so a delisted pool becomes a
re-discovery instead of a token that reads as dead forever.

**The launch scanner asked one token at a time for answers a batch could give.**
Its pending-mint sweep checked 30 pump.fun mints individually every 45 seconds -
40 requests a minute to ask "has this hit a DEX yet". That question needs one
pool, not a token's full set, so it now goes through `/tokens/v1/{chain}/{…}`:
one request for thirty mints. The profile feed does the same, batched per chain.
40/minute becomes 1.3.

`/tokens/v1/` returns **one pool per token**, which is what makes it right here
and wrong everywhere else - `selectPricePair` spots a lying pool by comparing
pools against each other, and cannot do that with a sample of one. It is for
discovery only.

**A 429 was retried twice.** Each retry drew another token from the same bucket,
so one refusal cost three requests and did it while every other caller was
queued behind the same limiter - the retry storm was itself the outage.

429s are no longer retried. The correction belongs to the rate rather than to
the request: `fetchJson` throws, and tells the limiter, which cuts its sustained
rate by a quarter and creeps back 5% of the ceiling per minute once the endpoint
has been quiet for thirty seconds. The configured budget became a ceiling to
approach rather than an allowance to spend, which is the honest reading of a
published limit the endpoint does not actually honour. `/monitor status` shows
the throttled rate whenever it sits below the ceiling, so "alerts are late"
has a visible cause.

### Also

- `sustainableTokens()` no longer assumes a request per token. At a 20-second
  poll the watchlist ceiling it reports moved from 24 tokens to 72.
- `pnpm tsx src/scripts/batch-check.ts <chain> <address…>` counts the requests a
  real poll costs, against the real API. The batching claim is not something a
  unit test can check - it depends on how many pools real tokens have.
- Solana pool addresses are case-sensitive base58, so batched pair requests carry
  them verbatim while lookups stay lowercased for EVM's sake. Caught by a test
  that asserted the wrong thing first.

---

## 2026-08-18 → 2026-08-20

### New features

**Dip Hunter** (`dip-hunter`) — [VOLUME-MONITOR.md](VOLUME-MONITOR.md#dip-hunter)

Alerts when a watched token falls a set percentage off its own recent high, then
alerts again when it recovers. Two messages, one pair.

It is a fourth feature on the existing monitor worker rather than a new worker:
it needs the same watchlist, the same poll and the same snapshot history, and a
worker of its own would multiply the request cost to learn identical facts.

Two decisions worth keeping:

- The high comes from **our own recorded snapshots**, not `priceChange.h1`. A
  token that ran to 3x and gave it all back reads as flat on a trailing window;
  the peak only exists in a series.
- It **refuses to describe a window it has not watched**. A token added ten
  minutes ago can be 60% off its high, but that is a ten-minute high — so below
  `minCoverageMinutes` it stays silent, and every headline names the span
  actually measured.

Recovery is measured from the price the dip alert went out at, not from the
bottom: a bounce off the low means nothing while the low keeps making new lows,
and the alert price is what anyone acting on the first message would have paid.

**Call Tracker** (`call-tracker`) — [VOLUME-MONITOR.md](VOLUME-MONITOR.md#call-tracker)

When a coin is called in a channel — by Rick, or by someone pasting an address —
it goes on the watchlist automatically, is followed for a few minutes, and is
dropped again if it goes nowhere. If it runs, the channel that called it hears
about it with the caller tagged.

- **Attribution.** The message author when a human posted it. When a *bot* made
  the call, credit goes to whoever that bot was replying to — a bot is not a
  person and tagging Rick helps nobody. When neither resolves, it still posts,
  with no mention: guessing at a name is worse than leaving it out.
- **Multiples are measured from the call price**, which is what makes this a
  different question from Volume Spikes: not "is this busy" but "did that call
  work". Only upward, each multiple once.
- **Retirement.** Nothing is judged before `stuckMinutes` — a coin called at
  launch has no market cap or volume for its first minute by nature. A *missing*
  snapshot is never treated as a dud, because that is a failed poll rather than a
  dead coin.

### Live data

**EVM price streaming** — [VOLUME-MONITOR.md](VOLUME-MONITOR.md#price-streaming)

Prices now arrive as each swap lands rather than on the poll. The events we
already subscribed to for whale detection carry the price alongside the amounts:
a V2 `Sync` restates both reserves, and a V3 `Swap` carries `sqrtPriceX96`, which
*is* the price. So this was decoding, not new plumbing.

Measured block floors: BSC ~0.45s, Base ~2s, Ethereum ~12s (a chain limit nothing
can buy past). Robinhood Chain's public RPC serves no websocket, so it stays
polled.

**Solana price streaming** — [SOLANA-STREAMING.md](SOLANA-STREAMING.md)

Solana has no `Sync` event — a swap rewrites an account — so this subscribes to
whichever account holds the pool state and decodes it. Four AMMs are supported,
and every byte offset was verified against live mainnet accounts rather than read
off a document, with the captured bytes kept as test fixtures.

Accuracy at capture time: PumpSwap 0.117%, Meteora 0.26%, Raydium 0.23% from
DexScreener's own figures — the residual being two readings seconds apart.

Two traps caught by testing against real bytes:

- **Meteora DLMM cannot be priced from its reserves.** Concentrated liquidity
  means the reserves say how much sits either side of the price, not what it is —
  reading them as a constant-product pool underpriced a token by ~600x. The price
  is the active bin.
- **pump.fun vaults are Token-2022**, so an owner check that knows only the
  classic token program decides a real vault is not a vault.

**A streamed price is half a snapshot.** A swap event knows nothing about 24h
volume, trade counts or pair age, so the live price is laid over the last polled
reading — and refused if that reading is more than ten minutes old. Polling did
not become redundant; it became the source of everything a swap cannot say.

**The stream has no dollars.** A pool quotes its own ratio, so USD comes from
anchoring that ratio to the aggregator's price at each poll. Before the first
anchor the price is held rather than published.

**Pre-pump baselines for auto-added coins**

Calls and discovery both add coins *because* something is happening, so the
ordinary baseline gets measured mid-move and the coin has to beat its own pump to
register. For those, the estimates become differences between the trailing
windows — `(h1 - m5) / 11` is the 55 minutes before the current one, `(h6 - h1) / 60`
the five hours before that. Subtraction is the one arithmetic overlapping windows
support.

On a coin that has run hard for an hour, the ordinary baseline reads 6.7x and
stays under a 10x threshold; the same coin against its pre-pump rate reads 90x.
A difference at or below zero means the whole hour happened in the last five
minutes, which is *no* baseline rather than a small one — the alert says so
instead of dividing by a crumb. Manual adds are unchanged.

**Poll interval and request budget**

`MONITOR_POLL_SECONDS` floors at 5 rather than 30, and the worker warns when the
watchlist outgrows the interval — over budget the limiter queues rather than
fails, so cycles run late while still looking healthy.

The DexScreener pair budget is now **120/minute with a 5-request burst**, set from
what the API tolerates rather than the 300/minute it advertises: 280 with a large
burst drew steady 429s. Live setting is a 20-second poll, which streaming makes
comfortable — the poll now supplies context rather than latency.

### Dashboard

**Email or username sign-in** — [DASHBOARD.md](DASHBOARD.md)

A second door beside Discord OAuth, because the people who need to tune
thresholds are not always the ones holding Manage Server on the guild the bot
sits in. Accounts live in `DASHBOARD_USERS` as scrypt hashes; there is no
registration and no reset flow.

A wrong login and a wrong password give the same answer in the same time, and
eight failures from one client locks it out for fifteen minutes. These accounts
reach every guild the bot is in, so one is full admin.

**`bands` setting type** — [FEATURES.md](FEATURES.md#bands)

A threshold that varies by size, added to the schema rather than special-cased
into a feature — so the dashboard renders the editor and the validator enforces
it, and any later "it depends how big it is" setting gets the same treatment.

First use: Call Tracker's "counts as no volume" floor, per market-cap band, since
$1k of five-minute volume is a living $30k coin and a dead $5m one. The validator
sorts rows, drops duplicate edges and forces the last row to be the catch-all — a
gap above the top edge reads as "no limit" and silently stops filtering.

### Alerts

**FOMO trade links.** Every notification now leads with a link into
fomo.family, ahead of DexScreener and the explorer: those two are there to check
something, this is the one someone acts on. Chain slugs are mapped explicitly and
only from confirmed links — `bsc` is `bnb` there, which is exactly why none are
guessed.

**Mobile layout.** Alerts used three `inline` fields, which collapse into narrow
columns on a phone and separate a figure from the heading that named it. Every
alert now uses label-value pairs, so a wrap can only ever break *between* pairs.
`inline: true` appears nowhere in `embeds.ts`, and a shared `statLine()` helper
means new alerts get the layout by default. Values a provider did not return are
dropped rather than printed as blanks.

### Server and deployment

**Test server rebuilt.** The Discord test server was reorganised around the bot:
20 old channels removed, 28 created across MARKET / ALERTS / LAUNCHES / BOT OPS /
ROADMAP, each with a topic describing what feeds it. Features were then routed to
their channels, with command features switched off server-wide and re-enabled
per channel.

**`deploy.sh` hardened.** Two runs hung for 11 and 6 hours, holding the terminal
without failing — the work had completed both times, but a trailing `ssh` sat
forever. Every remote call now goes through a guarded helper with SSH keepalives
and a hard `timeout` (120s for status calls, an hour for the build), `rsync` and
`scp` included. Cosmetic calls cannot fail the run, and the tunnel health window
went from two minutes to five, since cloudflared restarts with the deploy.

`timeout` is coreutils and macOS does not ship it, so where it is missing the
guards degrade to no-ops with a printed note rather than killing the deploy.

---

## Bugs found and fixed

| What | Why it mattered |
|---|---|
| Dashboard 500 on every load | A stored `rug-watch` row outlived its feature — Rug Watch is parked, not deleted — and the instances route assumed the registry still had it. One dormant row took the whole dashboard down. |
| Server-wide settings could not be edited | Field ids read `feature:channel::setting`, and the server-wide row has an empty channel, so `split('::')` cut `call-tracker:::volumeFloors` in the wrong place. Affected every feature, not just new ones. |
| USD anchor deadlock (both streams) | The anchor needed a ratio and a ratio was not published without an anchor. It self-healed on the next poll, so it looked like "streaming takes a minute to start" rather than a bug. |
| One bad pool address killed a chain's swap data | `eth_getLogs` rejects the whole filter rather than skipping a bad entry, and DexScreener returns 32-byte pair ids on at least one chain. Every address now passes `isEvmAddress` first. |
| New env vars never reached the container | Compose lists variables explicitly, so `DASHBOARD_USERS` and every `*_WS_URL` were silently absent — which read as "password sign-in is not configured" and no streaming at all. |
| A websocket alone did not enable streaming | Identifying a pool is an HTTP read, so `*_RPC_URL` is required too. Setting them also took whale detection from one chain to four. |
| Scrypt hashes broke the deploy | `deploy.sh` sources the env file, and `scrypt$salt$hash` expanded as shell variables. The separator is now `.`. |
| Deploy readiness check gave false failures | It grepped the last 300 log lines for a startup message; a busy bot scrolls that away in a minute. It now asks Docker for container health. |
| Alerts posted silently | `pingOn` defaults to high priority and no mention target was configured, so `mentionsFor()` returned nothing regardless of priority. Later reverted at request — alerts post without tagging. |
| Signal intake client would have followed a login redirect | The intake's dashboard 307s an unauthenticated POST to `/login`, and `fetch` forwards the body on a redirect by default — a stale deploy would have silently posted a live signal into an HTML page and logged it as accepted. Caught by testing against the real endpoint before relying on it; fixed with `redirect: 'manual'`, never in production. |

---

## Still open

- **Helius key.** Solana streaming runs on a public endpoint today, which is
  rate-limited and laggier. Ash's $49/month Developer plan replaces it; the
  strategic-scalp key is spent (`max usage reached`).
- **Call Tracker is not switched on.** It defaults off and needs enabling in
  whichever channel Rick posts in.
- **Robinhood Chain has no websocket** on its public RPC, so six watched coins
  stay at poll speed. Worth asking who FOMO uses for that chain.
- **Rate limiting wants a longer look.** 429s are at zero since the budget change,
  but that has only been observed over minutes.
- **Streamed volume engine.** Volume and trade counts still come from the
  aggregator's rolling windows. True discrete buckets from the swap stream would
  replace them — the last piece where polling still shapes a detector.
