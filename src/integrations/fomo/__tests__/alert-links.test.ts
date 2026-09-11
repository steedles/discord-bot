import { describe, expect, it } from 'vitest'
import type { FomoAlert } from '../../../db/models.js'
import { withLinks } from '../alert-store.js'

/**
 * The link rule, which is easy to get wrong in one specific direction.
 *
 * Axiom's URL takes a **pool** address, never a mint. A Fomo alert carries only
 * the mint, so the obvious implementation - `axiom.trade/meme/<tokenAddress>` -
 * produces a link that looks right and is dead. These tests exist to keep that
 * from being "fixed" back in.
 */

const alert = (over: Partial<FomoAlert> = {}): FomoAlert => ({
  eventId: 'e1',
  kind: 'BUY',
  traderVerified: false,
  createdAt: new Date(),
  receivedAt: new Date(),
  ...over,
})

describe('withLinks', () => {
  it('links the ticker to Fomo on every chain Fomo covers', () => {
    // The chains these alerts actually arrive on, measured over the first 46.
    for (const chainId of ['robinhood', 'bsc', 'solana', 'base', 'ethereum']) {
      const out = withLinks(alert({ chainId, tokenAddress: '0xabc' }))
      expect(out.fomoUrl, chainId).toBeDefined()
      expect(out.fomoUrl, chainId).toContain('fomo.family/tokens/')
    }
  })

  it('maps bsc to fomo’s own slug rather than ours', () => {
    // bnb, not bsc. The slugs are close enough to invite the assumption.
    expect(withLinks(alert({ chainId: 'bsc', tokenAddress: '0xabc' })).fomoUrl).toContain('/bnb/')
  })

  it('gives no Fomo link for a chain fomo does not cover', () => {
    expect(withLinks(alert({ chainId: 'sui', tokenAddress: '0xabc' })).fomoUrl).toBeUndefined()
  })

  it('gives no Fomo link when the alert carries no token address', () => {
    expect(withLinks(alert({ chainId: 'solana' })).fomoUrl).toBeUndefined()
  })

  it('builds an Axiom link from a resolved PumpSwap pool', () => {
    const out = withLinks(
      alert({ chainId: 'solana', tokenAddress: 'MiNt', dexId: 'pumpswap', pairAddress: 'PooL' }),
    )
    // The POOL is in the URL, never the mint.
    expect(out.axiomUrl).toBe('https://axiom.trade/meme/PooL?chain=sol')
    expect(out.axiomUrl).not.toContain('MiNt')
  })

  it('gives no Axiom link before the pool has resolved', () => {
    expect(withLinks(alert({ chainId: 'solana', tokenAddress: 'MiNt' })).axiomUrl).toBeUndefined()
  })

  it('refuses Axiom for a pool Axiom is not known to accept', () => {
    // A Raydium pool address is not a substitute. Guessing here would put a
    // dead link in front of someone about to trade.
    for (const dexId of ['raydium', 'meteora', 'orca']) {
      const out = withLinks(
        alert({ chainId: 'solana', tokenAddress: 'MiNt', dexId, pairAddress: 'PooL' }),
      )
      expect(out.axiomUrl, dexId).toBeUndefined()
    }
  })

  it('refuses Axiom off Solana even with a pool', () => {
    // Robinhood and BSC are the two most common chains here, and Axiom covers
    // neither - so this is the case that would fire most often if it were wrong.
    for (const chainId of ['robinhood', 'bsc', 'base', 'ethereum']) {
      const out = withLinks(
        alert({ chainId, tokenAddress: '0xabc', dexId: 'pumpswap', pairAddress: 'PooL' }),
      )
      expect(out.axiomUrl, chainId).toBeUndefined()
    }
  })
})
