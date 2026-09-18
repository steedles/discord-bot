# Crypto Trading Discord Bot

Price alerts, on-demand token lookups and a new-launch scanner for a crypto
trading Discord — covering Solana and the major EVM chains.

Every feature can be switched on or off **per channel**, and tuned per channel,
from a web dashboard. No paid API keys: it runs on DexScreener, RugCheck and
GoPlus free endpoints.

📖 [Architecture](docs/ARCHITECTURE.md) · [Features](docs/FEATURES.md) · [Dashboard](docs/DASHBOARD.md)

---

## Quick start

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d    # local MongoDB on :27020
cp .env.example .env                              # fill in the Discord values
pnpm commands:deploy                              # register slash commands
pnpm dev
```

Then open <http://localhost:4300> for the dashboard.

Check the market data providers without needing Discord or Mongo at all:

```bash
pnpm smoke                    # or: pnpm smoke WIF BONK 0xa0b8...
```

---

## Discord app setup

At <https://discord.com/developers/applications>:

1. **Bot → Reset Token** → `DISCORD_TOKEN`
2. **General Information → Application ID** → `DISCORD_CLIENT_ID`
3. **OAuth2 → Client Secret** → `DISCORD_CLIENT_SECRET` *(dashboard only)*
4. **OAuth2 → Redirects** → add `<DASHBOARD_URL>/auth/callback`, exactly.
   Production is `https://steedlescrypto.dohbelisk.com/auth/callback`
5. Invite the bot with the `bot` and `applications.commands` scopes, and the
   *View Channels*, *Send Messages*, *Embed Links*, *Attach Files* and *Read
   Message History* permissions (`permissions=117760`)

Slash commands register themselves: the bot does a per-guild registration on
every boot and the moment it joins a server, so a new server has `/price`
within seconds. `pnpm commands:deploy` remains for a one-off from a
workstation (guild-scoped when `DISCORD_GUILD_ID` is set, else global).

**Token Brief needs the privileged Message Content intent.** Enable it under
**Bot → Privileged Gateway Intents → Message Content Intent**, or login fails
with `Used disallowed intents`. Set `ENABLE_MESSAGE_CONTENT=false` to run
everything else without it. No approval is needed under 100 servers.

---

## Features

| Feature | Kind | Commands | Default |
|---|---|---|---|
| **Market Lookup** | commands | `/price` `/scan` | on |
| **Price Alerts** | commands | `/alert` | on |
| **Coin Tracker** | commands + pings | `/track` | on |
| **Launch Scanner** | posts | – | off |
| **Token Brief** | watches, replies | – | off |
| **Call Tracker** | watches, posts | – | off |
| **Volume Spikes** | posts | – | off |
| **Whale Buys** | posts | – | off |
| **Trending Momentum** | posts | – | off |
| **Dip Hunter** | posts | – | off |
| **Level Break** | posts | – | off |
| **PvP Coins** | posts | – | off |
| **Vamp Watch** | posts | – | off |

The last seven share one worker, one watchlist and one poll — see
[docs/VOLUME-MONITOR.md](docs/VOLUME-MONITOR.md). Call Tracker feeds that same
watchlist: it adds coins the channel calls, drops the ones going nowhere, and
reports back when one runs.

Each is configured per channel. The point is that the same feature can run more
than once with different settings:

```
#alpha-calls   Launch Scanner   min liq $250k · max risk 15 · socials required
#degen-plays   Launch Scanner   min liq $5k   · max risk 75 · <2h old
```

Two independent scanners, one bot. See [FEATURES.md](docs/FEATURES.md).

### Commands

| Command | Who | What |
|---|---|---|
| `/help [feature]` | everyone | Every feature and whether it is on here; add a feature for the detail |
| `/price <token> [chain]` | everyone | Price, market cap, liquidity, 24h change, links |
| `/scan <token> [chain]` | everyone | Risk report — RugCheck (Solana), GoPlus (EVM) |
| `/alert add\|list\|remove\|clear` | everyone | Price alerts, pinged in-channel |
| `/track add\|list\|remove\|clear` | everyone | Watch a coin's 1-minute chart, pinged when the trend turns |
| `/watch add\|remove\|list` | Manage Server | The shared watchlist the monitor polls |
| `/monitor status` | everyone | Data-source health, watchlist size, request budget |
| `/feature list\|enable\|disable\|settings\|dashboard` | Manage Server | Switch features on/off per channel |

`token` accepts a ticker (`WIF`, `$WIF`) or a contract address. Prices accept
`0.0042`, `250`, `1.5k`, `2m`.

`/feature` covers on/off; detailed settings live on the dashboard.

---

## Dashboard

**Production:** <https://steedlescrypto.dohbelisk.com>
**Development:** <http://localhost:4300>

Sign in with Discord — you see the servers where you have **Manage Server** and
the bot is present.

