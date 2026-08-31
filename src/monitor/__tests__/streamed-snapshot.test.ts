import { describe, expect, it } from 'vitest'
import {
  applyStreamedPrice,
  baseIsUsable,
  MAX_BASE_AGE_MS,
} from '../providers/streamed-snapshot.js'
import { NOW, snapshot } from './fixtures.js'

describe('applyStreamedPrice', () => {
  it('replaces the price and keeps everything the stream cannot know', () => {
    const base = snapshot()
    const out = applyStreamedPrice(base, { priceUsd: 1.5, at: NOW + 3_000 })

    expect(out.priceUsd).toBe(1.5)
    expect(out.fetchedAt).toBe(NOW + 3_000)
    // Nothing in a swap event says how much traded in the last hour.
    expect(out.volume).toEqual(base.volume)
    expect(out.txns).toEqual(base.txns)
    expect(out.name).toBe(base.name)
    expect(out.hasSocials).toBe(base.hasSocials)
  })

  it('moves market cap with price, since supply did not change', () => {
    // Base is $1 at a $5M cap; doubling the price doubles the cap.
    const out = applyStreamedPrice(snapshot(), { priceUsd: 2, at: NOW })

    expect(out.marketCapUsd).toBeCloseTo(10_000_000, 6)
  })

  it('leaves market cap alone when there is no base price to scale from', () => {
    const base = snapshot({ priceUsd: undefined })
    const out = applyStreamedPrice(base, { priceUsd: 2, at: NOW })

    expect(out.marketCapUsd).toBe(base.marketCapUsd)
  })

  it('takes liquidity from a V2 pool and leaves it alone for V3', () => {
    const withReserves = applyStreamedPrice(snapshot(), {
      priceUsd: 1,
      liquidityUsd: 400_000,
      at: NOW,
    })
    const withoutReserves = applyStreamedPrice(snapshot(), { priceUsd: 1, at: NOW })

    expect(withReserves.liquidityUsd).toBe(400_000)
    expect(withoutReserves.liquidityUsd).toBe(250_000)
  })
})

describe('baseIsUsable', () => {
  it('accepts a recent poll and refuses a stale one', () => {
    const base = snapshot()

    expect(baseIsUsable(base, NOW + MAX_BASE_AGE_MS - 1_000)).toBe(true)
    // Past this the borrowed half of the snapshot describes a different moment.
    expect(baseIsUsable(base, NOW + MAX_BASE_AGE_MS + 1_000)).toBe(false)
  })
})
