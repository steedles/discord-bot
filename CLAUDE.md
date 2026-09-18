# discord-bot

Crypto trading Discord bot: per-channel features (market lookup, price alerts,
launch scanner) plus a web dashboard. Solana and EVM.
TypeScript (ESM), discord.js 14, Fastify, MongoDB, pnpm.

Docs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
[docs/FEATURES.md](docs/FEATURES.md) · [docs/DASHBOARD.md](docs/DASHBOARD.md) ·
[docs/VOLUME-MONITOR.md](docs/VOLUME-MONITOR.md) ·
[docs/SOLANA-STREAMING.md](docs/SOLANA-STREAMING.md) ·
[docs/CHANGELOG.md](docs/CHANGELOG.md)

## Commands

```bash
pnpm dev              # tsx watch
pnpm typecheck        # tsc --noEmit  (run before suggesting a commit)
pnpm build            # tsc + copy dashboard assets into dist/
pnpm commands:deploy  # register slash commands with Discord
pnpm smoke [tokens…]  # hit the live data providers, no Discord/Mongo needed
pnpm brief <tokens…>  # render a Token Brief as terminal text
pnpm ta <token> [n]   # replay the trend detector over a coin's 1m chart
pnpm batch-check <chain> <addr…>  # count the DexScreener requests one poll costs
pnpm alert-preview    # render monitor alerts as terminal text, from fixtures
pnpm help-preview [feature|all]  # render /help as terminal text
pnpm chart-preview <token|demo> [out.png]  # render a chart card to a PNG
pnpm store-check      # prove the candle store skips requests (needs local Mongo)
pnpm test             # vitest, detector logic only - no network, no Mongo
```

`pnpm smoke` is the fastest way to tell whether a problem is our code or an
upstream API.

Local MongoDB: `docker compose -f docker-compose.dev.yml up -d` (port **27020** —
27017 is taken by another project on this machine and requires auth).

## The feature system

This is the core abstraction. **Read `docs/FEATURES.md` before adding or
changing a feature.**

- A feature is declared once in `src/features/definitions/` as a
  `FeatureDescriptor` with a **declarative settings schema** and a `help` block,
  then registered in `src/features/registry.ts`. That is the whole integration.
- The dashboard, its API, the settings validator, `/feature` and `/help` are all
  **generic over the registry**. There is no per-feature code in any of them —
  do not add any. If something cannot be expressed in the schema, extend the
  schema types rather than special-casing a feature. `FeatureHelp` is what that
  rule looks like in practice: `/help` needed longer prose than `description`,
  so the descriptor grew a field rather than the command growing a switch.
- Config is rows of `(guildId, featureId, channelId) → { enabled, settings }`.
  Resolution is *channel row → server-wide row → defaults*, and a channel row
  **replaces** the server-wide row rather than merging field-by-field.
- Commands gate with `gate(interaction, featureId)` from `src/discord/gate.ts` —
  the single place that answers "is this on in this channel". Workers use
  `listEnabledPushInstances(featureId)`.
- Workers read settings at **action** time, not creation time, so admin changes
  affect things already in flight.

## Non-obvious constraints

**Never query DexScreener's `/tokens/{a,b,c}` endpoint with many addresses.**
It caps the response at 30 pairs *in total*, so 20 addresses come back with
roughly one arbitrary pool each. Use `getPairsForToken` (single address) or
`getPairsForTokens` (parallel, one request per token). Getting this wrong
silently degrades price accuracy rather than erroring.

**Batching by *pair* address is safe, and is how the monitor affords its poll.**
`/latest/dex/pairs/{chain}/{…30 pool addresses}` returns exactly the pools named
- not a capped sample - so `trustedPairs` still sees a token's whole pool set and
the price consensus survives. `fetchSnapshots` therefore asks the token endpoint
only to *discover* a token's pools (per token, every `POOL_SET_TTL_MS`), and
re-reads those pools in bulk on every poll in between: measured on the live
watchlist, 30 tokens cost 12 requests a poll instead of 30. Two traps in the
same family: `/tokens/v1/{chain}/{…}` returns **one pool per token**, so it is
fine for discovery (a new launch has one pool) and never for pricing; and every
batched endpoint takes **at most 30 addresses**, with the 31st silently missing
from a 200 rather than erroring.

