import { describe, expect, it } from 'vitest'
import { assessMarket } from '../market.js'
import type { DexPair } from '../../market/dexscreener.js'

const NOW = Date.now()

function pair(overrides: Partial<DexPair> = {}): DexPair {
  return {
    chainId: 'solana',
    dexId: 'raydium',
    url: 'https://dexscreener.com/solana/pool',
    pairAddress: 'POOL',
    baseToken: { address: 'MINT', name: 'Test', symbol: 'TEST' },
    quoteToken: { address: 'SOL', name: 'Wrapped SOL', symbol: 'SOL' },
    priceNative: '0.001',
    liquidity: { usd: 80_000 },
    volume: { h24: 120_000 },
    pairCreatedAt: NOW - 40 * 24 * 60 * 60_000,
    ...overrides,
  }
}

const labels = (p: DexPair) => assessMarket(p).flags.map((f) => f.label)

describe('assessMarket', () => {
  describe('liquidity nobody reported', () => {
    /**
     * The report this was written for: a pump.fun bonding curve seven minutes
     * old with $69k traded and 588 holders, headlined "POOL IS EMPTY - you
     * would not be able to sell" because DexScreener returns `liquidity: null`
     * for a curve and the code read that as zero.
     */
    const curve = pair({
      dexId: 'pumpfun',
      liquidity: undefined,
      volume: { h24: 69_000 },
      pairCreatedAt: NOW - 7 * 60_000,
    })

    it('does not call the pool empty', () => {
      expect(assessMarket(curve).untradeable).toBe(false)
      expect(labels(curve).join(' ')).not.toContain('POOL IS EMPTY')
    })

    it('does not claim liquidity was pulled off the volume', () => {
      expect(labels(curve).join(' ')).not.toContain('yet the pool is now empty')
      expect(labels(curve).join(' ')).not.toContain('× liquidity')
    })

    it('says the figure is missing, and why, as a warning rather than a finding', () => {
      const flag = assessMarket(curve).flags.find((f) => f.label.includes('not reported'))

      expect(flag?.severity).toBe('warn')
      expect(flag?.detail).toContain('bonding curve')
      expect(flag?.detail).toContain('not evidence')
    })

    it('names a bonding curve only where the venue says so', () => {
      const other = pair({ dexId: 'raydium', liquidity: undefined })
      const flag = assessMarket(other).flags.find((f) => f.label.includes('not reported'))

      expect(flag?.detail).not.toContain('bonding curve')
    })

    it('still reports everything that does not need the figure', () => {
      expect(labels(curve)).toContain('Only 7m old')
    })

    it('treats an unusable figure the same as a missing one', () => {
      const broken = pair({ liquidity: { usd: Number.NaN } })
      expect(assessMarket(broken).untradeable).toBe(false)
    })
  })

  describe('liquidity somebody measured', () => {
    it('still catches a drained pool', () => {
      const drained = pair({ liquidity: { usd: 0 }, volume: { h24: 240_000 } })

      expect(assessMarket(drained).untradeable).toBe(true)
      expect(labels(drained)[0]).toContain('POOL IS EMPTY')
      expect(labels(drained)[1]).toContain('yet the pool is now empty')
    })

    it('still bands a thin pool', () => {
      expect(labels(pair({ liquidity: { usd: 3_000 }, volume: {} }))[0]).toContain('Very low liquidity')
      expect(labels(pair({ liquidity: { usd: 18_000 }, volume: {} }))[0]).toContain('Low liquidity')
    })

    it('still flags volume far above the pool it traded through', () => {
      const washy = pair({ liquidity: { usd: 30_000 }, volume: { h24: 900_000 } })
      expect(labels(washy).join(' ')).toContain('30× liquidity')
    })

    it('says nothing about a healthy pool', () => {
      expect(labels(pair())).toEqual([])
    })
  })
})
