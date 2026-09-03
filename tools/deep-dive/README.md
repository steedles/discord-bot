# Deep dive toolbox

The accumulating half of the `coin-deep-dive` agent. **This file is the index —
read it before writing anything, and add to it whenever you write something.**

An unregistered tool does not exist. The next dive greps this file, not the
directory, so a script that works but is not listed here will be rewritten by
someone who never knew it was there.

## Before you write a new script

Check, in this order:

1. **This index.** Someone may have solved it already.
2. **The repo's own commands.** `pnpm brief` covers market, holders and vendor
   risk. `pnpm smoke` isolates our-code-vs-upstream. `pnpm ta` replays the trend
   detector. `pnpm rugcheck` runs the funding-graph check on Solana.
3. **`src/market/` and `src/risk/`.** DexScreener, GeckoTerminal, Blockscout,
   Solana RPC, GoPlus, honeypot.is, RugCheck are all already wired, rate-limited
   and tested against real tokens.

Only then write something new. Most of what a dive needs already exists here and
is more honest about its gaps than anything written in a hurry.

## Rules for a tool that lands here

- **Standalone.** Plain `.mjs`, run with `node`, no build step.
- **Takes argv.** Never hardcode a token, chain or address.
- **Prints JSON or plain text** to stdout. Errors and progress to stderr, so the
  output stays pipeable.
- **Fails loudly, not silently.** A tool that returns `{}` when an upstream is
  down is worse than one that says the upstream is down — the first gets read as
  "nothing found".
- **Never invents.** Absent data is `null` with a reason, never a zero, never a
  default that reads as a measurement.
- **One line in the table below**, in the same pass that creates it.

## The tools

| Script | Does | Call it |
|---|---|---|
| `lib/links.mjs` | Pulls a token's website and socials off DexScreener, then checks each one: resolves or not, final URL after redirects, page title, whether the page mentions the contract address. | `node tools/deep-dive/lib/links.mjs <chain> <address>` |
| `lib/x-profile.mjs` | An X account without an API key: exists, display name, bio, and whether the handle was renamed. Optionally checks the bio mentions a ticker. Takes handles or URLs in any shape. | `node tools/deep-dive/lib/x-profile.mjs <handle-or-url> [...] [--expect TICKER]` |

### What X gives up without an API key

Measured 2026-09-03, so that no future dive re-derives it:

- **Available** from the Open Graph metadata on an unauthenticated request:
  account existence, display name, bio, canonical handle after a rename.
- **Not available at all**: follower count, join date, timeline, engagement.
  None of it is in the served HTML. Do not estimate them.
- **The existence test is `og:title`, not the status code.** A handle that does
  not exist returns HTTP 200 with no `og:title`.
- `syndication.twitter.com` (the old embed API) answers **429**;
  `cdn.syndication.twimg.com` answers 200 with an empty body. Neither is a route
  in without a token - both were tried.

## Reports

Past dives live in `reports/`, named
`<chain>-<address-first8>-<YYYY-MM-DD>.md`.

They are worth grepping before starting: a token related to the one you are
diving — same deployer, same claimed partner, same audit firm — may already have
been examined, and a claim disproved once is disproved for every coin that
repeats it.

## What deliberately is not here

Anything that would duplicate `src/`. If a dive needs better market data, the fix
is to improve the provider in `src/market/` where the rest of the bot benefits,
not to write a second version here that drifts out of step.