Toggle any feature per channel, and edit its settings in a form generated from
that feature's own schema. Adding a setting to a feature makes it appear in the
UI with no frontend changes.

It **refuses to start** unless `DISCORD_CLIENT_SECRET`, `SESSION_SECRET` and
`DASHBOARD_URL` are all set; the bot then runs without it. An unauthenticated
config panel would be worse than none. Full setup and API reference in
[DASHBOARD.md](docs/DASHBOARD.md).

---

## Token Brief: Rick's numbers, in sentences

When Rick (or any bot, or a member) posts a token, Token Brief works out what
the numbers actually mean and replies in the channel. Set `delivery` to
`Direct message` if you would rather have it privately — Discord only allows a
hidden message as the reply to an interaction, so a DM is the only private
option there is.

It takes only the *address* from the message and re-derives every number from
our own providers — DexScreener for the market, RugCheck or GoPlus for the
contract and the holder distribution. So it does not parse Rick's layout (which
is undocumented and changes), it can say things Rick does not, and it states
plainly what nobody checked instead of guessing.

A brief covers price and market depth, trading flow, who holds the supply, the
vendor's safety findings, then two ranked lists: what the numbers warn about,
and what is in the token's favour.

Per channel you can set where it replies, which sources to read, a bot
allowlist, chains, a minimum pool size, a per-token cooldown, and full or quick
detail. **Quick** is worth switching on in a busy channel — same facts, far less
wall of text.

```bash
pnpm brief WIF        # see exactly what it will say, no Discord needed
```

Requires the Message Content intent, see above.

> Rug Watch, which scored the same tokens instead of explaining them, is parked
> — the code is still there but it is unregistered and not started. See the note
> in `src/features/registry.ts`.

## Coin Tracker: being told when a chart turns

```
/track add WIF          → pinged when WIF's 1-minute trend turns
/track list             → what you are watching
/track remove           → stop watching one
```

Three standard signals vote on every closed one-minute candle: **EMA 9/21**
crossing, **MACD 12/26/9** crossing its signal line, and **RSI 14** crossing 50.
A turn is announced when enough of them agree — two of three by default — and
the message names every signal that fired, *including any that pointed the other
way*. A crossover is not a prediction, and a 2-1 split should not read like a
unanimous one.

Three rules stop it becoming a spam machine, all of them saying the same thing:
a crossover is not an event, a *change* is.

1. Only a turn opposite to the last one reported counts.
2. Never twice inside the cooldown (15 minutes by default).
3. Never unless price moved at least 1% since the last signal.

Candles come from **GeckoTerminal** — free, no key, real OHLCV per pool. Two
things about that feed shape the design:

- **A minute with no trades produces no candle.** So 150 candles can span 17
  hours on a quiet pool, and an EMA over them is not a one-minute trend. The
  detector measures how dense the window actually is and declines to read a
  chart that is more than half gaps.
- **The chart comes from the busiest pool, not the deepest.** Those differ: one
  of WIF's deepest pools prints a candle every seven minutes. Depth still
  decides whose *price* to quote — that is a separate question, answered by
  `selectPricePair`.

```bash
pnpm ta SOL        # replay the detector over the last few hours
pnpm ta SOL 3      # ...requiring all three signals
```

Tune it per channel on the dashboard: confirmations, minimum move, cooldown,
and whether it announces in the channel or DMs you.

## How the launch scanner finds tokens

Two feeds, both filtered through each channel's own settings before anything
posts:

1. **DexScreener token profiles** — new listings across every supported chain.
2. **pump.fun graduations** — a websocket watches every pump.fun mint, and one
   is only posted once it reaches a DEX with real liquidity. Raw mints run to
   hundreds an hour and almost all are worthless, so posting them directly would
   be pure spam. `ENABLE_PUMPPORTAL=false` disables it globally; each channel can
   also pick its sources.

Every candidate is risk-checked before posting, and a token with **no** risk
data is dropped rather than posted unverified.

---

## Risk scoring: whose number is it?

The score is always a **vendor's**, never one this bot invents:

| Chain | Score from | How |
|---|---|---|
| Solana | **RugCheck** | its own `score_normalised`, passed through |
| Ethereum, BSC, Base | **honeypot.is** | simulates a real buy + sell, so it answers *can this be sold* |
| Arbitrum, Polygon, Optimism, Avalanche, Blast | **GoPlus** | no vendor score exists, so findings map to a band by worst finding |

GoPlus returns 21 raw fields and no score at all. An earlier version summed
invented weights over them, which had two failure modes now fixed:

1. **Absent data read as clean.** GoPlus omits fields it has not analysed, so a
   brand-new contract scored identically to a verified-safe one. Coverage is now
   measured, and thin coverage reports **Unknown**, never "low".
