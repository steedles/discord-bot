import { describe, expect, it } from 'vitest'
import { computeDistributionSignal } from '../rugSignature.js'
import type { OwnedHolder } from '../holders.js'

function holders(pcts: number[], overrides: Partial<OwnedHolder> = {}): OwnedHolder[] {
  return pcts.map((pct, i) => ({ owner: `wallet-${i}`, pct, ...overrides }))
}

describe('computeDistributionSignal', () => {
  it('flags a scripted-flat cohort - NINE1NINE\'s real reading, 11 wallets within 0.06pp of each other', () => {
    const flat = holders([1.508, 1.501, 1.497, 1.492, 1.488, 1.481, 1.476, 1.47, 1.463, 1.455, 1.448])

    const result = computeDistributionSignal(flat)

    expect(result.verdict).toBe('flag')
    expect(result.cv).not.toBeNull()
    expect(result.cv!).toBeLessThan(0.1)
    expect(result.cohort).toBe(10)
    expect(result.reason).toBe('flat-holder-distribution')
  })

  it('clears an organic power-law taper', () => {
    // Shaped like a real graduate's top 10 (MEGA, in-sample) - a wide, decreasing spread.
    const organic = holders([2.91, 2.666, 2.629, 2.619, 2.468, 2.42, 2.064, 1.897, 1.751, 1.727])

    const result = computeDistributionSignal(organic)

    expect(result.verdict).toBe('clean')
    expect(result.cv!).toBeGreaterThan(0.1)
    expect(result.reason).toBe('organic-distribution')
  })

  it('refuses below the resolvable-holder floor - unknown, never clean', () => {
    const thin = holders([5, 5, 5, 5, 5, 5, 5]) // 7 - one short of MIN_DISTRIBUTION_HOLDERS

    const result = computeDistributionSignal(thin)

    expect(result.verdict).toBe('unknown')
    expect(result.cv).toBeNull()
    expect(result.cohort).toBeNull()
    expect(result.reason).toContain('7/8')
  })

  it('never reads a flat cohort padded past the floor as clean', () => {
    // Exactly at MIN_DISTRIBUTION_HOLDERS, still perfectly flat.
    const flat = holders([1, 1, 1, 1, 1, 1, 1, 1])

    const result = computeDistributionSignal(flat)

    expect(result.verdict).toBe('flag')
    expect(result.cohort).toBe(8)
  })

  it('excludes insider-tagged wallets before sampling the top 10', () => {
    // Two disclosed team wallets sit at the very top with an identical, flat
    // share - without exclusion they would anchor the sample flat. The real
    // top 10 non-insider wallets taper normally once they are skipped.
    const withInsiders: OwnedHolder[] = [
      { owner: 'team-1', pct: 5, insider: true },
      { owner: 'team-2', pct: 5, insider: true },
      ...holders([2.91, 2.666, 2.629, 2.619, 2.468, 2.42, 2.064, 1.897, 1.751, 1.727]),
    ]

    const result = computeDistributionSignal(withInsiders)

    expect(result.verdict).toBe('clean')
    expect(result.cohort).toBe(10)
  })

  it('drops below the floor once enough insiders are excluded', () => {
    const mostlyInsider: OwnedHolder[] = [
      ...holders([1, 1, 1, 1, 1, 1], { insider: true }),
      ...holders([1, 1, 1, 1, 1, 1, 1]), // 7 non-insider left - one short
    ]

    const result = computeDistributionSignal(mostlyInsider)

    expect(result.verdict).toBe('unknown')
  })
})
