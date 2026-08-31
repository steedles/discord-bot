import { describe, expect, it } from 'vitest'
import {
  anchorQuoteUsd,
  inQuote,
  liquidityUsdFromQuoteReserve,
  priceFromReserves,
  priceFromSqrtPriceX96,
} from '../providers/amm-math.js'

const Q96 = 2n ** 96n

/** `sqrtPriceX96` for a given human price, so a test can state the answer first. */
function sqrtPriceX96For(humanPrice: number, decimals0: number, decimals1: number): bigint {
  const raw = humanPrice * 10 ** (decimals1 - decimals0)
  return BigInt(Math.round(Math.sqrt(raw) * Number(Q96)))
}

describe('priceFromSqrtPriceX96', () => {
  it('reads 1:1 when both sides have the same decimals', () => {
    expect(priceFromSqrtPriceX96(Q96, 18, 18)).toBeCloseTo(1, 12)
  })

  it('undoes the decimals shift between two different tokens', () => {
    // A USDC (6) / WETH (18) pool at 0.0004 ETH per USDC.
    const sqrtPriceX96 = sqrtPriceX96For(0.0004, 6, 18)

    expect(priceFromSqrtPriceX96(sqrtPriceX96, 6, 18)).toBeCloseTo(0.0004, 8)
  })

  it('survives the very small prices these tokens actually trade at', () => {
    const sqrtPriceX96 = sqrtPriceX96For(0.000000012, 18, 18)

    expect(priceFromSqrtPriceX96(sqrtPriceX96, 18, 18)).toBeCloseTo(0.000000012, 15)
  })

  it('refuses a zero or negative root rather than returning 0', () => {
    expect(priceFromSqrtPriceX96(0n, 18, 18)).toBeUndefined()
    expect(priceFromSqrtPriceX96(-1n, 18, 18)).toBeUndefined()
  })
})

describe('priceFromReserves', () => {
  it('quotes the ratio the pool holds', () => {
    // 50 WETH against 200,000 USDC -> 4,000 USDC per WETH.
    const weth = 50n * 10n ** 18n
    const usdc = 200_000n * 10n ** 6n

    expect(priceFromReserves(weth, usdc, 18, 6)).toBeCloseTo(4_000, 6)
  })

  it('is the reciprocal when the sides are swapped', () => {
    const weth = 50n * 10n ** 18n
    const usdc = 200_000n * 10n ** 6n

    expect(priceFromReserves(usdc, weth, 6, 18)).toBeCloseTo(1 / 4_000, 12)
  })

  it('says nothing about an empty pool', () => {
    expect(priceFromReserves(0n, 100n, 18, 18)).toBeUndefined()
    expect(priceFromReserves(100n, 0n, 18, 18)).toBeUndefined()
  })
})

describe('inQuote', () => {
  it('passes the price through when the watched token is token0', () => {
    expect(inQuote(0.0004, true)).toBeCloseTo(0.0004, 12)
  })

  it('inverts it when the watched token is token1', () => {
    // The failure this guards: 4,000 reported where 0.00025 was the truth.
    expect(inQuote(4_000, false)).toBeCloseTo(0.00025, 12)
  })
})

describe('liquidityUsdFromQuoteReserve', () => {
  it('doubles the quote side, as the aggregators do', () => {
    const usdc = 125_000n * 10n ** 6n

    expect(liquidityUsdFromQuoteReserve(usdc, 6, 1)).toBeCloseTo(250_000, 6)
  })

  it('prices a non-stable quote through its own USD value', () => {
    const weth = 40n * 10n ** 18n

    expect(liquidityUsdFromQuoteReserve(weth, 18, 4_000)).toBeCloseTo(320_000, 6)
  })

  it('says nothing when the quote has no USD price', () => {
    expect(liquidityUsdFromQuoteReserve(10n ** 18n, 18, 0)).toBeUndefined()
  })
})

describe('anchorQuoteUsd', () => {
  it('recovers what the quote token is worth from a vendor price', () => {
    // The vendor says the token is $0.10, the pool says it is 0.000025 ETH.
    expect(anchorQuoteUsd(0.1, 0.000025)).toBeCloseTo(4_000, 6)
  })

  it('round-trips: anchor, then re-price a later ratio', () => {
    const quoteUsd = anchorQuoteUsd(0.1, 0.000025)!
    // The pool moves to 0.00003 ETH with the quote unchanged.
    expect(0.00003 * quoteUsd).toBeCloseTo(0.12, 10)
  })

  it('refuses to anchor on a missing price', () => {
    expect(anchorQuoteUsd(0, 0.000025)).toBeUndefined()
    expect(anchorQuoteUsd(0.1, 0)).toBeUndefined()
  })
})
