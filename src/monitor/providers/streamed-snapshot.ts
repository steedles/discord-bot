import type { MarketSnapshot } from './types.js'

/**
 * Overlaying a streamed price onto the last polled snapshot.
 *
 * A stream knows the pool: price, and on a V2 pool its reserves. It does not
 * know the token's name, its socials, its 24h volume or how many trades it has
 * had, because none of that is in a swap event. Rather than invent those or
 * publish a half-empty snapshot, a streamed update is applied *on top of* the
 * last full reading from the aggregator - so every alert still carries complete
 * context, with the fast-moving numbers replaced by live ones.
 *
 * This is also why polling does not go away when streaming arrives. It becomes
 * the thing that supplies everything a swap event cannot say.
 */

export interface StreamedPrice {
  priceUsd: number
  /** V2 pools only. V3's `liquidity` is in-range depth, not pool TVL. */
  liquidityUsd?: number
  /** Epoch ms the pool state was observed. */
  at: number
}

/**
 * A snapshot with the streamed figures applied.
 *
 * Market cap moves with price rather than being restated: supply is what the
 * aggregator multiplied by, and supply does not change between two swaps. That
 * keeps the ratio exact instead of mixing a live price with a stale valuation.
 *
 * Volume and trade counts are deliberately carried through untouched. They are
 * windows the aggregator measured, and scaling or ageing them here would be
 * inventing figures nobody counted - the streamed volume engine replaces them
 * wholesale or not at all.
 */
export function applyStreamedPrice(base: MarketSnapshot, update: StreamedPrice): MarketSnapshot {
  const ratio =
    base.priceUsd !== undefined && base.priceUsd > 0 ? update.priceUsd / base.priceUsd : undefined

  return {
    ...base,
    priceUsd: update.priceUsd,
    ...(update.liquidityUsd !== undefined ? { liquidityUsd: update.liquidityUsd } : {}),
    ...(ratio !== undefined && base.marketCapUsd !== undefined
      ? { marketCapUsd: base.marketCapUsd * ratio }
      : {}),
    fetchedAt: update.at,
  }
}

/**
 * How stale a polled snapshot may be before a streamed price should not be
 * pinned to it.
 *
 * The overlay borrows everything except price from the base reading. Past this,
 * the borrowed half describes a different moment - a token's liquidity can be
 * pulled inside ten minutes - and an alert built on it would pair a live price
 * with facts that stopped being true.
 */
export const MAX_BASE_AGE_MS = 10 * 60_000

export function baseIsUsable(base: MarketSnapshot, now: number): boolean {
  return now - base.fetchedAt <= MAX_BASE_AGE_MS
}