**Solana pool addresses are case-sensitive.** They are base58, so a batched pair
request must carry them exactly as the upstream spelled them. EVM chains return
a different case than they were given, so lookups are lowercased and the
*request* is not - `fetchSnapshots` keeps both forms deliberately.

**Always price through `selectPricePair()`, never `bestPair()` alone.** Deepest
pool is not the same as correct price — tokens routinely have a deep pool
quoting orders of magnitude off. `selectPricePair` takes the median across pools
as consensus and drops anything more than 3x away.

**Ticker lookups can be wrong and must say so.** `resolveToken()` returns
`verified: false` when a token was matched by fuzzy search rather than an address
or the pinned registry. Any user-facing reply built from an unverified match has
to show the contract address and flag it.

**Adding to `known-tokens.ts` requires verification, not memory.** The token
must trade as a *base* token on the listed chain with a matching symbol and real
liquidity. Ethereum USDT, for example, does not qualify — it only ever appears
as a quote token.

**Token Brief depends on a privileged intent.** `ENABLE_MESSAGE_CONTENT=true`
makes the client request `MessageContent`, which Discord refuses unless the
developer portal grants it - and that refusal kills the whole login, not just
the feature. When touching intents, remember the failure mode is a dead bot, and
that `src/index.ts` translates `disallowed intents` into an actionable message.

**Never parse another bot's embed layout.** `src/discord/token-extract.ts`
sweeps all message text for address-shaped strings and chain-bearing links, then
lets DexScreener confirm. Rick's format is undocumented and changes; a layout
parser would rot. Add link shapes to `URL_PATTERNS`, nothing else.

**Minute candles are not minutes.** GeckoTerminal emits a candle only for
minutes that traded, so a quiet pool returns 150 "1m candles" spanning most of a
day. Any indicator over those is arithmetically fine and describes nothing.
`cadence()` measures real density and `detectTurn` refuses above
`MAX_GAP_RATIO`. Related: chart pools are chosen by *volume* (`busiestPair`),
never by depth - `selectPricePair` answers a different question.

**Rate limiting is not failure.** The candle feed allows ~30 requests/minute for
the whole bot. `CandleRateLimitError` exists so the tracker can tell "try again
shortly" from "this pool is dead"; treating them alike retires every healthy
tracker after one busy stretch.

**A 429 is never retried.** It means the pace was already wrong, so asking again
spends two more requests to learn the same thing while every other caller is
queued behind the same bucket - the retry storm *is* the outage. The correction
belongs to the rate: `fetchJson` throws, and tells the limiter, which cuts its
sustained rate by a quarter and creeps back 5% a minute once the endpoint goes
quiet. So the configured `DEX_PAIRS_PER_MINUTE` is a ceiling to approach, not a
budget to spend; `/monitor status` shows the throttled rate when it is below it.

**An alert's sentences are restatements, never conclusions.**
`src/monitor/detect/context.ts` turns two measured deltas into one plain line -
"the pool is holding while price came off" *is* liquidity down 2% against market
cap down 34%, in words. Nothing there may infer, predict or score. Two rules
follow the same shape as everything else: both figures must be present or the
line is absent, and the footer names the span **actually covered** by the
readings behind it, never the window that was asked for. `flow` is the line
nothing built on aggregate data can write - it counts real transactions from the
whale sources, so a chain with no per-transaction source stays silent rather than
dividing volume by a trade count.

**Direction is a setting, not a rule, where the detector does not own it.**
Trending already requires rising price, Call Tracker only fires upward and Level
Break has `onFall`/`onRise` - those are properties of what the detector measures.
Volume Spikes had no direction at all, because a spike is a fact about volume and
heavy selling is also news; it now takes a `direction` setting defaulting to
`both`, so no existing channel changes behaviour. Up-only judges price over the
*same five minutes* the volume spiked in, and a **missing** price change is
refused rather than treated as flat - otherwise "up only" quietly becomes "up, or
nobody checked".

