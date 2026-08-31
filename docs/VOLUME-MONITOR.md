# Volume Monitor

Watches a list of tokens across Solana, Ethereum and BNB Chain (plus every other
chain in `src/market/chains.ts`) and posts to Discord when something unusual
happens. Read-only: it never trades, holds keys, or touches a wallet.

Six alert types, each a separate feature with its own channel and its own
thresholds:

| Feature | ID | Fires when |
|---|---|---|
| Volume Spikes | `volume-spikes` | 5-minute volume clears a multiple of the token's own baseline |
| Whale Buys | `whale-buys` | one swap exceeds a USD threshold |
| Trending Momentum | `trending` | several consecutive windows of rising volume *and* rising price |
| Dip Hunter | `dip-hunter` | price falls a set percentage off its own recent high, then again when it recovers |
| PvP Coins | `pvp-coins` | the market cap turns over repeatedly in an hour, buys and sells matched, price going nowhere |
| Vamp Watch | `vamp-watch` | a newer token under the same ticker is out-trading a watched one, with real depth behind it |

---

## Quick start

1. **Turn it on.** `MONITOR_ENABLED=true` in `.env` (the default). Restart.
2. **Pick channels.** In the dashboard, or `/feature enable` in the channel:
   enable `volume-spikes` in `#volume-spikes`, `whale-buys` in `#whale-buys`,
   `trending` in `#trending`, `dip-hunter` in `#dip-hunter`, and the same for
   `pvp-coins` and `vamp-watch`. Every one of them defaults to off — a bot
   posting somewhere unasked is never acceptable.
3. **Add tokens.** `/watch add WIF` or `/watch add <contract> <chain>`. Needs
   Manage Server.
4. **Check it.** `/monitor status` shows data source health, watchlist size and
   the request budget.

