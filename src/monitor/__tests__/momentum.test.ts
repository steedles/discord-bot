import { describe, expect, it } from 'vitest'
import { detectMomentum, sampleWindows, type MomentumConfig } from '../detect/momentum.js'
import type { Reading } from '../detect/types.js'
import { MINUTE, NOW, snapshot } from './fixtures.js'

const config: MomentumConfig = {
  windows: 3,
  windowMinutes: 15,
  minPriceGainPct: 5,
  minVolumeGainPct: 20,
  highPriorityPriceGainPct: 25,
}

/**
 * Readings at exactly the three window boundaries the detector looks for, plus
 * the snapshot itself as the fourth sample.
 */
function boundaries(prices: [number, number, number], volumes: [number, number, number]): Reading[] {
  return [45, 30, 15].map((minutesAgo, i) => ({
    at: NOW - minutesAgo * MINUTE,
    priceUsd: prices[i]!,
    volH1: volumes[i]!,
  }))
}

describe('detectMomentum', () => {
  it('fires on consecutive windows of rising volume and rising price', () => {
    const history = boundaries([1.0, 1.05, 1.1], [40_000, 50_000, 60_000])
    const now = snapshot({ priceUsd: 1.2, volume: { h1: 80_000 } })

    const trigger = detectMomentum(now, history, config)

    expect(trigger).toBeDefined()
    expect(trigger!.kind).toBe('momentum')
    expect(trigger!.value).toBeCloseTo(20, 5)
    expect(trigger!.headline).toBe('3 straight 15m windows of rising volume and price')
  })

  it('refuses when one window in the run goes the wrong way', () => {
    // Volume dips in the middle. Three windows minus one is not three windows.
    const history = boundaries([1.0, 1.05, 1.1], [40_000, 38_000, 60_000])
    const now = snapshot({ priceUsd: 1.2, volume: { h1: 80_000 } })

    expect(detectMomentum(now, history, config)).toBeUndefined()
  })

  it('refuses volume without price - that is churn, not momentum', () => {
    const history = boundaries([1.0, 1.0, 1.0], [40_000, 50_000, 60_000])
    const now = snapshot({ priceUsd: 1.0, volume: { h1: 80_000 } })

    expect(detectMomentum(now, history, config)).toBeUndefined()
  })

  it('refuses price without volume', () => {
    const history = boundaries([1.0, 1.05, 1.1], [60_000, 60_000, 60_000])
    const now = snapshot({ priceUsd: 1.2, volume: { h1: 60_000 } })

    expect(detectMomentum(now, history, config)).toBeUndefined()
  })

  it('refuses a run that is real but too small to be worth saying', () => {
    // Every window rises, but the whole move is under 1%.
    const history = boundaries([1.0, 1.001, 1.002], [40_000, 50_000, 60_000])
    const now = snapshot({ priceUsd: 1.003, volume: { h1: 80_000 } })

    expect(detectMomentum(now, history, config)).toBeUndefined()
  })

  it('will not invent a run when history has a hole in it', () => {
    // The 30-minute boundary has no reading anywhere near it.
    const history: Reading[] = [
      { at: NOW - 45 * MINUTE, priceUsd: 1.0, volH1: 40_000 },
      { at: NOW - 15 * MINUTE, priceUsd: 1.1, volH1: 60_000 },
    ]
    const now = snapshot({ priceUsd: 1.2, volume: { h1: 80_000 } })

    expect(sampleWindows(now, history, config)).toBeUndefined()
    expect(detectMomentum(now, history, config)).toBeUndefined()
  })

  it('will not reach for a reading that describes a different moment', () => {
    // Readings exist, but each is a full window away from where it is needed.
    const history: Reading[] = [
      { at: NOW - 53 * MINUTE, priceUsd: 1.0, volH1: 40_000 },
      { at: NOW - 38 * MINUTE, priceUsd: 1.05, volH1: 50_000 },
      { at: NOW - 23 * MINUTE, priceUsd: 1.1, volH1: 60_000 },
    ]
    const now = snapshot({ priceUsd: 1.2, volume: { h1: 80_000 } })

    expect(detectMomentum(now, history, config)).toBeUndefined()
  })

  it('marks a strong run high priority', () => {
    const history = boundaries([1.0, 1.1, 1.2], [40_000, 50_000, 60_000])
    const now = snapshot({ priceUsd: 1.4, volume: { h1: 80_000 } })

    const trigger = detectMomentum(now, history, config)
    expect(trigger!.value).toBeCloseTo(40, 5)
    expect(trigger!.priority).toBe('high')
  })

  it('samples oldest first so gains are measured in the right direction', () => {
    const history = boundaries([1.0, 1.05, 1.1], [40_000, 50_000, 60_000])
    const now = snapshot({ priceUsd: 1.2, volume: { h1: 80_000 } })

    const samples = sampleWindows(now, history, config)!
    expect(samples).toHaveLength(4)
    expect(samples[0]!.price).toBe(1.0)
    expect(samples[3]!.price).toBe(1.2)
  })
})
