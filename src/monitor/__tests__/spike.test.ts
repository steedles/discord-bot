import { describe, expect, it } from 'vitest'
import {
  detectSpike,
  measuredBaseline,
  priorWindowRates,
  spikeBaseline,
  type SpikeConfig,
} from '../detect/spike.js'
import { MINUTE, NOW, readings, snapshot } from './fixtures.js'

const config: SpikeConfig = {
  multiplier: 5,
  minVolume5mUsd: 10_000,
  highPriorityMultiplier: 10,
}

describe('spikeBaseline', () => {
  it('takes the median of the derived rates rather than any single window', () => {
    // Rates: h1 -> 5000, h6 -> 5000, h24 -> 5000. All agree.
    expect(spikeBaseline(snapshot(), [])).toBe(5_000)
  })

  it('is not dragged around by one distorted window', () => {
    // A spike inflates h1 far above the longer windows. The median ignores it,
    // which is the whole reason for using one.
    const inflated = snapshot({ volume: { m5: 90_000, h1: 600_000, h6: 360_000, h24: 1_440_000 } })

    // Rates: 50000 (h1), 5000 (h6), 5000 (h24) -> median 5000.
    expect(spikeBaseline(inflated, [])).toBe(5_000)
  })

  it('returns undefined when no window reports any volume', () => {
    expect(spikeBaseline(snapshot({ volume: {} }), [])).toBeUndefined()
  })
})

describe('measuredBaseline', () => {
  it('needs at least three non-overlapping samples', () => {
    const two = readings(2, { stepMinutes: 10, volM5: 4_000 })
    expect(measuredBaseline(two, NOW)).toBeUndefined()

    const three = readings(3, { stepMinutes: 10, volM5: 4_000 })
    expect(measuredBaseline(three, NOW)).toBe(4_000)
  })

  it('discards readings that overlap, rather than counting the same trades twice', () => {
    // Thirty readings a minute apart cover half an hour, but each 5m window
    // shares four minutes with the one before it. Only readings 5m+ apart count,
    // so half an hour yields six samples - enough - while a minute-apart burst
    // over four minutes yields one and is refused.
    const dense = readings(4, { stepMinutes: 1, volM5: 4_000 })
    expect(measuredBaseline(dense, NOW)).toBeUndefined()

    const spread = readings(6, { stepMinutes: 5, volM5: 4_000 })
    expect(measuredBaseline(spread, NOW)).toBe(4_000)
  })

  it('ignores readings older than the history window', () => {
    const stale = readings(6, { stepMinutes: 5, volM5: 4_000, endAt: NOW - 12 * 60 * MINUTE })
    expect(measuredBaseline(stale, NOW)).toBeUndefined()
  })
})

describe('detectSpike', () => {
  it('fires when 5m volume clears the multiplier', () => {
    // Baseline 5000, so 45000 is 9x.
    const busy = snapshot({ volume: { m5: 45_000, h1: 60_000, h6: 360_000, h24: 1_440_000 } })
    const trigger = detectSpike(busy, [], config)

    expect(trigger).toBeDefined()
    expect(trigger!.kind).toBe('spike')
    expect(trigger!.value).toBeCloseTo(9, 5)
    expect(trigger!.headline).toBe('5m volume 9.0x its baseline')
    expect(trigger!.priority).toBe('normal')
  })

  it('stays quiet below the multiplier', () => {
    const mild = snapshot({ volume: { m5: 20_000, h1: 60_000, h6: 360_000, h24: 1_440_000 } })
    expect(detectSpike(mild, [], config)).toBeUndefined()
  })

  it('refuses a huge ratio on a trivial amount of money', () => {
    // 400x its baseline, and completely meaningless: $800 changed hands.
    const dust = snapshot({ volume: { m5: 800, h1: 24, h6: 144, h24: 576 } })
    expect(detectSpike(dust, [], config)).toBeUndefined()
  })

  it('marks the biggest moves high priority so they can ping a role', () => {
    const huge = snapshot({ volume: { m5: 60_000, h1: 60_000, h6: 360_000, h24: 1_440_000 } })
    expect(detectSpike(huge, [], config)!.priority).toBe('high')
  })

  it('describes a token with no prior volume instead of dividing by zero', () => {
    const woken = snapshot({ volume: { m5: 25_000 } })
    const trigger = detectSpike(woken, [], config)

    expect(trigger).toBeDefined()
    expect(trigger!.headline).toContain('first significant volume')
    expect(Number.isFinite(trigger!.value)).toBe(true)
    expect(trigger!.detail).toContain('No prior volume to compare against')
  })

  it('lets measured history raise the bar for a token that is always bursty', () => {
    // Derived rates all say 5000/5m. Measured history says this token really
    // does 40000 every five minutes, so 45000 is ordinary for it.
    const bursty = snapshot({ volume: { m5: 45_000, h1: 60_000, h6: 360_000, h24: 1_440_000 } })
    const history = readings(6, { stepMinutes: 6, volM5: 40_000 })

    // Estimates 5000, 5000, 5000, 40000 -> median 5000.
    expect(spikeBaseline(bursty, history)).toBe(5_000)
    expect(detectSpike(bursty, history, config)).toBeDefined()

    // Once two of the four estimates agree that it is busy, the median moves and
    // the same reading is no longer a spike.
    const alsoBusy = snapshot({ volume: { m5: 45_000, h1: 480_000, h6: 360_000, h24: 1_440_000 } })
    expect(spikeBaseline(alsoBusy, history)).toBe(22_500)
    expect(detectSpike(alsoBusy, history, config)).toBeUndefined()
  })

  it('scores by how far past the threshold it went', () => {
    const nine = snapshot({ volume: { m5: 45_000, h1: 60_000, h6: 360_000, h24: 1_440_000 } })
    const six = snapshot({ volume: { m5: 30_000, h1: 60_000, h6: 360_000, h24: 1_440_000 } })

    expect(detectSpike(nine, [], config)!.score).toBeGreaterThan(detectSpike(six, [], config)!.score)
  })
})

