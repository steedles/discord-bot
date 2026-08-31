import { describe, expect, it } from 'vitest'
import { callRetirement, detectCallSpike, type CallConfig, type CallState } from '../detect/call.js'
import { MINUTE, NOW, snapshot } from './fixtures.js'

const config: CallConfig = {
  alertMultiples: [1.5, 2, 5],
  watchMinutes: 10,
  minMarketCapUsd: 20_000,
  stuckMinutes: 5,
  volumeFloors: [
    { upTo: 100_000, value: 500 },
    { upTo: 1_000_000, value: 5_000 },
    { upTo: null, value: 20_000 },
  ],
}

const call = (overrides: Partial<CallState> = {}): CallState => ({
  priceAtCall: 1,
  calledAt: NOW - 3 * MINUTE,
  alerted: [],
  ...overrides,
})

describe('detectCallSpike', () => {
  it('fires at the first multiple the call reaches', () => {
    const trigger = detectCallSpike(snapshot({ priceUsd: 1.6 }), call(), config)

    expect(trigger?.kind).toBe('call')
    expect(trigger?.threshold).toBe(1.5)
    expect(trigger?.headline).toContain('1.6x')
  })

  it('reports the highest multiple reached, not the next one up', () => {
    // A coin that 6x'd between two polls is one 5x alert, not 1.5x then 2x then 5x.
    const trigger = detectCallSpike(snapshot({ priceUsd: 6 }), call(), config)

    expect(trigger?.threshold).toBe(5)
  })

  it('never fires twice on the same multiple', () => {
    const already = call({ alerted: [1.5] })

    expect(detectCallSpike(snapshot({ priceUsd: 1.6 }), already, config)).toBeUndefined()
    // But the next rung up still counts.
    expect(detectCallSpike(snapshot({ priceUsd: 2.1 }), already, config)?.threshold).toBe(2)
  })

  it('stays silent when the call went down', () => {
    // Only green counts - nobody wants tagging in their own bad call.
    expect(detectCallSpike(snapshot({ priceUsd: 0.5 }), call(), config)).toBeUndefined()
    expect(detectCallSpike(snapshot({ priceUsd: 1 }), call(), config)).toBeUndefined()
  })

  it('says nothing without a price on either side', () => {
    expect(detectCallSpike(snapshot({ priceUsd: undefined }), call(), config)).toBeUndefined()
    expect(detectCallSpike(snapshot({ priceUsd: 2 }), call({ priceAtCall: 0 }), config)).toBeUndefined()
  })
})

describe('callRetirement', () => {
  it('keeps a fresh call whatever it looks like', () => {
    // Called two minutes ago at nothing: too early to judge, and a coin called
    // at launch has no volume yet by nature.
    const fresh = call({ calledAt: NOW - 2 * MINUTE })
    const dud = snapshot({ marketCapUsd: 5_000, volume: { m5: 0 } })

    expect(callRetirement(dud, fresh, config, NOW).retire).toBe(false)
  })

  it('drops one stuck under the market cap floor', () => {
    const result = callRetirement(
      snapshot({ marketCapUsd: 12_000 }),
      call({ calledAt: NOW - 6 * MINUTE }),
      config,
      NOW,
    )

    expect(result.retire).toBe(true)
    expect(result.reason).toContain('$20K')
  })

  it('drops one with effectively no volume for its size', () => {
    // $200 in five minutes on a $500k coin is under that band's $5k floor.
    const result = callRetirement(
      snapshot({ marketCapUsd: 500_000, volume: { m5: 200 } }),
      call({ calledAt: NOW - 6 * MINUTE }),
      config,
      NOW,
    )

    expect(result.retire).toBe(true)
    expect(result.reason).toContain('volume')
  })

  it('judges the same volume differently at different sizes', () => {
    const stale = call({ calledAt: NOW - 6 * MINUTE })
    const volume = { m5: 1_000 }

    // $1k of volume is alive on a $60k coin (floor $500)...
    expect(
      callRetirement(snapshot({ marketCapUsd: 60_000, volume }), stale, config, NOW).retire,
    ).toBe(false)

    // ...and dead on a $5m one, where the top band asks for $20k.
    expect(
      callRetirement(snapshot({ marketCapUsd: 5_000_000, volume }), stale, config, NOW).retire,
    ).toBe(true)
  })

  it('skips the volume rule when the market cap is unknown', () => {
    // No cap means no band, and picking one would be inventing the missing fact.
    const result = callRetirement(
      snapshot({ marketCapUsd: undefined, volume: { m5: 0 } }),
      call({ calledAt: NOW - 6 * MINUTE }),
      config,
      NOW,
    )

    expect(result.retire).toBe(false)
  })

  it('ages out on the clock even when it is doing fine', () => {
    const result = callRetirement(
      snapshot(),
      call({ calledAt: NOW - 11 * MINUTE }),
      config,
      NOW,
    )

    expect(result.retire).toBe(true)
    expect(result.reason).toContain('10m')
  })

  it('spares a call that already ran', () => {
    // It proved itself once, so it earns the poll until the window closes.
    const ran = call({ calledAt: NOW - 6 * MINUTE, alerted: [2] })

    expect(callRetirement(snapshot({ marketCapUsd: 9_000 }), ran, config, NOW).retire).toBe(false)
  })

  it('does not treat a failed poll as a dud', () => {
    const result = callRetirement(undefined, call({ calledAt: NOW - 6 * MINUTE }), config, NOW)

    expect(result.retire).toBe(false)
  })
})