**Axiom links take a pool, never a mint.** `axiom.trade/meme/<addr>` wants the
**PumpSwap pool** for a graduated token or the **pump.fun bonding-curve PDA**
before that (memefun's `axiomMint`/`deriveBcPda`). We link it only for
`dexId === 'pumpswap'` pairs, using the pool address DexScreener already gave
us: deriving the PDA needs ed25519 curve maths and therefore a Solana SDK, in a
codebase that decodes pool accounts by hand to avoid one. Everything else gets no
Axiom link rather than a guessed one - `dexId` is the signal, not a `pump` suffix
on the mint, because PumpSwap pairs exist with neither. GMGN covers **only**
solana/ethereum/bsc/base, so Robinhood Chain has no GMGN link; Jupiter is Solana
only and takes the mint. GMGN and Axiom both sit behind Cloudflare and answer a
scripted request with 403 whatever the path, so neither can be smoke-tested by
HTTP - they were confirmed from a real indexed URL and from working code.

**Candle requests can be skipped, never made cheaper.** GeckoTerminal's OHLCV
endpoint returns its newest 150 or nothing - there is no "only what I am
missing" parameter, so a pool last seen thirty minutes ago still costs one full
request. `src/market/candle-store.ts` therefore exists to skip *whole* requests
and to survive a restart, not to fetch partial ranges. Three rules it runs on:
freshness lives in `candle_pools` because it cannot be read off the candles
themselves (a gap means "quiet pool" or "nobody asked" and the rows cannot tell
you which); the merge is capped at `CANDLE_LIMIT` so a long-lived pool cannot
quietly hand a detector a longer series than it has always had, which would
change how its indicators seed; and a refused fetch may fall back to stored
candles **only for callers that opt in** - a chart half an hour behind is worth
having, while a trend detector judging the newest closed bar off stale candles
announces a cross that may already have un-crossed.

**Logs outlive the container, because Docker's do not.** `docker compose up
--build` destroys the logs of the container it replaces - which cost nineteen
hours of chart diagnostics on the one deploy that was meant to be followed by
reading them. `LOG_DIR` adds a dated file on a named volume alongside stdout,
pruned after 14 days by filename rather than mtime (an append-only file's mtime
is the last time anything was logged, not the day it covers).

**A chart is evidence or it is not attached.** `src/monitor/chart-card.ts` gives
an alert a chart on exactly two grounds: the alert is about a **level** the chart
can draw (the high Dip Hunter measured, the level Level Break crossed, the price
a call was made at, a price alert's target), or the alert is a claim about the
**shape of the series itself**, which is what a trend turn is. Volume Spikes gets
none - the spike is in volume, the renderer draws no volume panel, and a price
chart beside a volume alert implies a claim about price nobody measured. Three
silent no-chart paths are all normal and none may cost the alert: no rail,
`supportsCandles` false for the chain, or the candle budget is spent.

**A sparse series gets no chart, on any chain.** Candles are plotted by *index*,
so 150 "one-minute candles" spanning four days draw identically to 150
consecutive minutes - a picture that misrepresents time however honest the label
is. `renderCard` measures real density with `cadence()` and refuses above
`MAX_CHART_GAP_RATIO`, which is looser than the trend detector's bar because a
chart only has to be a fair picture while an EMA has to be arithmetic. The footer
always names the span actually covered, never the nominal interval. This is a
property of the *pool*, not the chain: a busy Robinhood token charts cleanly at a
1.03 gap ratio while a dead one on any chain does not.

**The renderer draws only positive prices.** `src/analysis/chart.ts` is a port of
money-maker's `chart.py` - a framebuffer, a 5x7 bitmap font and a hand-rolled PNG
encoder, so there is no native module to build in the Dockerfile. It filters
non-positive candles before scaling, because a negative low drags the axis below
zero and renders a clean, readable, entirely wrong picture with a `$-106.4K`
axis: plausible output rather than an error, the same failure as a wrong pool
offset. The y-axis reads in market cap by multiplying through a supply derived as
`marketCapUsd / priceUsd`; absent either, it stays in price rather than guessing.

**Level breaks come off a fixed ladder, never a fitted one.** `detect/level.ts`
alerts on 1-2-5 round market-cap levels chosen before the fact. A "support level"
derived from where price previously turned would always find something, and
naming that a level is the same invention as a hand-rolled risk score - so a fall
from $29.71M to $28.32M crosses nothing and says nothing. The crossing is
measured against the *most recent* prior reading, because a crossing is an event
between consecutive observations; comparing against two hours ago would re-report
a level the token crossed long ago.

**A brief only says what a number supports.** `src/analysis/brief.ts` turns
market and holder figures into sentences. Nothing in it may be inferred,
estimated or rounded into a claim - if a provider did not answer, it goes under
*Nobody checked*. Rick prints things our providers do not have (wallet age,
sniper detection); approximating those is the same failure as inventing a risk
score. The vendor's findings and ours also stay in separate lists so the reader
can see when they disagree.

**A missing liquidity figure is not a zero.** DexScreener returns
`liquidity: null` for pools it cannot value - every pump.fun bonding curve
before graduation among them - and `?? 0` turned that into the strongest claim
`src/risk/market.ts` can make: a seven-minute-old Solana token with $69k traded,
588 holders and 1,069 buys was headlined **POOL IS EMPTY - you would not be able
to sell**. `assessMarket` now separates *unmeasured* from *zero*: unmeasured is a
`warn` naming the gap (and naming the bonding curve, from `dexId`, only where
the venue says so), `untradeable` stays false, and both volume-against-liquidity
checks are skipped because they have no denominator. A real drain reports
`{usd: 0}`, which is a measurement and still fires everything. Deriving a figure
for a curve is not the fallback: pump.fun's *virtual* reserves are seeded with
~30 SOL that is not depth, and the real ones need the curve PDA, which needs a
Solana SDK this codebase decodes accounts by hand to avoid.

**A vendor's holder count is as old as its last index.** GoPlus reports
`holder_count` from whenever it last looked at a contract, which for a token
launched this week is routinely the hour it appeared - BOMB on Ethereum read
**2 holders** against a real 89, because GoPlus had seen it once with the supply
still in the contract. honeypot.is derives its count from transfer analysis
performed for the request, so on the three chains it covers (ethereum, bsc,
base) its number wins; `checkEvmChain` spreads honeypot's metrics last for
exactly this reason. Where it has no coverage, GoPlus stands alone rather than
the count going missing. The trap is the *second* figure: GoPlus's per-wallet
breakdown comes from the same response as its count, so when the two vendors
disagree by more than `sampleIsStale` allows the breakdown is suppressed with a
note - printing "89 holders, top 5 hold 2%" would combine one vendor's present
with another's past into a sentence neither of them said.

**Never invent a risk score.** The number always comes from a vendor: RugCheck
on Solana, honeypot.is on ETH/BSC/Base, GoPlus banding elsewhere. An earlier
version summed hand-picked weights over GoPlus booleans and rated a drained
token "low 10/100" because absent fields scored as clean. Two rules follow:
absence of data is `unknown`, never `low`; and pool health goes in
`report.tradability`, never into `score`.

**Rolling windows are not buckets.** DexScreener's `volume.h1` read at 12:00 and
at 12:15 overlap by 45 minutes. Nothing that needs discrete intervals -
"consecutive windows of rising volume" - can be read off the API; it has to be
differenced from our own stored snapshots (`src/monitor/history.ts`). The same
trap applies to averaging `m5` readings taken a minute apart: they share four of
their five minutes, so `measuredBaseline` discards samples under five minutes
apart rather than counting the same trades repeatedly.

**Whale alerts need a per-transaction source or they do not fire.** DexScreener
reports trade *counts*, never individual trades. Solana whales come from a Helius
webhook, EVM whales from Uniswap V2/V3 `Swap` logs over viem; a chain with
neither reports `whaleSupport: 'unsupported'` and stays quiet. Never compute a
swap size as 5m volume over 5m trade count - that is an average trade, and
reporting it as a transaction is the same failure as inventing a risk score.

**The volume monitor is one worker and every push feature in
`MONITOR_FEATURES`.** `volume-spikes`, `whale-buys`, `trending`, `dip-hunter`,
`level-break`, `pvp-coins` and `vamp-watch` share a watchlist, a poll and a
snapshot write. Running a worker each would multiply the request cost to learn
identical facts against the rate limit that caps how many tokens can be watched
at all. Iterate `MONITOR_FEATURES` rather than re-listing the ids - the count in
a sentence like this one is exactly what goes stale.

**A PvP coin is three measurements, never a verdict.** `detect/churn.ts` fires
on turnover (`1h volume / market cap`), a matched book (buys and sells within a
few percent by count) and price flat or down over that same hour. All three read
from `h1` deliberately, so one sentence describes one stretch of time; the
rolling-window trap does not bite because a single reading divided by the market
cap beside it needs no differencing. All three legs are required - a missing
`txns.h1` has not been shown to be two-sided, it has not been checked. The
feature's *name* carries the interpretation, the headline carries the arithmetic,
the same split as every other detector.

**Vamping is about the copy, not the ticker.** Copy tickers are minted
constantly and nearly all of them are an empty pool, so `detect/vamp.ts` alerts
on a newer same-ticker mint only once it has real depth, a real trade count and a
real hour of volume *and* is out-trading the original. Those gates sit on the
copy because `passesGates` only ever sees the watched token - a channel hearing
about its own coin being drained would otherwise gate the original and let the
copy through unfiltered. Four refusals keep the claim honest: both pool creation
times must be known (which one is the copy rests entirely on that), same chain
only, the original must have traded (a ratio needs a denominator, and an absent
one cannot be told from a quiet one), and tickers of two characters or fewer are
collisions by default. Intent is never stated; whether the *names* match as well
as the tickers is, so the reader can judge the pairing.

**Ticker search is discovery, and the only alert that costs requests.**
`providers/ticker-search.ts` is capped at four searches a *minute* - a rate, not
a per-cycle count, because `MONITOR_POLL_SECONDS` is a setting and the pairs
bucket is not, so "four a cycle" is twelve a minute on the live 20-second poll.
It runs only while some channel has Vamp Watch on, and is read from cache on the streamed path -
never fetched there, or one swap would fan out to the network. `/latest/dex/search`
caps at thirty pairs across every match, so its volume figures rank candidates
and never price them: each survivor is re-read per token, because when the
watched token is the copy an understated sample lands on the *denominator* and
inflates the ratio. The cost of the cap is real and is logged rather than
silent - on a 120-token watchlist a ticker is re-checked about every half hour,
not every cycle.

**A drawdown is only as old as the history behind it.** Dip Hunter takes its
high from our own recorded snapshots, because the upstream only reports "against
N hours ago" and a token that ran to 3x and gave it all back reads as flat on
that measure. A token added ten minutes ago genuinely can be 60% off its high -
but it is a ten-minute high, so `detectDrawdown` refuses below
`minCoverageMinutes` and the headline always names the span actually measured,
never the one configured.

**A token that arrived because it was moving needs a baseline from before it
moved.** Calls and discovery both add coins *because* something is happening, so
the ordinary baseline is taken mid-pump and the coin has to beat itself to
register. `excludeCurrentWindow` switches the estimates to differences between
the trailing windows - `(h1 - m5) / 11` is the 55 minutes before this one,
`(h6 - h1) / 60` the five hours before that. Subtraction is the one arithmetic
overlapping windows do support. A difference at or below zero means the entire
hour happened in the last five minutes, which is no baseline rather than a small
one, and the detector says so instead of dividing by a crumb. Manual adds keep
the ordinary baseline.

**A call is measured from the call, not from a baseline.** Call Tracker answers
"would following that call have made money", so every multiple is against
`priceAtCall` - which is why it is a separate feature from Volume Spikes rather
than a threshold on it. Only upward multiples fire: nobody wants tagging in their
own bad call. Attribution follows the same honesty rule as everything else -
a bot's call is credited to whoever it replied to, and to nobody at all when that
cannot be worked out, because guessing at a name is worse than leaving it out.

**A threshold that depends on size goes in a `bands` field, not in code.** The
schema owns the shape, so the dashboard renders the editor and the validator
enforces it - the same rule as everything else: extend the schema types rather
than special-case a feature. `bandValue` returns undefined for an unknown size
so the caller can skip the rule instead of guessing a band.

**Called tokens hold a watchlist slot on sufferance.** The watchlist is a fixed
request budget, so `source: 'called'` carries a short expiry *and* a retirement
sweep (`callRetirement`). Two guards matter: nothing is judged before
`stuckMinutes`, because a coin called at launch has no market cap or volume yet
by nature; and a *missing* snapshot is never treated as a dud, because that is a
failed poll rather than a dead coin.

**Solana pool layouts are verified, not remembered.** Every offset in
`solana-amm.ts` was confirmed against live mainnet accounts, and the captured
bytes are fixtures so the decoders are tested against what a validator served. A
wrong offset does not throw - it prices a token orders of magnitude off and a dip
alert fires on it. Two traps found this way: **Meteora DLMM must be priced from
its active bin, never its reserves** (concentrated liquidity made the reserve
ratio 600x wrong), and **pump.fun vaults are Token-2022**, so an owner check that
knows only `Tokenkeg…` rejects a real vault.

**A streamed price is half a snapshot.** A swap event carries the pool - price,
and on V2 its reserves - and nothing else: no 24h volume, no trade counts, no
pair age. `applyStreamedPrice` therefore lays the live figures over the last
polled reading rather than publishing on its own, and refuses if that reading is
more than `MAX_BASE_AGE_MS` old. Polling does not become redundant when
streaming lands; it becomes the source of everything a swap cannot say.

**The stream has no dollars.** A pool quotes its own ratio, so USD comes from
anchoring that ratio to the aggregator's price at each poll (`anchorQuoteUsd`).
Until an anchor exists the streamed price is held rather than published - a
ratio printed as a dollar figure is the same failure as inventing a risk score.

**One malformed pool address kills a whole chain's swap data.** `eth_getLogs`
rejects the entire filter rather than skipping the bad entry, and DexScreener
returns 32-byte pair ids on at least one chain. Everything address-shaped goes
through `isEvmAddress` before it reaches a filter or a subscription.

**All DexScreener traffic goes through `src/market/limiter.ts`.** Retry-on-429 is
not rate limiting: by then the request is spent, the backoff stalls the caller,
and everything else keeps hammering. New upstream calls take a `limiter` option
on `fetchJson`, and the buckets are module-level singletons because the budget
belongs to the whole bot, not to one worker.

**Nothing outside `src/monitor/providers/` may import `DexPair`.** Detectors see
only `MarketSnapshot` and `WhaleSwap`. That is what makes swapping in Birdeye or
adding a chain one new file rather than an edit to the alert logic - and what
keeps `src/monitor/detect/` pure enough to test against fixtures.

**The Helius webhook rides on the dashboard's listener.** The bot has one public
origin, so `/webhooks/helius` mounts on the dashboard's Fastify instance - which
means Solana whale alerts need the dashboard running. It refuses to mount without
`HELIUS_WEBHOOK_SECRET`, because an open endpoint would let anyone post a
fabricated whale buy into a trading channel.

**The dashboard fails closed.** Missing `DISCORD_CLIENT_SECRET`,
`SESSION_SECRET` or `DASHBOARD_URL` means it does not start and the bot runs
without it. Never add a "skip auth" path. There are two ways in - Discord OAuth,
scoped to guilds where the user holds Manage Server, and `DASHBOARD_USERS`
login/password accounts (email or bare username), which reach every guild the
bot is in. An empty
`DASHBOARD_USERS` rejects every password attempt rather than admitting anyone,
and passwords are stored as scrypt hashes, never plaintext.

**The bot never touches the host; the host polls the bot.** The Setup tab's
env changes and restarts go through `src/ops/` as *jobs* that
`deploy/homelab/ops-runner/ops-runner.py` (a systemd `--user` service on the
homelab) claims over loopback with `OPS_RUNNER_SECRET`. No Docker socket in any
container, no SSH key on the bot, and nothing the web sends is ever executed -
a job is one of two types whose arguments are checked against allowlists
(`src/ops/env-keys.ts`, restated in the runner because the runner is the
process with write access to the file holding `DISCORD_TOKEN`). Adding an env
key means adding it in both places. The values in an `apply-env` job live in
the bot's memory until claimed and in `.env.homelab` afterwards - never in
Mongo (`ops_jobs` holds key names), never in a log line, never in a response.
Slash commands are the other half of "nobody at a workstation": the bot
registers them per guild on every boot and on `guildCreate`
(`src/discord/register-commands.ts`), so never also register globally - Discord
shows both sets.

**Static dashboard assets need `scripts/copy-public.mjs`.** `tsc` only emits JS,
so `pnpm build` copies `src/web/public/` into `dist/`. The Dockerfile must copy
`scripts/` for this to work.

**A redirect is a refusal, not a destination.** `src/integrations/signal-intake.ts`
posts to a private trading intake sitting behind its own dashboard auth, and a
307 from that middleware preserves method and body - `fetch`'s default would
happily forward the launch signal's POST body into an HTML login page and read
the 200 back as acceptance, turning a misconfigured endpoint into a silent
false success. It sends `redirect: 'manual'` and treats any 3xx as a refusal
naming the `Location` header, the same as a 400. Any outbound POST to a service
that might sit behind an auth gate needs this, not just this one.

**A high-priority alert is mirrored to Telegram, never formatted for it.**
`src/integrations/telegram-alerts.ts` sends every `Trigger` graded
`priority: 'high'` as plain text with no `parse_mode` - a token's symbol or
name is upstream data this codebase does not control, and getting
MarkdownV2/HTML escaping wrong silently drops or breaks the message. It
follows the same non-negotiable as `signal-intake.ts`'s outbound POST: fired
in parallel with the Discord send and never awaited, so an outage on
Telegram's side can never cost or delay the alert itself.

**Ping targets are read through `pingFor()`, never assembled ad hoc.**
`src/discord/mentions.ts` is the one place that turns a channel's settings into
a Discord mention line, used by the volume monitor, the launch scanner, Call
Tracker and Price Alerts alike - before it existed, `src/monitor/worker.ts` and
the launch scanner each built their own version, and a change to one silently
did not apply to the other. The `mentionRoles` picker wins whenever it holds
anything; the older single `mentionRoleId` string is read only when the picker
is empty, so a channel configured before the picker existed keeps pinging
without the admin re-entering anything - dropping it silently on upgrade would
be the ping quietly turning itself off. `priority` is passed only by features
that grade their alerts, so `pingOn` never holds back a launch or a price alert
that has no low-priority version to withhold. And mentions are always listed
explicitly in `allowedMentions`, so a message can only ever ping exactly who
the settings name, never an `@everyone` that found its way into pasted text.

**"List every token an address holds" needs a different call per chain
family, and on EVM, a different API per chain.** Solana answers it in one
RPC method - `getTokenAccountsByOwner`, called twice (once per SPL/Token-2022
program, since a mint can live under either and the call filters by one
program id at a time). EVM has no such call at all; `src/market/blockscout.ts`
exists because a handful of chains happen to run a free, keyless Blockscout
instance with exactly this endpoint - confirmed live per chain against
`chains.blockscout.com`'s own registry and a real wallet, not assumed from
one chain working. BSC has none, and its Etherscan-family equivalent
(`addresstokenbalance`) is gated to a paid Standard plan and above - there is
no free "list everything" call for it, so `HOLDINGS_EVM_CHAINS` leaves it out
rather than silently returning nothing for it forever.

**Tracked Wallets is imported, never inferred.** An earlier version (Wallet
Scout) tagged a wallet as worth following from one signal - buying early into
a fresh pump.fun launch - and was dropped 2026-08-25 as too weak a heuristic
to build a reputation on. `tracked_wallets` now holds only what
`pnpm import:wallets` (`src/scripts/import-tracked-wallets.ts`) reads from a
CSV built somewhere that actually vets wallets (e.g. strategic-scalp's own
`tracked_wallets` export) - nothing in this codebase computes a score, so
this bot has no code path that could invent one either. A row with no `score`
(some are cohort-tagged rather than trade-scored, e.g. the moonshot
frontrunner cohort) is absent, not zero - the same unknown-is-not-low rule
every vendor score in this codebase follows. Getting this wrong is easy in a
specific way: setting an optional field to `undefined` on the way into
`$set` does **not** leave it unset - the MongoDB driver serialises an
explicit `undefined` to BSON `null`, which is a stored claim of "measured as
null" instead of "this column wasn't in the source file". The import script
guards every optional column for exactly this reason: a blank cell skips the
assignment rather than writing `undefined`.

## Conventions

- ESM: every relative import ends in `.js`, including from `.ts` files.
- Env access goes through `src/config.ts` only.
- Comments explain *why*, not what. The codebase leans on a handful of
  non-obvious upstream behaviours — keep those documented at the call site.
- The dashboard frontend is deliberately bundler-free vanilla JS. Do not add a
  build toolchain for it.