describe('baseline excluding the live window', () => {
  /**
   * The realistic case: a coin that has been running hard for an hour, which is
   * exactly when somebody posts it. Quiet for a day before that.
   *
   *   m5  $60k
   *   h1  $600k  -> the pump itself
   *   h6  $640k  -> $40k across the five hours before it
   *   h24 $700k  -> $60k across the eighteen before that
   */
  const pumping = snapshot({
    volume: { m5: 60_000, h1: 600_000, h6: 640_000, h24: 700_000 },
  })

  it('measures the stretch before the current window, not including it', () => {
    // 540_000/11 ; 40_000/60 ; 60_000/216
    expect(priorWindowRates(pumping)).toEqual([540_000 / 11, 40_000 / 60, 60_000 / 216])
  })

  it('reports the size of the move rather than a diluted version of it', () => {
    const including = spikeBaseline(pumping, [])!
    const excluding = spikeBaseline(pumping, [], true)!

    // The ordinary baseline still carries the pump hour at full weight.
    expect(including).toBeCloseTo(640_000 / 72, 6)
    expect(excluding).toBeCloseTo(40_000 / 60, 6)
    expect(including / excluding).toBeGreaterThan(10)
  })

  it('fires where the ordinary baseline would have stayed quiet', () => {
    const config: SpikeConfig = {
      multiplier: 10,
      minVolume5mUsd: 10_000,
      highPriorityMultiplier: 20,
    }

    // 60k against an 8.9k baseline is 6.7x - under the bar, so nothing is said
    // about the very move that got the coin posted.
    expect(detectSpike(pumping, [], config)).toBeUndefined()

    const trigger = detectSpike(pumping, [], { ...config, excludeCurrentWindow: true })
    expect(trigger?.value).toBeCloseTo(90, 0)
    expect(trigger?.detail.join(' ')).toContain('55m before this one')
  })

  it('says "no basis" when the whole hour happened in the last five minutes', () => {
    // Nothing to subtract: h1 is the m5. That is not a quiet baseline, it is no
    // baseline, and the detector has to say so rather than divide by a crumb.
    const brandNew = snapshot({ volume: { m5: 40_000, h1: 40_000, h6: 40_000, h24: 40_000 } })

    expect(priorWindowRates(brandNew)).toEqual([])
    expect(spikeBaseline(brandNew, [], true)).toBeUndefined()

    const trigger = detectSpike(brandNew, [], {
      multiplier: 5,
      minVolume5mUsd: 10_000,
      highPriorityMultiplier: 12,
      excludeCurrentWindow: true,
    })
    expect(trigger?.headline).toContain('first significant volume')
  })

  it('leaves a manually watched token on the ordinary baseline', () => {
    // Same snapshot, no flag: unchanged behaviour for anything added by hand.
    expect(spikeBaseline(pumping, [])).toBe(spikeBaseline(pumping, [], false))
  })
})

describe('detectSpike direction filter', () => {
  const spiking = { volume: { m5: 90_000, h1: 60_000, h6: 360_000, h24: 1_440_000 } }
  const upOnly: SpikeConfig = { ...config, direction: 'up' }

  it('fires on a spike in either direction by default', () => {
    // Volume-only is the honest default: heavy selling is news too.
    expect(detectSpike(snapshot({ ...spiking, priceChange: { m5: -8 } }), [], config)).toBeDefined()
    expect(detectSpike(snapshot({ ...spiking, priceChange: { m5: 8 } }), [], config)).toBeDefined()
  })

  it('drops a red-candle spike when the channel wants up only', () => {
    expect(detectSpike(snapshot({ ...spiking, priceChange: { m5: -8 } }), [], upOnly)).toBeUndefined()
  })

  it('keeps a green-candle spike when the channel wants up only', () => {
    expect(detectSpike(snapshot({ ...spiking, priceChange: { m5: 8 } }), [], upOnly)).toBeDefined()
  })

  it('treats a flat five minutes as not up', () => {
    expect(detectSpike(snapshot({ ...spiking, priceChange: { m5: 0 } }), [], upOnly)).toBeUndefined()
  })

  it('refuses an unmeasured direction rather than letting it through', () => {
    // Otherwise "up only" quietly becomes "up, or nobody checked".
    expect(detectSpike(snapshot({ ...spiking, priceChange: {} }), [], upOnly)).toBeUndefined()
  })

  it('judges direction over the same window the volume spiked in', () => {
    // 5m down, 1h up. The spike is a five-minute event, so five minutes decides.
    const mixed = snapshot({ ...spiking, priceChange: { m5: -4, h1: 60, h24: 120 } })
    expect(detectSpike(mixed, [], upOnly)).toBeUndefined()
  })
})
