import { describe, expect, it } from 'vitest'
import { detectVamp, normaliseTicker, type VampConfig } from '../detect/vamp.js'
import type { MarketSnapshot } from '../providers/types.js'
import { searchesPerCycle } from '../providers/ticker-search.js'
import { HOUR, MINUTE, NOW, snapshot } from './fixtures.js'

const config: VampConfig = {
  target: 'both',
  minVolumeRatio: 1.5,
  minCopycatVolume1hUsd: 50_000,
  minCopycatLiquidityUsd: 25_000,
  minCopycatTrades1h: 100,
  maxCopycatAgeMinutes: 1_440,
  highPriorityRatio: 3,
}

/** The established coin: a month old, trading $100k an hour. */
function original(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return snapshot({
    tokenAddress: 'ORIGINAL111111111111111111111111111111111111',
    symbol: 'WIF',
    name: 'dogwifhat',
    volume: { h1: 100_000 },
    txns: { h1: { buys: 400, sells: 380 } },
    pairCreatedAt: NOW - 30 * 24 * HOUR,
    ...overrides,
  })
}

/** The copy: three hours old, out-trading it three to one, with real depth. */
function copycat(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return snapshot({
    tokenAddress: 'COPYCAT11111111111111111111111111111111111111',
    symbol: '$wif',
    name: 'Wif Coin',
    liquidityUsd: 80_000,
    volume: { h1: 300_000 },
    txns: { h1: { buys: 900, sells: 850 } },
    pairCreatedAt: NOW - 3 * HOUR,
    url: 'https://dexscreener.com/solana/copy',
    ...overrides,
  })
}

describe('normaliseTicker', () => {
  it('compares tickers as the market says them', () => {
    expect(normaliseTicker('$WIF')).toBe('WIF')
    expect(normaliseTicker('w.i.f')).toBe('WIF')
  })

  it('refuses tickers too short for a match to mean anything', () => {
    expect(normaliseTicker('GM')).toBeUndefined()
    expect(normaliseTicker('$')).toBeUndefined()
  })
})

