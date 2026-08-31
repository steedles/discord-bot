import { describe, expect, it } from 'vitest'
import { sampleIsStale } from '../holders.js'

/**
 * The case this exists for: BOMB on Ethereum, where GoPlus had indexed the
 * contract once at launch and still reported 2 holders while the token had 89.
 * Reporting the corrected count beside GoPlus's two-wallet breakdown would have
 * combined one vendor's present with another's past.
 */
describe('sampleIsStale', () => {
  it('catches a snapshot taken at launch', () => {
    expect(sampleIsStale(2, 89)).toBe(true)
  })

  it('treats a count of zero as stale whenever anything else was counted', () => {
    expect(sampleIsStale(0, 40)).toBe(true)
  })

  it('leaves small counts alone, where a ratio means nothing', () => {
    // Twice as many, but four holders apart. Either vendor could be right and
    // the breakdown is still describing roughly this token.
    expect(sampleIsStale(4, 8)).toBe(false)
  })

  it('needs both a wide ratio and a real gap', () => {
    expect(sampleIsStale(600, 700)).toBe(false) // big gap, close ratio
    expect(sampleIsStale(9, 15)).toBe(false) // wide-ish ratio, small gap
    expect(sampleIsStale(50, 5_000)).toBe(true) // both
  })

  it('is symmetric - either vendor can be the stale one', () => {
    expect(sampleIsStale(89, 2)).toBe(true)
  })

  it('says nothing when there is nothing to compare', () => {
    expect(sampleIsStale(undefined, 89)).toBe(false)
    expect(sampleIsStale(2, undefined)).toBe(false)
    expect(sampleIsStale(Number.NaN, 89)).toBe(false)
  })

  it('agrees with itself', () => {
    expect(sampleIsStale(500, 500)).toBe(false)
  })
})