2. **Liquidity was ignored.** A drained pool is untradeable — as bad as a
   honeypot — but contract analysis alone rates it clean. Pool health is now
   reported as a separate hard warning (`🚫 Cannot be traded`) rather than
   blended into the vendor's score.

Consequence worth knowing: on chains honeypot.is does not cover, GoPlus is often
too thin to reach a verdict, so those tokens report **Unknown**. That is
deliberate — Unknown means "nobody has vouched for this", which is different
from safe, and the launch scanner drops Unknown tokens rather than posting them.

## Token resolution, and why it is careful

Quoting the wrong token to a trading group is the worst thing this bot could do,
so resolution is deliberately conservative:

- **A contract address is exact** and always wins. Prefer it.
- **Major tickers are pinned** to verified addresses in
  `src/market/known-tokens.ts`. DexScreener's search cannot be trusted here —
  searching `USDC` surfaces Solana copycats with seven figures of liquidity, and
  `WIF` often does not return dogwifhat at all.
- **Anything else is fuzzy-matched**, ranked on the geometric mean of liquidity
  and 24h volume (an impostor can fake depth with a small pool, but not real
  flow), and the reply says plainly that it was matched by ticker and shows the
  address. Channels can require verified-only tokens for alerts.
- **Broken pools are rejected.** A token's price comes from the deepest pool
  whose price agrees with the median across its pools. BONK has had a $2M pool
  quoting 5000x what every other pool said; without this the bot would have
  reported it.

To pin a new ticker, verify first: the token must trade as a *base* token on
that chain with a matching symbol and real liquidity.

---

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DISCORD_TOKEN` | – | Required |
| `DISCORD_CLIENT_ID` | – | Required |
| `DISCORD_GUILD_ID` | – | Only for `pnpm commands:deploy`; the running bot registers per guild by itself |
| `OPS_RUNNER_SECRET` | – | Enables the Setup tab's homelab jobs. See `deploy/homelab/ops-runner/` |
| `MONGO_URI` | `mongodb://127.0.0.1:27020` | Dev container port |
| `MONGO_DB` | `discord_bot` | |
| `PRICE_POLL_SECONDS` | `60` | Minimum 15 |
| `LAUNCH_POLL_SECONDS` | `45` | Minimum 20 |
| `TRACK_POLL_SECONDS` | `60` | Minimum 30. Coin Tracker chart polling |
| `ENABLE_PUMPPORTAL` | `true` | pump.fun graduation feed |
| `ENABLE_MESSAGE_CONTENT` | `true` | Privileged intent for Token Brief |
| `DASHBOARD_ENABLED` | `true` | |
| `DASHBOARD_PORT` | `4300` | |
| `DASHBOARD_URL` | – | Required for the dashboard; no trailing slash |
| `DISCORD_CLIENT_SECRET` | – | Required for the dashboard |
| `SESSION_SECRET` | – | Required for the dashboard. `openssl rand -base64 32` |
| `SESSION_DAYS` | `7` | Dashboard login lifetime |
| `LOG_LEVEL` | `info` | |

At default intervals the bot uses roughly 100 requests/minute against
DexScreener's 300/minute limit.

---

## Scripts

| Command | Does |
|---|---|
| `pnpm dev` | Run with reload |
| `pnpm build` | Compile to `dist/` and copy dashboard assets |
| `pnpm start` | Run the compiled build |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm commands:deploy` | Register slash commands with Discord |
| `pnpm commands:clear` | Remove all registered commands |
| `pnpm smoke [tokens…]` | Hit the live data providers |
| `pnpm brief <tokens…>` | Print a Token Brief in the terminal |
| `pnpm ta <token> [n]` | Replay the trend detector over a coin's chart |

---

## Deploying to the homelab

Live at **<https://steedlescrypto.dohbelisk.com>**.

```bash
cp deploy/homelab/.env.example deploy/homelab/.env.homelab   # fill in, gitignored
./deploy/homelab/deploy.sh
```

`deploy.sh` runs from your Mac and is idempotent — re-run it to redeploy. It
creates the Cloudflare named tunnel if missing, routes the DNS record, renders
the ingress config, rsyncs the repo, ships secrets and tunnel credentials out of
band, rebuilds, then waits for both `discord ready` and a live HTTPS response
before reporting success.

Three containers: `mongo` (named volume, survives redeploys), `bot` (internal
only — no published port), and `cloudflared` (the public hostname). Nothing is
exposed to the LAN; the tunnel is the only way in.

### Legal pages

Served by the dashboard, for the Discord app listing:

- <https://steedlescrypto.dohbelisk.com/privacy>
- <https://steedlescrypto.dohbelisk.com/terms>

Source is `src/web/public/privacy.html` and `terms.html`. They describe what the
bot actually stores — update them when that changes.

---

## Not financial advice

Risk scores come from third-party providers and are heuristics, not guarantees.
A low score is not a safe token.
