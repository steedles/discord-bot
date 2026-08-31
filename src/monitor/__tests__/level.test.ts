import { describe, expect, it } from 'vitest'
import { detectLevelBreak, levelsBetween, type LevelConfig } from '../detect/level.js'
import type { MarketSnapshot } from '../providers/types.js'
import type { Reading } from '../detect/types.js'

const NOW = 1_800_000_000_000
const minutesAgo = (n: number) => NOW - n * 60_000

const config: LevelConfig = {
  bufferPct: 1,
  onFall: true,
  onRise: true,
  highPriorityPct: 15,
  maxLookbackMinutes: 30,
}

function snapshot(marketCapUsd: number | undefined): MarketSnapshot {
  return {
    chainId: 'bsc',
    tokenAddress: '0xtoken',
    pairAddress: '0xpool',
    symbol: 'TEST',
    name: 'Test',
    marketCapUsd,
    volume: {},
    txns: {},
    priceChange: {},
    hasSocials: false,
    fetchedAt: NOW,
  }
}

const prior = (marketCapUsd: number, at = minutesAgo(1)): Reading => ({ at, marketCapUsd })

describe('levelsBetween', () => {
  it('uses a 1-2-5 ladder rather than every round number', () => {
    expect(levelsBetween(900_000, 6_000_000)).toEqual([1_000_000, 2_000_000, 5_000_000])
  })

  it('spans orders of magnitude', () => {
    expect(levelsBetween(80_000, 300_000)).toEqual([100_000, 200_000])
  })

  it('excludes the endpoints themselves', () => {
    expect(levelsBetween(1_000_000, 2_000_000)).toEqual([])
  })

  it('returns nothing for a nonsense range', () => {
    expect(levelsBetween(0, 100)).toEqual([])
    expect(levelsBetween(500, 100)).toEqual([])
  })
})

describe('detectLevelBreak', () => {
  it('names a level the token fell through', () => {
    const trigger = detectLevelBreak(snapshot(19_500_000), [prior(21_000_000)], config, NOW)

    expect(trigger?.kind).toBe('level')
    expect(trigger?.headline).toBe('Market cap fell through $20.00M')
  })

  it('says nothing about a move that crossed no level', () => {
    // $29.71M to $28.32M is a real fall and breaks nothing anyone names. A
    // detector that produced a level here would be inventing one.
    expect(detectLevelBreak(snapshot(28_320_000), [prior(29_710_000)], config, NOW)).toBeUndefined()
  })

  it('names the level furthest into the move, not the first one crossed', () => {
    // Through $10M and $5M in one cycle: it broke $5M.
    const trigger = detectLevelBreak(snapshot(4_500_000), [prior(11_000_000)], config, NOW)
    expect(trigger?.headline).toContain('$5.00M')
  })

  it('reports a break upward as a break upward', () => {
    const trigger = detectLevelBreak(snapshot(11_000_000), [prior(9_400_000)], config, NOW)
    expect(trigger?.headline).toBe('Market cap broke above $10.00M')
  })

  it('stays silent while the value sits on the level', () => {
    // A hair under $10M would otherwise re-alert every cycle as it wobbles.
    const trigger = detectLevelBreak(snapshot(9_950_000), [prior(10_100_000)], config, NOW)
    expect(trigger).toBeUndefined()
  })

  it('respects a direction that has been switched off', () => {
    const fallOnly = { ...config, onRise: false }
    expect(detectLevelBreak(snapshot(11_000_000), [prior(9_400_000)], fallOnly, NOW)).toBeUndefined()
    expect(detectLevelBreak(snapshot(9_000_000), [prior(11_000_000)], fallOnly, NOW)).toBeDefined()
  })

  it('measures against the most recent prior reading, not the oldest', () => {
    // Comparing against 25 minutes ago would re-report a level crossed long ago.
    const history = [prior(31_000_000, minutesAgo(25)), prior(24_500_000, minutesAgo(1))]
    expect(detectLevelBreak(snapshot(24_400_000), history, config, NOW)).toBeUndefined()
  })

  it('will not compare against a reading that is too old to be a crossing', () => {
    const stale = [prior(29_710_000, minutesAgo(90))]
    expect(detectLevelBreak(snapshot(28_320_000), stale, config, NOW)).toBeUndefined()
  })

  it('says nothing when market cap was never recorded', () => {
    // Rows predating the market-cap column, and tokens the provider cannot size.
    expect(detectLevelBreak(snapshot(undefined), [prior(29_710_000)], config, NOW)).toBeUndefined()
    expect(detectLevelBreak(snapshot(28_320_000), [{ at: minutesAgo(1) }], config, NOW)).toBeUndefined()
  })

  it('raises priority for a large move rather than a large number', () => {
    const small = detectLevelBreak(snapshot(9_800_000), [prior(10_200_000)], config, NOW)
    const large = detectLevelBreak(snapshot(8_000_000), [prior(12_000_000)], config, NOW)

    expect(small?.priority).toBe('normal')
    expect(large?.priority).toBe('high')
  })
})
