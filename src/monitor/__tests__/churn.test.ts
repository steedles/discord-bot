import { describe, expect, it } from 'vitest'
import { detectChurn, type ChurnConfig } from '../detect/churn.js'
import { snapshot } from './fixtures.js'

const config: ChurnConfig = {
  minTurnover: 3,
  maxImbalancePct: 15,
  maxPriceChangePct: 5,
  minVolume1hUsd: 50_000,
  highPriorityTurnover: 8,
}

/** A token being passed around: cap turned over six times, matched, going nowhere. */
function churning(overrides: Parameters<typeof snapshot>[0] = {}) {
  return snapshot({
    marketCapUsd: 200_000,
    volume: { m5: 90_000, h1: 1_200_000, h6: 4_000_000, h24: 6_000_000 },
    txns: { m5: { buys: 90, sells: 88 }, h1: { buys: 1_100, sells: 1_060 } },
    priceChange: { m5: -0.5, h1: -12, h24: -40 },
    ...overrides,
  })
}

describe('detectChurn', () => {
  it('fires when the cap turns over repeatedly, matched, with nothing to show', () => {
    const trigger = detectChurn(churning(), config)

    expect(trigger?.kind).toBe('churn')
    expect(trigger?.value).toBeCloseTo(6, 5)
    expect(trigger?.headline).toContain('6.0x its market cap')
    expect(trigger?.headline).toContain('-12.0%')
  })

  it('states the arithmetic rather than a verdict', () => {
    const trigger = detectChurn(churning(), config)

    expect(trigger?.detail[0]).toBe('$1.20M traded in 1h against a $200.0K market cap')
    expect(trigger?.detail[1]).toContain('1,100 buys / 1,060 sells')
    expect(trigger?.detail.join(' ')).not.toMatch(/pvp|extract|scam|avoid/i)
  })

  it('stays quiet when the volume bought something', () => {
    expect(detectChurn(churning({ priceChange: { h1: 40 } }), config)).toBeUndefined()
  })

  it('stays quiet when the book is one-sided', () => {
    // A dump is a different event with a different name.
    const dumping = churning({ txns: { h1: { buys: 300, sells: 1_800 } } })
    expect(detectChurn(dumping, config)).toBeUndefined()
  })

  it('stays quiet below the turnover threshold', () => {
    expect(detectChurn(churning({ marketCapUsd: 2_000_000 }), config)).toBeUndefined()
  })

  it('checks the absolute floor before the ratio', () => {
    // 20x turnover on $30k of trading is arithmetic, not a market.
    const tiny = churning({ marketCapUsd: 1_500, volume: { h1: 30_000 } })
    expect(detectChurn(tiny, config)).toBeUndefined()
  })

  it('refuses a missing leg rather than assuming it', () => {
    expect(detectChurn(churning({ txns: {} }), config)).toBeUndefined()
    expect(detectChurn(churning({ priceChange: {} }), config)).toBeUndefined()
    expect(detectChurn(churning({ marketCapUsd: undefined }), config)).toBeUndefined()
    expect(detectChurn(churning({ volume: { h1: undefined } }), config)).toBeUndefined()
  })

  it('raises priority on the heaviest turnover', () => {
    expect(detectChurn(churning(), config)?.priority).toBe('normal')
    expect(detectChurn(churning({ marketCapUsd: 100_000 }), config)?.priority).toBe('high')
  })

  it('scores as a multiple of the threshold, comparable with other detectors', () => {
    expect(detectChurn(churning(), config)?.score).toBeCloseTo(2, 5)
  })
})