Spike alerts work immediately. Momentum needs the bot to have been watching a
token for a few windows first — see [Why momentum needs
history](#why-momentum-needs-history). Whale alerts need the extra setup below.

---

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `MONITOR_ENABLED` | `true` | Master switch. Off means the worker never starts. |
| `MONITOR_POLL_SECONDS` | `60` | Watchlist poll interval. Minimum 5. |
| `MONITOR_MAX_TOKENS` | `120` | Hard cap on the watchlist. See [Request budget](#request-budget). |
| `MONITOR_STATUS_CHANNEL_ID` | – | Operator channel for outage reports. Blank logs only. |
| `HELIUS_API_KEY` | – | Solana whale detection. |
| `HELIUS_WEBHOOK_SECRET` | – | Shared secret for the webhook. **Required** for Solana whales. |
| `HELIUS_WEBHOOK_URL` | `<DASHBOARD_URL>/webhooks/helius` | Override only if the dashboard is not the public origin. |
| `ETHEREUM_RPC_URL` | – | Ethereum whale detection. |
| `BSC_RPC_URL` | – | BNB Chain whale detection. |
| `BASE_RPC_URL` | – | Base whale detection. |
| `ROBINHOOD_RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` | Robinhood Chain whale detection. Keyless public endpoint, so it works out of the box. |

None of the whale variables are required. Without them, spike and momentum
alerts run on every chain and whale alerts simply report as unavailable for the
chains that lack a source — `/monitor status` names which and why.

---

## Data sources

### Market data — DEX Screener, every chain

Free, no key, ~300 requests/minute for pair endpoints and ~60/minute for the
discovery feeds. All calls go through a shared token-bucket limiter
(`src/market/limiter.ts`) so the whole bot draws on one budget rather than each
worker discovering the limit for itself.

One request per token, never a batched address list. The batch endpoint caps its
response at **30 pairs in total**, so asking for 20 addresses returns roughly one
arbitrary pool each — which silently degrades every number built on it rather
than erroring.

Volume and transaction counts are summed across every pool a token trades in;
price and liquidity come from the single pool `selectPricePair()` picks. Depth
that sits in three separate pools is not depth one position can use.

### Solana whales — Helius webhooks

Swaps are pushed, not polled. Polling Solana for individual transactions means
asking for signatures per account and then fetching each one — slow, expensive,
and always behind.

### EVM whales — Swap logs over RPC

DEX Screener has **no public per-transaction endpoint**. It reports how many
trades happened, not what any one of them was. So EVM whale detection reads
Uniswap V2/V3 `Swap` events straight from a node with viem, and prices them as
`token amount × our last quoted price`.

The tempting shortcut — 5-minute volume ÷ 5-minute trade count — produces an
*average* trade, not a trade. Four $12.5k trades and one $47k buy against three
dust sells give the same number, so the bot would be reporting whale buys nobody
made. It does not do this.

### Adding a chain or swapping a provider

Everything downstream of `src/monitor/providers/` sees only `MarketSnapshot` and
`WhaleSwap`. Nothing outside that folder imports `DexPair` or talks to Helius or
an RPC. Slotting in Birdeye or Moralis is one new file implementing
`ChainDataProvider`, plus a line in `registry.ts` — no detector changes.

Adding a chain that DEX Screener already indexes is one entry in
`src/market/chains.ts` and nothing else — the registry builds a provider for
every chain in it. **Robinhood Chain was added this way**, once each dependency
was checked against a live token rather than assumed:

| Dependency | Robinhood Chain |
|---|---|
| DEX Screener market data | Yes — `chainId: "robinhood"` |
| Public RPC for swap logs | Yes — `https://rpc.mainnet.chain.robinhood.com`, chain 4663, keyless |
| GoPlus risk data | Yes — chain id `4663` |
| Blockscout explorer | Yes — `robinhoodchain.blockscout.com` |
| GeckoTerminal candles | **No network for it** |

That last row is why `/track` refuses on Robinhood Chain: trend detection needs
minute candles and there is no feed. `supportsCandles()` already handles it with
a clear message. Volume spikes and momentum are unaffected — they are built from
our own DEX Screener readings, not from candles.

Use the same table for any chain you want to add. Every "yes" is a capability;
every "no" is something the bot must decline to do rather than approximate.

---

## Setting up Helius whale alerts

**Solana whale alerts need the dashboard running.** The webhook mounts on the
dashboard's Fastify listener, because the bot has exactly one public HTTPS origin
(the Cloudflare tunnel) and a second listener would need a second tunnel to be
reachable. Spike and momentum alerts are unaffected — they poll.

1. Get an API key at <https://dashboard.helius.dev>.
2. Generate a secret: `openssl rand -hex 32`.
3. Set both, plus a public `DASHBOARD_URL`:

   ```bash
   HELIUS_API_KEY=your-key
   HELIUS_WEBHOOK_SECRET=the-generated-secret
   DASHBOARD_URL=https://steedlescrypto.dohbelisk.com
   ```

4. Restart. **The bot registers the webhook itself** — it looks for one already
   pointing at its URL, creates one if there is none, and updates the subscribed
   address list every cycle to match the watchlist. There is nothing to click in
   the Helius dashboard.
5. Confirm with `/monitor status`: Solana should read `whales via push`.

Without `HELIUS_WEBHOOK_SECRET` the route refuses to mount at all. That is not
caution for its own sake: an unauthenticated endpoint here would let anyone who
found the URL post a fabricated $2M whale buy into a trading channel.

The subscription is capped at 100 addresses. Helius plans differ in what they
allow and this stays under all of them; a longer watchlist keeps spike and
momentum coverage for every token, since those poll and need no subscription.

### Setting up EVM whale alerts

Set an RPC URL per chain. Public endpoints work but rate limit hard — an Alchemy
or Infura free tier is the usual answer:

```bash
ETHEREUM_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/your-key
BSC_RPC_URL=https://bsc-dataseed.binance.org
```

Robinhood Chain needs nothing — its public RPC is the built-in default, so whale
alerts work there as soon as a token is on the watchlist.

After an outage the log sweep looks back at most 2,000 blocks. Missing the swaps
from a long outage is the correct outcome: a whale buy is news for about a
minute, and posting an hour-old one as if it just happened is worse than not
posting it.

---

## Tuning thresholds

Every threshold is a per-channel setting, editable in the dashboard or with
`/feature` in the channel you want to change. `/monitor config` shows where they
live; it does not edit them, because the settings schema already drives a
generic form and a second hand-written path to the same rows would drift.

Two channels can run the same feature with different rules — a strict
`#alpha-calls` and a loose `#degen-plays` — because a channel row replaces the
server-wide row rather than merging with it.

### Quality gates (every feature)

| Setting | Default | Notes |
|---|---|---|
| Minimum liquidity | $50k (whales $100k) | On the priced pool, not summed across pools. |
| Minimum pool age | 1440 min | Most rugs happen inside a day. 0 allows brand-new pairs and is much noisier. |
| Minimum trades in 5m | 10 (whales 0) | Volume from three trades is two people and a bot. |
| Minimum 24h volume | $50k | Filters liquidity parked with nobody trading. |
| Minimum holders | 0 (off) | Costs one vendor lookup **per alert**, not per token. |
| Per-token cooldown | 120 min | 30 for whales, 180 for momentum. |
| Alerts per hour | 12 | 8 for momentum. |
| Role to ping | – | Pinged **only** on high-priority alerts. |

Unknown data fails a gate rather than passing it. A token with no transaction
data does not clear a minimum-trades check, and a holder count no vendor will
confirm does not clear a minimum-holders check. Absence of data is unknown, never
fine.

### Volume Spikes

| Setting | Default |
|---|---|
| Spike multiplier | 5× |
| Minimum 5m volume | $15,000 |
| High-priority multiplier | 12× |

**The baseline is the median** of the token's `1h ÷ 12`, `6h ÷ 72` and `24h ÷ 288`
rates, plus the median of its own recorded 5-minute readings when there are at
least three non-overlapping ones.

A mean would let one distorted window set the bar. During a spike `h1` contains
the spike itself and is pulled up by it; `h24` is dragged down by a dead
overnight stretch. Either alone produces a threshold with nothing to do with the
token.

Recorded readings closer than five minutes apart are discarded rather than
averaged. At a 60-second poll, consecutive 5-minute readings share four of their
five minutes, so averaging fifty of them is averaging the same trades over and
over — and produces a confidently wrong number.

The minimum-volume floor is checked **before** the ratio. A 40× jump on $600 is
arithmetic, not a signal.

**Tuning:** too noisy → raise the floor before the multiplier; most false
positives are small tokens, not small ratios. Too quiet on a token you know moved
→ check `/monitor status` first, then the pool age and liquidity gates, which
reject far more than the multiplier does.

### Whale Buys

| Setting | Default |
|---|---|
| Minimum swap size | $10,000 |
| High-priority swap size | $50,000 |
| Buys only | on |

The USD figure is the on-chain token amount times our last quoted price, so it
can differ slightly from an explorer's. The alert says so in its own body.

Only fires on chains with a per-transaction source. `/monitor status` lists which.

### Trending Momentum

| Setting | Default |
|---|---|
| Consecutive windows | 3 |
| Window length | 15 min |
| Minimum price gain | 5% |
| Minimum volume gain | 20% |
| High-priority price gain | 25% |

#### Baselines for coins that arrived mid-pump

A coin added by `/watch add` is usually being watched *before* anything happens.
A coin added by the Call Tracker or by discovery is there **because** something
is happening - people post what is already pumping - so the baseline gets
measured while the thing being measured is under way.

For those, the estimates come from differences between the trailing windows
instead of the windows themselves:

| Estimate | Covers |
|---|---|
| `(h1 - m5) / 11` | the 55 minutes before the current one |
| `(h6 - h1) / 60` | the five hours before that |
| `(h24 - h6) / 216` | the eighteen hours before that |

This works because the windows are trailing and end at the same instant, so the
difference between two of them is the stretch between their edges. On a coin that
has run hard for an hour, the ordinary baseline reads 6.7x and stays under a 10x
threshold; the same coin against its pre-pump rate reads 90x.

If a difference comes out at zero or below, the whole hour happened in the last
five minutes. That is not a quiet baseline, it is no baseline, and the alert says
*"first significant volume against a flat baseline"* rather than inventing a
multiple.

### Why momentum needs history

The obvious implementation — read `volume.h1`, read `priceChange.h1`, call a
positive number momentum — measures one instant. It cannot tell three quarters of
steady climbing from a single spike sixty minutes ago that has been sitting in
the trailing window ever since. Consecutiveness is the entire signal, and
consecutiveness only exists across readings.

So the detector differences the bot's own recorded snapshots. `h1` is a rolling
window, so comparing it 15 minutes apart is not comparing two hours:
`h1(t) − h1(t−15)` is exactly *the last 15 minutes minus the 15 minutes that just
aged out*. A rising sequence says each quarter-hour outsold the one it displaced.

**Price must rise across the same windows.** Volume alone rises for reasons that
are not momentum: a second pool opening adds its whole history to the aggregate
at once, and a bot cycling inventory trades hard in both directions. Neither
moves the price up for three windows running.

A run with a hole in it is not a run. If any window boundary has no reading
within half a window, the detector returns nothing rather than reaching for a
reading that describes a different moment.

**Consequence:** a token added five minutes ago cannot trigger momentum until
enough history exists. That is correct, not a limitation.

### Dip Hunter

| Setting | Default |
|---|---|
| Drawdown to alert on | 50% |
| High measured over | 180 min |
| History needed first | 45 min |
| Recovery target | 10% |
| Wait for a recovery for | 360 min |
| High-priority drawdown | 70% |

Two alerts, one pair. The first fires when a watched token is far enough below
its own recent high. That arms a follow-up: when the price climbs back past the
recovery target it posts again and the pair closes. A dip that never comes back
is forgotten after **Wait for a recovery for**, and the token becomes eligible
for a fresh dip alert.

#### The high comes from our own readings

`priceChange.h1` answers "against the price sixty minutes ago", which is a
different question. A token that ran to 3x and gave it all back has an `h1` near
zero and a very real drawdown; the peak only exists in a series. So the high is
the maximum recorded snapshot price inside the window, current price included —
a token making a new high is 0% down, not stale.

#### It will not claim a window it has not watched

A token added ten minutes ago can be 60% off its high, but that high is ten
minutes old. Calling it a three-hour high would be inventing a fact, so the
detector refuses below **History needed first**, and every headline names the
span actually measured: *"62.5% below its 60m high"* when 60 minutes is all
there is.

#### Recovery is measured from the alert price

Not from the bottom. A bounce off the low means nothing while the low keeps
making new lows, and the alert price is what anyone acting on the first message
would have paid. The post-alert low is reported alongside it as a measurement,
never as the thing being compared against.

The follow-up ignores the cooldown and the hourly cap — it is the second half of
an alert the channel already had, and at most one exists per dip posted.

---

### PvP Coins

| Setting | Default |
|---|---|
| Minimum turnover | 3x |
| Maximum buy/sell imbalance | 15% |
| Maximum price change | +5% |
| Minimum 1h volume | $50k |
| High-priority turnover | 8x |

A "PvP coin" is trader shorthand for a token with no outside flow left in it -
the volume is the same people selling to each other, and the fees leak out the
bottom. That phrase is a judgement, and the alert does not make it. It states
three arithmetic facts about one reading, and the feature's *name* carries the
interpretation:

1. **Turnover** — `1h volume ÷ market cap`. Three times the entire cap traded in
   an hour is not accumulation.
2. **Two-sidedness** — buys and sells within a few percent of each other by
   count. A one-sided book is a token being bought or being dumped, which is a
   different event with a different name.
3. **Nothing to show for it** — price flat or down over that same hour.

Costs no extra requests: every figure is already in the poll.

#### Why every figure comes from the 1h window

Volume, transaction counts and price change all read from `h1`, one trailing
hour ending at the same instant, so the three facts describe the same stretch of
time and can be stated in one sentence. The usual rolling-window trap does not
apply — it bites when consecutive *readings* of an overlapping window are
combined, and this is one reading divided by a market cap measured beside it.

All three legs are required. A token with no `txns.h1` has not been shown to be
two-sided, it has not been checked, and admitting it would turn the balance test
into "balanced, or nobody looked".

The age and liquidity floors default lower than the spike channel's, because
this describes tokens that are hours old by nature. A 24-hour minimum would
leave the feature switched on and silent.

---

### Vamp Watch

| Setting | Default |
|---|---|
| Which side to hear about | Both |
| Volume ratio to fire | 1.5x |
| Minimum volume on the copy | $50k |
| Minimum liquidity on the copy | $25k |
| Minimum trades on the copy | 100 |
| Maximum age of the copy | 1440 min |
| High-priority ratio | 3x |

Somebody launches a *different* mint under a ticker that is already running, and
the copy starts taking the flow. Not the DeFi sense of a vampire attack on a
protocol's liquidity, and not a token migrating to a fresh pool — that is the
same mint and a different question.

**Which side** is a setting rather than a rule, because both are worth knowing
and they are different trades: a channel holding bags wants to hear its coin is
being drained, a channel trading the trenches wants the copy, because the copy
is often the one that runs. Either way the alert is about the token on the
*watchlist*, so the contract, links and gates in the message point at the coin
the reader is being shown; the other one is named in the body with its own
address and chart link.

#### Copies are constant, so existence is not the alert

A running coin collects a dozen namesakes in an afternoon and nearly all of them
are an empty pool and a hopeful ticker. Alerting on one being *minted* would be
a noise feed. Four things have to be true of the copy before the comparison is
even computed — real depth, a real number of people trading it, a real hour of
volume, and young enough that a shared ticker still means something.

Those gates sit on the **copy**, which the standard quality gates do not cover:
those apply to whichever token is on the watchlist, so a channel set to hear
about its own coins being drained would otherwise gate the original and let the
copy through unfiltered.

#### What it will not claim

Tickers collide honestly and constantly, so every claim is something measured:
which pool was created first, how far apart, what each traded in the last hour,
and whether the *names* match as well as the tickers — which the alert states
either way, so the reader can judge the pairing. Intent is not measurable and is
never stated.

Four rules keep that honest:

- **Both creation times must be known.** Which one is the copy rests entirely on
  which came second. Unknown means no alert rather than a guess.
- **Same chain only.** A matching ticker on another chain is usually a bridge or
  an unrelated project, and an hour of volume compared across two chains is not
  one audience.
- **The original must have traded.** The claim is a ratio, and an absent
  denominator cannot be told apart from a quiet one.
- **Tickers of two characters or fewer are ignored.** At that length a match is
  a collision by default.

#### The one feature that costs requests

Every other alert here is free once the watchlist has been polled. This one
needs a search per ticker, plus a confirmation request per candidate, against
the same DexScreener bucket that prices every alert in the bot. So it is capped
at **four tickers a minute**, oldest first, and only while some channel actually
has the feature enabled. A rate rather than a per-cycle count on purpose:
`MONITOR_POLL_SECONDS` is a setting and the request bucket is not, so "four a
cycle" would silently be twelve a minute on a 20-second poll.

The consequence, stated rather than discovered later: on a 120-token watchlist a
given ticker is re-checked roughly **every half hour**, not every cycle. Fine for an alert that plays out over hours; it does mean a copy
minted sixty seconds ago is not news here yet. Capping is logged, because a
silent cap reads as full coverage.

Discovery and pricing stay separate, as everywhere else in the codebase.
`/latest/dex/search` caps at thirty pairs across every match, so its figures are
a *sample* — used to learn which addresses exist under a ticker and to rank
them, never to price them. Each survivor is then read properly, one request per
token, so both sides of the ratio are measured the same way. Summing the sample
instead would understate a busy token by an unknown amount, and when the watched
token is the copy that understatement lands on the denominator and inflates the
alert.

---

## Call Tracker

A different shape from the other features: it is triggered by a message, not by
a poll. When a coin is called in a channel - by Rick, or by somebody pasting a
contract address - it goes on the watchlist automatically, is followed for a few
minutes, and is dropped again if it does nothing. If it runs, the channel that
called it hears about it with the caller tagged.

| Setting | Default |
|---|---|
| Whose calls to follow | Bots |
| Report at | 1.5x, 2x, 5x |
| Follow a call for | 10 min |
| Judge it after | 5 min |
| Drop it under | $20,000 market cap |
| Counts as no volume | banded by market cap (see below) |
| Ignore calls under | $5,000 liquidity |
| Calls followed per hour | 12 per channel |

### Measured from the call

Every multiple is against the price at the moment the call was seen, which is a
different question from the one Volume Spikes answers. Only upward multiples
fire, each one at most once, and a coin that 5x'd between two polls posts once at
5x rather than climbing the ladder.

### Who gets tagged

The message author, when a person posted the address. When a bot made the call
the credit goes to whoever that bot was replying to, since a bot is not a person
and tagging Rick helps nobody. When neither can be established the follow-up
still posts, with no mention.

### What counts as no volume

A single figure cannot serve both ends of the range, so the floor is set per
market-cap band and is editable in the dashboard:

| Market cap up to | Minimum 5m volume |
|---|---|
| $50,000 | $500 |
| $250,000 | $2,000 |
| $1,000,000 | $5,000 |
| anything above | $10,000 |

A coin trading $1,000 in five minutes is alive at a $60k cap and dead at $5m,
and this is what lets the same rule say both. When the market cap is unknown
there is no band to pick, so the volume rule does not apply at all.

### Retirement

Nothing is judged before **Judge it after** - a coin called at launch has no
market cap and no volume for the first minute by nature. Past that, it is dropped
for sitting under the market cap floor or trading under the volume floor, and
everything is dropped once **Follow a call for** elapses. A call that has already
run is exempt from the first two: it proved itself once, so it keeps its slot
until the clock runs out.

A failed poll is never taken as evidence of a dud, and closing a call only frees
the watchlist slot when no other channel is still following that coin and the
token was added by the call rather than by hand.

## Price streaming

Set a websocket URL for a chain (`BSC_WS_URL`, `BASE_WS_URL`, `ETHEREUM_WS_URL`)
and that chain stops waiting for the poll: every `Sync` and `Swap` on a watched
pool arrives as it lands, and dip, spike and trending alerts are judged straight
away.

| Chain | Websocket | Floor |
|---|---|---|
| BSC | yes | ~0.45s blocks |
| Base | yes | ~2s blocks, 200ms with a Flashblocks-capable provider |
| Ethereum | yes | ~12s blocks, a chain limit nothing can beat |
| Robinhood | **no** | the public RPC serves no websocket, so it stays on the poll |
| Solana | yes | ~0.4s slots - see [SOLANA-STREAMING.md](SOLANA-STREAMING.md) |

### How a streamed price is built

A V2 `Sync` restates both reserves, which gives price *and* pool liquidity. A V3
`Swap` carries `sqrtPriceX96`, which is the price in fixed-point form. Neither
carries dollars, so the USD figure comes from anchoring the pool ratio to
DexScreener's price at each poll: between polls the dollar number is the vendor's
own, moved by our ratio.

Everything a swap event cannot say - 24h volume, trade counts, pair age, socials
- is carried over from the last polled snapshot, and a streamed price is dropped
entirely if that snapshot is more than ten minutes old.

### What it changes about accuracy

Polling at 60s means a "180m high" is really the highest of 180 samples; a spike
that ran and retraced between two polls never existed. Streaming records a
reading whenever the price moves 2% or every 30 seconds, so the high a drawdown
is measured against is much closer to the high that actually traded.

Volume and trade counts still come from the aggregator's rolling windows. The
streamed volume engine, which would replace them with true discrete buckets, is
not built yet.

## Watchlist

```
/watch add <token> [chain]   # Manage Server
/watch remove <token>        # Manage Server
/watch list                  # anyone
```

Auto-discovery fills spare capacity from DEX Screener's boosted-listing feed —
which is **paid placement, not a ranking**. Nothing is trusted because it
appeared there: each candidate is measured, and only real liquidity ($50k) and
real 24h volume ($100k) earn it a slot. Discovered tokens carry a 24-hour expiry
and drop out on their own; manual entries never expire and are never evicted to
make room.

A manual add outranks a discovered one — adding a token discovery already found
promotes it and clears the expiry.

### Request budget

Each watched token costs one DEX Screener request per poll, out of ~300/minute
shared with price alerts, the coin tracker and Token Brief.

| Poll interval | Safe watchlist |
|---|---|
| 60s | 120 tokens (the cap) |
| 30s | ~84 tokens |
| 15s | ~42 tokens |
| 10s | ~28 tokens |
| 5s | ~14 tokens |

Those figures are 60% of the shared 280/min budget, which is what
`sustainableTokens()` in the worker enforces — the other 40% belongs to price
alerts and the coin tracker. A short interval is the cheapest latency there is:
10 coins at 5s is 120 req/min and turns a 60-second wait into a 5-second one for
nothing. Going over does not error — the limiter queues, so cycles run late
while everything still looks healthy — so the monitor logs a warning instead.

Raise `MONITOR_POLL_SECONDS` before raising `MONITOR_MAX_TOKENS`. Getting this
wrong shows up as 429s across the *whole bot*, not just the monitor.

---

## Rate limiting and dedupe

Two independent mechanisms, both per channel:

- **Cooldown** — a token that alerted stays quiet for its cooldown, per alert
  type. Without it, a token sitting at 6× its baseline for twenty minutes posts
  on every single poll. This is the failure mode that gets a monitor muted rather
  than tuned.
- **Hourly cap** — when more alerts qualify than fit, the **weakest** are
  dropped: high priority first, then whichever went furthest past its threshold.
  Dropping by arrival order would let a quiet hour of 3× prints use up the budget
  and silence the 40× that landed a minute later.

Everything suppressed is logged with its reason (`LOG_LEVEL=debug`). A cap that
silently eats alerts is indistinguishable from a monitor that is not working.

---

## Graceful degradation

Each provider counts its own consecutive failures. Three in a row marks it
unhealthy; one chain failing never stops the others, because chains are polled
in parallel and a provider that throws returns an empty list rather than
propagating.

`MONITOR_STATUS_CHANNEL_ID` gets a message on **transitions only** — down, and
back up again. A provider down for six hours does not need saying every minute,
and "it went down" without "it came back" leaves an operator chasing a problem
that fixed itself. Startup posts a one-off summary of which chains have working
whale detection and why the others do not.

---

## Cost to run

At defaults: 120 tokens, 60-second polling, three chains with whale detection.

| Item | Monthly | Notes |
|---|---|---|
| Hosting | **£0 marginal** | Runs in the existing bot process on the homelab. No new container, no new tunnel. |
| DEX Screener | **£0** | Free, no key, no account. ~5.2M requests/month — well inside the per-minute limit, which is the only limit that exists. |
| MongoDB storage | **£0** | ~350k snapshot rows steady state (48h TTL), roughly 70–100MB including indexes. Existing instance. |
| Helius | **£0 on the free tier, usually** | Credit-metered per webhook delivery. The variable is total swaps across subscribed tokens, not the token count — 100 quiet tokens cost far less than 5 busy ones. Check the current free allowance on their pricing page; the paid step-up is ~$49/mo. |
| EVM RPC | **£0 on free tiers** | 2 `getLogs` calls per chain per poll ≈ 8,600 requests/day across three chains ≈ 20M Alchemy compute units/month, against a free tier historically an order of magnitude larger. Contract layout reads are cached per pool forever. |
| **Total** | **£0/month at defaults** | |

**What would change that:** a busy Solana watchlist pushing Helius past its free
credit allowance is the only realistic path to a bill, and it scales with swap
volume rather than with anything configured here. If it happens, cut the
watchlist rather than the poll interval — subscriptions are what cost, not polls.

Rough electricity for the homelab is unchanged; this adds no container and the
work is I/O-bound waiting on HTTP.

---

## Testing

```bash
pnpm test          # detector logic against fixtures, no network
pnpm test:watch
pnpm typecheck
pnpm smoke         # live providers, no Discord or Mongo needed
```

The detectors in `src/monitor/detect/` are pure functions over plain numbers —
no database, no network, no Discord. That is what makes the part that decides
whether to shout at a channel testable, which is the only way to know a threshold
change did what it was meant to. 55 tests cover spike baselines, momentum window
sampling, the quality gates, whale thresholds and cooldown/cap selection.

Test files live in `src/monitor/__tests__/` and are excluded from `tsconfig`, so
`dist` never ships a module importing vitest.
