import { describe, expect, it } from 'vitest'
import { passesGates, passesHolderGate, type QualityGates } from '../detect/gates.js'
import { HOUR, NOW, snapshot } from './fixtures.js'

const gates: QualityGates = {
  minLiquidityUsd: 50_000,
  minPairAgeMinutes: 24 * 60,
  minTxns5m: 5,
  minVolume24hUsd: 25_000,
  chains: [],
}

describe('passesGates', () => {
  it('passes a token that clears everything', () => {
    expect(passesGates(snapshot(), gates, NOW).ok).toBe(true)
  })

  it('rejects a pool too thin to absorb a position', () => {
    const result = passesGates(snapshot({ liquidityUsd: 9_000 }), gates, NOW)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('liquidity')
  })

  it('rejects a pool created in the last day', () => {
    const fresh = snapshot({ pairCreatedAt: NOW - 3 * HOUR })
    const result = passesGates(fresh, gates, NOW)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('old')
  })

  it('treats an unknown pool age as a failure, not as old enough', () => {
    const undated = snapshot({ pairCreatedAt: undefined })
    expect(passesGates(undated, gates, NOW).ok).toBe(false)
  })

  it('rejects a token whose volume is a handful of trades', () => {
    const quiet = snapshot({ txns: { m5: { buys: 1, sells: 1 } } })
    const result = passesGates(quiet, gates, NOW)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('txns')
  })

  it('treats missing transaction data as unproven activity', () => {
    const blind = snapshot({ txns: {} })
    expect(passesGates(blind, gates, NOW).ok).toBe(false)
  })

  it('skips the activity check when the admin has not asked for one', () => {
    const blind = snapshot({ txns: {} })
    expect(passesGates(blind, { ...gates, minTxns5m: 0 }, NOW).ok).toBe(true)
  })

  it('rejects a chain the channel did not ask for', () => {
    const result = passesGates(snapshot(), { ...gates, chains: ['ethereum', 'bsc'] }, NOW)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('solana')
  })

  it('treats an empty chain list as every chain', () => {
    expect(passesGates(snapshot(), { ...gates, chains: [] }, NOW).ok).toBe(true)
  })

  it('rejects a token with liquidity parked in it but nobody trading', () => {
    const idle = snapshot({ volume: { m5: 0, h24: 900 } })
    const result = passesGates(idle, gates, NOW)

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('24h volume')
  })
})

describe('passesHolderGate', () => {
  it('is off when no minimum is set', () => {
    expect(passesHolderGate(undefined, 0).ok).toBe(true)
  })

  it('passes a token with enough holders', () => {
    expect(passesHolderGate(1_200, 500).ok).toBe(true)
  })

  it('rejects a token with too few', () => {
    expect(passesHolderGate(80, 500).ok).toBe(false)
  })

  it('rejects an unknown holder count rather than assuming it is fine', () => {
    const result = passesHolderGate(undefined, 500)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('unavailable')
  })
})
