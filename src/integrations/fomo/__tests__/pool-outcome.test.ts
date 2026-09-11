import { describe, expect, it } from 'vitest'
import type { DexPair, PairsLookup } from '../../../market/dexscreener.js'
import { poolFromLookup } from '../alert-store.js'

/**
 * The distinction the first version of this got wrong.
 *
 * It called `getPairsForToken`, which swallows failures and returns `[]`, so a
 * rate-limited request was indistinguishable from "this token has no pool" -
 * and got cached as the latter. In production every lookup was being 429'd, so
 * the feature resolved nothing and reported it as a fact about the tokens.
 */

const pair = (over: Partial<DexPair> = {}): DexPair =>
  ({
    chainId: 'solana',
    dexId: 'pumpswap',
    url: 'https://dexscreener.com/x',
    pairAddress: 'PooL',
    baseToken: { address: 'MiNt', name: 'x', symbol: 'X' },
    quoteToken: { address: 'So111', name: 'SOL', symbol: 'SOL' },
    priceNative: '1',
    ...over,
  }) as DexPair

const ok = (pairs: DexPair[]): PairsLookup => ({ ok: true, pairs })

describe('poolFromLookup', () => {
  it('says retry when the lookup did not happen', () => {
    // The bug: this must NOT be 'none'. A 429 is a fact about our rate limit,
    // not about the token, and caching it as 'none' is permanent.
    expect(poolFromLookup({ ok: false, reason: 'HttpError: HTTP 429' })).toBe('retry')
  })

  it('says none only when the lookup succeeded and found no PumpSwap pool', () => {
    expect(poolFromLookup(ok([]))).toBe('none')
    expect(poolFromLookup(ok([pair({ dexId: 'raydium' })]))).toBe('none')
    expect(poolFromLookup(ok([pair({ dexId: 'meteora' })]))).toBe('none')
  })

  it('returns the pool when there is one', () => {
    expect(poolFromLookup(ok([pair()]))).toEqual({ pairAddress: 'PooL', dexId: 'pumpswap' })
  })

  it('picks the PumpSwap pool out of a list rather than the first pair', () => {
    const result = poolFromLookup(
      ok([
        pair({ dexId: 'raydium', pairAddress: 'RayPool' }),
        pair({ dexId: 'pumpswap', pairAddress: 'PumpPool' }),
      ]),
    )
    expect(result).toEqual({ pairAddress: 'PumpPool', dexId: 'pumpswap' })
  })

  it('ignores a PumpSwap-looking pool on another chain', () => {
    expect(poolFromLookup(ok([pair({ chainId: 'base' })]))).toBe('none')
  })

  it('matches dexId case-insensitively', () => {
    expect(poolFromLookup(ok([pair({ dexId: 'PumpSwap' })]))).toEqual({
      pairAddress: 'PooL',
      dexId: 'PumpSwap',
    })
  })
})
