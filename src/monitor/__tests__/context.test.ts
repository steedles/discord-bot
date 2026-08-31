import { describe, expect, it } from 'vitest'
import { buildAlertContext, describeDivergence, describeFlow } from '../detect/context.js'
import type { MarketSnapshot, WhaleSwap } from '../providers/types.js'
import type { Reading } from '../detect/types.js'

const NOW = 1_800_000_000_000
const minutesAgo = (n: number) => NOW - n * 60_000

function snapshot(over: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    chainId: 'bsc',
    tokenAddress: '0xBEEA000000000000000000000000000000007777',
    pairAddress: '0xpool',
    symbol: 'TEST',
    name: 'Test',
    priceUsd: 0.02831,
    liquidityUsd: 1_880_000,
    marketCapUsd: 28_320_000,
    volume: {},
    txns: {},
    priceChange: {},
    hasSocials: false,
    fetchedAt: NOW,
    ...over,
  }
}

function reading(over: Partial<Reading> & { at: number }): Reading {
  return { priceUsd: 0.0297, liquidityUsd: 1_920_000, marketCapUsd: 29_710_000, ...over }
}

const swap = (over: Partial<WhaleSwap> = {}): WhaleSwap => ({
  chainId: 'bsc',
  tokenAddress: '0xBEEA000000000000000000000000000000007777',
  pairAddress: '0xpool',
  symbol: 'TEST',
  side: 'sell',
  amountUsd: 100_000,
  txHash: '0xhash',
  wallet: '0x8f2a000000000000000000000000000000c41d',
  at: minutesAgo(1),
  ...over,
})

describe('buildAlertContext', () => {
  it('reports what each figure was, and the span it actually measured', () => {
    const ctx = buildAlertContext(snapshot(), [reading({ at: minutesAgo(110) })], [], NOW)

    expect(ctx.spanMinutes).toBe(110)
    expect(ctx.marketCap).toMatchObject({ from: 29_710_000, to: 28_320_000 })
    expect(ctx.marketCap?.changePct).toBeCloseTo(-4.68, 1)
    expect(ctx.liquidity).toMatchObject({ from: 1_920_000, to: 1_880_000 })
  })

  it('refuses to compare across a span too short to mean anything', () => {
    // Two readings a minute apart mostly measure noise.
    const ctx = buildAlertContext(snapshot(), [reading({ at: minutesAgo(1) })], [], NOW)

    expect(ctx.spanMinutes).toBeUndefined()
    expect(ctx.marketCap).toBeUndefined()
    expect(ctx.divergence).toBeUndefined()
  })

  it('ignores readings older than the context window', () => {
    const ctx = buildAlertContext(snapshot(), [reading({ at: minutesAgo(600) })], [], NOW)
    expect(ctx.spanMinutes).toBeUndefined()
  })

  it('takes the oldest usable reading, so the span is the widest it can honestly claim', () => {
    const ctx = buildAlertContext(
      snapshot(),
      [
        reading({ at: minutesAgo(10) }),
        reading({ at: minutesAgo(90), marketCapUsd: 40_000_000 }),
        reading({ at: minutesAgo(45) }),
      ],
      [],
      NOW,
    )

    expect(ctx.spanMinutes).toBe(90)
    expect(ctx.marketCap?.from).toBe(40_000_000)
  })

  it('leaves a figure out when the older row never stored it', () => {
    // Rows written before market cap was persisted have none. Absence is not zero.
    const ctx = buildAlertContext(
      snapshot(),
      [reading({ at: minutesAgo(60), marketCapUsd: undefined })],
      [],
      NOW,
    )

    expect(ctx.marketCap).toBeUndefined()
    expect(ctx.price).toBeDefined()
    // Falls back to price for the divergence sentence rather than going silent.
    expect(ctx.divergence).toContain('holding while price came off')
  })
})

describe('describeDivergence', () => {
  const move = (from: number, changePct: number) => ({
    from,
    to: from * (1 + changePct / 100),
    changePct,
  })

  it('names a pool that holds while price falls', () => {
    expect(describeDivergence(move(100, -4.7), move(100, -2))).toBe(
      'The pool is holding while price came off — liquidity 2.0% against a 4.7% fall.',
    )
  })

  it('names liquidity leaving alongside the price', () => {
    expect(describeDivergence(move(100, -20), move(100, -35))).toContain('Liquidity is leaving')
  })

  it('distinguishes a rise on existing depth from one that brought new depth', () => {
    expect(describeDivergence(move(100, 30), move(100, 1))).toContain('running on the liquidity already there')
    expect(describeDivergence(move(100, 30), move(100, 25))).toContain('New liquidity arrived')
  })

  it('names a pool thinning under a flat price', () => {
    expect(describeDivergence(move(100, 0.5), move(100, -12))).toContain('thinning while price holds')
  })

  it('says nothing when neither measure moved', () => {
    expect(describeDivergence(move(100, 0.4), move(100, -1))).toBeUndefined()
  })

  it('says nothing when a measure is missing', () => {
    expect(describeDivergence(undefined, move(100, -20))).toBeUndefined()
    expect(describeDivergence(move(100, -20), undefined)).toBeUndefined()
  })
})

describe('describeFlow', () => {
  const target = { chainId: 'bsc', tokenAddress: '0xBEEA000000000000000000000000000000007777' }

  it('counts real transactions and names a single wallet', () => {
    const flow = describeFlow(
      [swap({ amountUsd: 200_000 }), swap({ amountUsd: 150_000 }), swap({ amountUsd: 62_000 })],
      target,
      NOW,
    )

    expect(flow).toBe('3 sells totalling $412.0K in the last 5 minutes, one wallet `0x8f2a…00c41d`.')
  })

  it('counts distinct wallets rather than naming one of many', () => {
    const flow = describeFlow(
      [swap({ wallet: '0xaaa' }), swap({ wallet: '0xbbb' }), swap({ wallet: '0xccc' })],
      target,
      NOW,
    )
    expect(flow).toContain('across 3 wallets')
  })

  it('reports the side that moved the money, not the side with more receipts', () => {
    const flow = describeFlow(
      [
        swap({ side: 'buy', amountUsd: 5_000 }),
        swap({ side: 'buy', amountUsd: 5_000 }),
        swap({ side: 'buy', amountUsd: 5_000 }),
        swap({ side: 'sell', amountUsd: 400_000 }),
      ],
      target,
      NOW,
    )

    expect(flow).toContain('1 sell totalling $400.0K')
  })

  it('ignores swaps for other tokens and older windows', () => {
    expect(describeFlow([swap({ tokenAddress: '0xother' })], target, NOW)).toBeUndefined()
    expect(describeFlow([swap({ at: minutesAgo(30) })], target, NOW)).toBeUndefined()
  })

  it('stays silent on a chain with no per-transaction source', () => {
    // No swaps is not "no selling" - it is no data. The line is absent, not zero.
    expect(describeFlow([], target, NOW)).toBeUndefined()
  })
})
