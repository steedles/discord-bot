# SNOP — deep dive, 2026-09-03

**`0xc4cb8a0167c77e36194f6affb6b71d931fab62c0` · Robinhood Chain · Uniswap v3**

## Lead with this

SNOP's own documentation says it is not an investment and has no holder utility.
It is trading at a **$222.6K market cap, up 561% in 24 hours**.

That is not a risk assessment, it is the token's own description of itself set
next to its own chart. Everything below is detail.

The second thing worth knowing: the document SNOP cites as its credential was
**deleted from the Pons repository 21 hours after it was added**, and SNOP's
website links to a pinned commit — the one URL where it still exists.

## What it is

| | |
|---|---|
| Name | Snop (`SNOP`) — "pons" backwards |
| Chain | Robinhood Chain |
| Pool | Uniswap v3, `0x1E1779d5Cf272a54Ce27Df5c9Eb718Ed5649D125`, quoted in WETH |
| Age | 41.6 days (pair created 2026-07-23 22:52 UTC) |
| Supply | 1,000,000,000, 18 decimals |
| Pairs | 1. This is its only market. |

Self-described as a "mirror test token" — a deployment made to validate that the
pons.family launch protocol behaves deterministically in both directions.

## The numbers

Source: DexScreener + GoPlus, via `pnpm brief`.

| | |
|---|---|
| Price | $0.000222 |
| Market cap | $222.6K (= FDV; no unlocks) |
| Liquidity | $50.9K — market cap 4.4x, normal for a small cap |
| Volume 24h | $88.1K — 1.7x pooled liquidity |
| 1h | **+153%**, 155 buys / 88 sells |
| 24h | **+561%**, 370 buys / 212 sells |
| GoPlus | **35/100, medium risk** |
| Creator wallet | **0.00%** |
| LP locked/burned | GoPlus reports 0% — but see Claims, this is contested |

Buyers lead sellers on every window. Liquidity is genuinely deep relative to the
cap, which is unusual for something this small and cuts against the simplest
rug reading.

## Links

Two websites declared. **No socials at all** — no X, no Telegram, no Discord.

| Link | Status | |
|---|---|---|
| `snoptoken.vercel.app` | 200 | Titled "$SNOP — pons.family's mirror test token". **Names this exact contract address.** |
| GitHub doc @ commit `b9b5a34` | 200 | `ponsdotdev/ponsfamily` — pinned to a commit, not a branch |

A project with a site that names its own contract and no social presence at all
is an odd shape: the site is more careful than a scam usually bothers with, and
the absence of socials is not what a promoted token looks like.

## How it is being talked about

**Nothing to report, and that is itself the finding.** No X account, no Telegram,
no Discord is declared anywhere. There is no official channel to assess.

A token up 561% in a day with no social presence at all is being traded on
something other than public promotion — most likely its appearance in Pons
launch feeds and whatever is being said in private channels.

## Claims

| Claim | Where | Verdict | What was found |
|---|---|---|---|
| "pons.family's mirror test token" | site `<title>` | **CONTRADICTED** | **`pons.family` does not resolve** — `ENOTFOUND`. The real project is `ponsfamily.com`. The domain in its own title does not exist. |
| "Not affiliated with, endorsed by, or operated by the pons.family team" | site body | — | Directly contradicts its own title's possessive framing. Both statements are on the same page. |
| Documentation "committed to the official Pons repository" | site | **MISLEADING (was true, no longer)** | Added `b9b5a34` 2026-07-23 22:50; **removed** in `777dac1` 2026-07-24 19:21 (`removed snop_test_en_v2.md, -193`). The removal commit is titled "Update README.md" and does not mention it. Site links the pinned commit. |
| `ponsdotdev/ponsfamily` is the official Pons repo | repo description | **UNVERIFIABLE** | The repo self-describes as "Official repository for the ponsfamily.com smart contracts" (135 stars, 18 forks). **`ponsfamily.com` publishes no GitHub link at all** — only docs and `@ponsdotfamily` on X. Cannot be confirmed from the counterparty, which is the only place that would settle it. |
| "No allocation. No presale. No unlocks." Deployer exited 2026-07-24 | site | **CONFIRMED** | Creator wallet holds **0.00%**. Market cap equals FDV, consistent with no unlocks. |
| "Liquidity locked via NFT" | site | **UNVERIFIABLE** | GoPlus reports 0% LP locked, but its check targets v2 LP tokens and this is a **v3 NFT position** — likely a measurement gap rather than a contradiction. Could not settle it: Robinhood Blockscout is behind Cloudflare. **Do not read the 0% as proof it is unlocked; do not read the claim as proof it is locked.** |
| "No utility, no roadmap, no promises"; "not an investment" | site + doc | **CONFIRMED — by the project itself** | Its own documentation says holders get nothing. |

### The timeline

```
2026-07-19 00:56   ponsdotdev/ponsfamily repo created
2026-07-23 22:50   SNOP doc committed
2026-07-23 22:52   SNOP pool created — 2 minutes later
2026-07-24 19:21   SNOP doc removed, in a commit titled "Update README.md"
```

Doc and pool two minutes apart is consistent with a genuine coordinated test
deployment. The deletion a day later is the part that wants explaining, and
there are two readings that the evidence does not separate:

1. **Pons deployed a test token, then thought better of publishing it** — perhaps
   once it started trading at a real valuation, which is a liability nobody
   wants attached to "official repository".
2. **Someone with access added a doc to lend a token credibility**, then removed
   it — leaving the pinned-commit link doing the work.

The second is not established. The first is at least as consistent with what is
here, and the tight two-minute gap points that way.

## Could not be checked

- **Holder distribution and concentration.** Robinhood Blockscout returns
  Cloudflare's "Just a moment..." to scripted requests. This is the biggest gap:
  a 561% move on $50.9K of liquidity could be a handful of wallets.
- **Whether the LP NFT is genuinely locked**, and by whom. Same blocker.
- **Whether `ponsdotdev` is really Pons.** Only Pons can answer it and they
  publish no GitHub link.
- **Wallet ages / sniping / bundling at launch** — `pnpm brief` flags this under
  "Nobody checked" as standard.

## What would change the picture

- **Ask Pons directly** — `@ponsdotfamily` on X. "Is `ponsdotdev` your GitHub,
  and why was the SNOP doc removed?" One reply settles the central question.
- **Holder concentration**, via a browser session against Blockscout or an RPC
  that answers scripted requests. If the top few wallets hold most of supply,
  everything above is moot.
- **The LP NFT owner**, same route.

## The honest state of it

A token that documents itself as having no utility, no roadmap and no investment
case, whose only stated credential was deleted from the repo it points to, whose
title names a domain that does not exist, and which has no social presence —
trading up 561% in a day.

Nothing here proves fraud. The creator wallet really is empty, the liquidity
really is deep for the size, and the site really does name its own contract —
none of which is what a careless scam looks like. It reads more like a real
technical artefact that acquired a speculative market its authors did not intend
and then distanced themselves from.

But whatever it was built for, its own authors say holders get nothing, and the
one document that tied it to a real project was taken down. Anyone buying it is
buying the reflection, which is precisely what the documentation says it is.
