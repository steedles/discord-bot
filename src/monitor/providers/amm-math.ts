/**
 * Turning AMM pool state into a price.
 *
 * These are the arithmetic half of streaming: the events we already subscribe
 * to for whale detection carry the pool's state alongside the amounts, so a
 * price does not need a second request - it needs decoding. `Sync` carries both
 * V2 reserves; a V3 `Swap` carries `sqrtPriceX96`, which *is* the price in
 * fixed-point form.
 *
 * Pure functions on purpose. Getting a decimals shift wrong here does not throw,
 * it produces a price out by a factor of a million, and a dip alert fires on it
 * without complaint. That failure mode is only caught by tests.
 */

const Q96 = 2 ** 96

/**
 * Price of token0 measured in token1, from a V3 pool's `sqrtPriceX96`.
 *
 * The stored value is `sqrt(raw price) * 2^96`, where "raw" is the ratio of
 * base units rather than of whole tokens. Undoing the shift is therefore two
 * steps: square it back into a raw ratio, then move the decimal point by the
 * difference between the two tokens' decimals.
 */
export function priceFromSqrtPriceX96(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): number | undefined {
  if (sqrtPriceX96 <= 0n) return undefined

  const root = Number(sqrtPriceX96) / Q96
  const raw = root * root
  const price = raw * 10 ** (decimals0 - decimals1)

  return Number.isFinite(price) && price > 0 ? price : undefined
}

/**
 * Price of token0 measured in token1, from V2 reserves.
 *
 * A constant-product pool quotes the ratio of what it holds, so this is the
 * marginal price - what an infinitely small trade would get, before slippage.
 * That is the same thing every chart means by "price".
 */
export function priceFromReserves(
  reserve0: bigint,
  reserve1: bigint,
  decimals0: number,
  decimals1: number,
): number | undefined {
  if (reserve0 <= 0n || reserve1 <= 0n) return undefined

  const amount0 = Number(reserve0) / 10 ** decimals0
  const amount1 = Number(reserve1) / 10 ** decimals1
  if (!Number.isFinite(amount0) || !Number.isFinite(amount1) || amount0 === 0) return undefined

  const price = amount1 / amount0
  return Number.isFinite(price) && price > 0 ? price : undefined
}

/**
 * The watched token's price in the quote token, whichever side it sits on.
 *
 * `priceFrom*` always answers "token0 in token1". When the watched token is
 * token1 the answer is the reciprocal, and forgetting that is how a token comes
 * out priced at 4,000 rather than 0.00025.
 */
export function inQuote(price0In1: number, watchedIsToken0: boolean): number | undefined {
  if (!Number.isFinite(price0In1) || price0In1 <= 0) return undefined
  const price = watchedIsToken0 ? price0In1 : 1 / price0In1
  return Number.isFinite(price) && price > 0 ? price : undefined
}

/**
 * Pool liquidity in USD from the quote side of a V2 pool.
 *
 * Doubled because a constant-product pool holds equal value on both sides, which
 * is the same convention DexScreener reports - the alternative, pricing the
 * watched side with the price the pool itself sets, is circular.
 */
export function liquidityUsdFromQuoteReserve(
  quoteReserve: bigint,
  quoteDecimals: number,
  quoteUsd: number,
): number | undefined {
  if (quoteReserve <= 0n || !(quoteUsd > 0)) return undefined

  const amount = Number(quoteReserve) / 10 ** quoteDecimals
  const usd = amount * quoteUsd * 2

  return Number.isFinite(usd) && usd > 0 ? usd : undefined
}

/**
 * What one unit of the quote token is worth in USD, inferred from a vendor's
 * own USD price for the watched token and the pool ratio at that moment.
 *
 * The stream gives an exact ratio and no dollars; DexScreener gives dollars
 * every poll. Anchoring one to the other means the USD figure between polls is
 * the vendor's number carried forward on our ratio, rather than a price we made
 * up - and the anchor is re-set every time the vendor answers again.
 */
export function anchorQuoteUsd(
  watchedPriceUsd: number,
  watchedPriceInQuote: number,
): number | undefined {
  if (!(watchedPriceUsd > 0) || !(watchedPriceInQuote > 0)) return undefined

  const quoteUsd = watchedPriceUsd / watchedPriceInQuote
  return Number.isFinite(quoteUsd) && quoteUsd > 0 ? quoteUsd : undefined
}
