# Solana price streaming

Solana has no equivalent of an EVM `Sync` event. A swap does not announce the new
price, it rewrites an account - so a live price means subscribing to whichever
account holds the pool state and decoding it, which means knowing each AMM's byte
layout.

`src/monitor/providers/solana-amm.ts` holds that knowledge and nothing else;
`solana-stream.ts` is transport.

## What gets subscribed to

| AMM | Program | Priced from |
|---|---|---|
| PumpSwap | `pAMMBay6…` | the two vault token accounts |
| Raydium AMM v4 | `675kPX9M…` | the two vault token accounts |
| Meteora DLMM | `LBUZKhRx…` | the pair account's **active bin** |
| pump.fun curve | `6EF8rrec…` | the curve's virtual reserves |

Anything else stays on the poll. A pool we cannot read exactly is a pool we do
not stream - a late alert beats a wrong one.

## Verified offsets

Every offset was confirmed against live mainnet accounts, not read off a
document, and the captured bytes live in `src/monitor/__tests__/solana-fixtures.ts`
so the decoders are tested against what a validator actually served.

**PumpSwap pool** (301 bytes)

| Field | Offset |
|---|---|
| baseMint | 43 |
| quoteMint | 75 |
| baseVault | 139 |
| quoteVault | 171 |

**Raydium AMM v4** (752 bytes)

| Field | Offset |
|---|---|
| baseDecimal | 32 |
| quoteDecimal | 40 |
| baseVault | 336 |
| quoteVault | 368 |
| baseMint | 400 |
| quoteMint | 432 |

**Meteora DLMM pair** (904 bytes)

| Field | Offset |
|---|---|
| activeId (i32) | 76 |
| binStep (u16) | 80 |
| tokenXMint | 88 |
| tokenYMint | 120 |
| reserveX | 152 |
| reserveY | 184 |

**pump.fun bonding curve**: virtualTokenReserves at 8, virtualSolReserves at 16,
`complete` flag at 48.

**SPL token account**: mint at 0, amount at 64. Note that pump.fun mints are
**Token-2022**, so their vaults are owned by `TokenzQdB…` rather than
`Tokenkeg…`. The first 165 bytes are identical, but an owner check that knows
only the classic program decides a real vault is not a vault.

## Meteora is not priced from its reserves

DLMM concentrates liquidity into bins, so the two reserves say how much sits
either side of the current price rather than what the price *is*. On the pair
checked, reading them as a constant-product pool underpriced the token by about
600x. The price is the active bin:

```
price = (1 + binStep / 10_000) ** activeId
```

Verified at 0.26% from DexScreener's own figure on a live pair.

## Accuracy measured at capture time

| Pool | Ours | DexScreener | Drift |
|---|---|---|---|
| PumpSwap CATE | 0.00016660537 SOL | 0.0001668 SOL | 0.117% |
| Meteora STONK | 5.234e-5 SOL | 5.220e-5 SOL | 0.26% |
| Raydium SOL/USDC | 82.3633 | 82.55 | 0.23% |

The residual is the gap between two readings taken seconds apart, not error in
the decode.

## Configuration

```
HELIUS_API_KEY=…          # RPC and websocket URLs are derived from this
SOLANA_RPC_URL=…          # optional override
SOLANA_WS_URL=…           # optional override
```

A public endpoint (`https://api.mainnet-beta.solana.com` /
`wss://api.mainnet-beta.solana.com`) is enough to develop and test against - the
whole path was proven on one before any Helius key existed. Helius is worth
paying for in production because a public node rate-limits and lags.

## Recapturing the fixtures

If a program is upgraded and the layouts move, recapture with:

```bash
curl -s https://api.mainnet-beta.solana.com -X POST \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo",
       "params":["<pool address>",{"encoding":"base64","commitment":"confirmed"}]}'
```

The decoder tests will fail loudly against the new bytes, which is the point.
