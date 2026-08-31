import type { MarketSnapshot, WhaleSwap } from '../providers/types.js'
import type { Reading } from '../detect/types.js'

/** A fixed clock, so a fixture reads the same on every run. */
export const NOW = Date.UTC(2026, 0, 15, 12, 0, 0)

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE

/**
 * A snapshot of an unremarkable token: deep enough, old enough, busy enough.
 * Tests override only the field under examination, so a failure names itself.
 */
export function snapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    chainId: 'solana',
    tokenAddress: 'So11111111111111111111111111111111111111112',
    pairAddress: 'PAIR1111111111111111111111111111111111111111',
    symbol: 'TEST',
    name: 'Test Token',
    priceUsd: 1,
    liquidityUsd: 250_000,
    marketCapUsd: 5_000_000,
    volume: { m5: 5_000, h1: 60_000, h6: 360_000, h24: 1_440_000 },
    txns: { m5: { buys: 20, sells: 10 }, h24: { buys: 2_000, sells: 1_500 } },
    priceChange: { m5: 0.4, h1: 1.2, h24: 3.5 },
    pairCreatedAt: NOW - 30 * 24 * HOUR,
    url: 'https://dexscreener.com/solana/pair',
    hasSocials: true,
    fetchedAt: NOW,
    ...overrides,
  }
}

/**
 * A history of evenly spaced readings, newest last.
 *
 * `stepMinutes` is how far apart they sit - the spike detector cares, because
 * readings closer together than five minutes describe overlapping windows.
 */
export function readings(
  count: number,
  options: {
    stepMinutes?: number
    volM5?: number | ((index: number) => number)
    volH1?: number | ((index: number) => number)
    priceUsd?: number | ((index: number) => number)
    endAt?: number
  } = {},
): Reading[] {
  const { stepMinutes = 5, endAt = NOW } = options
  const pick = (
    value: number | ((index: number) => number) | undefined,
    index: number,
  ): number | undefined => (typeof value === 'function' ? value(index) : value)

  return Array.from({ length: count }, (_, i) => {
    // i = 0 is the oldest reading.
    const stepsBack = count - i
    return {
      at: endAt - stepsBack * stepMinutes * MINUTE,
      volM5: pick(options.volM5, i),
      volH1: pick(options.volH1, i),
      priceUsd: pick(options.priceUsd, i),
    }
  })
}

export function whaleSwap(overrides: Partial<WhaleSwap> = {}): WhaleSwap {
  return {
    chainId: 'solana',
    tokenAddress: 'So11111111111111111111111111111111111111112',
    pairAddress: 'PAIR1111111111111111111111111111111111111111',
    symbol: 'TEST',
    side: 'buy',
    amountUsd: 25_000,
    tokenAmount: 25_000,
    txHash: 'sig111',
    wallet: 'wallet111',
    at: NOW,
    ...overrides,
  }
}