describe('detectVamp', () => {
  it('fires on the original when a newer same-ticker token out-trades it', () => {
    const trigger = detectVamp(original(), [copycat()], config)

    expect(trigger?.kind).toBe('vamp')
    expect(trigger?.value).toBeCloseTo(3, 5)
    expect(trigger?.headline).toContain('a newer $WIF is out-trading it 3.0x')
  })

  it('fires on the copy when the copy is the watched token', () => {
    const trigger = detectVamp(copycat(), [original()], config)

    expect(trigger?.headline).toContain('out-trading the original $WIF 3.0x')
    expect(trigger?.headline).toContain('launched 29.9d after it')
  })

  it('names the other token, its standing and its contract', () => {
    const detail = detectVamp(original(), [copycat()], config)?.detail.join('\n') ?? ''

    expect(detail).toContain('Wif Coin')
    expect(detail).toContain('$80.0K liquidity')
    expect(detail).toContain('1,750 trades in 1h')
    expect(detail).toContain('COPYCAT11111111111111111111111111111111111111')
  })

  it('says whether the names matched as well as the tickers', () => {
    const differing = detectVamp(original(), [copycat()], config)?.detail.join('\n') ?? ''
    expect(differing).toContain('names differ')

    // Compared as the eye reads them: "dog wif hat" is the same name as "dogwifhat".
    const same = detectVamp(original(), [copycat({ name: 'dog wif hat' })], config)
    expect(same?.detail.join('\n')).toContain('Ticker and name both match')
  })

  describe('a copy is a threat or it is nothing', () => {
    it('ignores a clone with no depth behind it', () => {
      expect(detectVamp(original(), [copycat({ liquidityUsd: 4_000 })], config)).toBeUndefined()
    })

    it('ignores volume from a handful of wallets', () => {
      const washed = copycat({ txns: { h1: { buys: 9, sells: 7 } } })
      expect(detectVamp(original(), [washed], config)).toBeUndefined()
    })

    it('ignores a clone doing nothing in absolute terms', () => {
      // The original is dead, so the ratio is huge and means nothing.
      const quiet = original({ volume: { h1: 900 } })
      const smallCopy = copycat({ volume: { h1: 20_000 } })
      expect(detectVamp(quiet, [smallCopy], config)).toBeUndefined()
    })

    it('ignores a clone still behind the original', () => {
      expect(detectVamp(original(), [copycat({ volume: { h1: 120_000 } })], config)).toBeUndefined()
    })

    it('fails a gate the provider did not answer rather than skipping it', () => {
      expect(detectVamp(original(), [copycat({ liquidityUsd: undefined })], config)).toBeUndefined()
      expect(detectVamp(original(), [copycat({ txns: {} })], config)).toBeUndefined()
    })
  })

  it('will not say which came first without both creation times', () => {
    expect(detectVamp(original(), [copycat({ pairCreatedAt: undefined })], config)).toBeUndefined()
    expect(
      detectVamp(original({ pairCreatedAt: undefined }), [copycat()], config),
    ).toBeUndefined()
  })

  it('ignores a shared ticker that has coexisted for too long', () => {
    const old = copycat({ pairCreatedAt: NOW - 20 * 24 * HOUR })
    expect(detectVamp(original(), [old], config)).toBeUndefined()
  })

  it('ignores the same token in another pool', () => {
    const samePool = copycat({ tokenAddress: 'ORIGINAL111111111111111111111111111111111111' })
    expect(detectVamp(original(), [samePool], config)).toBeUndefined()
  })

  it('ignores a matching ticker on another chain', () => {
    expect(detectVamp(original(), [copycat({ chainId: 'base' })], config)).toBeUndefined()
  })

  it('ignores a different ticker entirely', () => {
    expect(detectVamp(original(), [copycat({ symbol: 'BONK' })], config)).toBeUndefined()
  })

  describe('target', () => {
    it('original only hears about being drained', () => {
      const drained = { ...config, target: 'original' as const }
      expect(detectVamp(original(), [copycat()], drained)).toBeDefined()
      expect(detectVamp(copycat(), [original()], drained)).toBeUndefined()
    })

    it('copycat only hears about the one doing the draining', () => {
      const running = { ...config, target: 'copycat' as const }
      expect(detectVamp(copycat(), [original()], running)).toBeDefined()
      expect(detectVamp(original(), [copycat()], running)).toBeUndefined()
    })
  })

  it('reports the biggest of several copies once, not each of them', () => {
    const rivals = [
      copycat({ tokenAddress: 'COPY2', volume: { h1: 200_000 } }),
      copycat(),
      copycat({ tokenAddress: 'COPY3', volume: { h1: 160_000 } }),
    ]
    const trigger = detectVamp(original(), rivals, config)

    expect(trigger?.value).toBeCloseTo(3, 5)
  })

  it('raises priority once the copy is running away with it', () => {
    expect(detectVamp(original(), [copycat({ volume: { h1: 200_000 } })], config)?.priority).toBe(
      'normal',
    )
    expect(detectVamp(original(), [copycat()], config)?.priority).toBe('high')
  })

  it('measures the copy against the clock it was given', () => {
    const later = detectVamp(original(), [copycat()], config, NOW + 30 * MINUTE)
    expect(later?.detail.join('\n')).toContain('3.5h old')
  })
})

describe('searchesPerCycle', () => {
  it('spends a rate rather than a count, so a shorter poll does not spend more', () => {
    expect(searchesPerCycle(60)).toBe(4)
    expect(searchesPerCycle(20)).toBe(1)
    expect(searchesPerCycle(120)).toBe(8)
  })

  it('never rounds down to nothing, which would switch the feature off silently', () => {
    expect(searchesPerCycle(5)).toBe(1)
  })
})
