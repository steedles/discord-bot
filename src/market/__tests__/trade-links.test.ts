import { describe, expect, it } from 'vitest'
import { axiomUrl, gmgnUrl, jupiterUrl, tradeLinks } from '../trade-links.js'

const MINT = 'GiAXHqgpNXcjMTRVDvUk2kr4ZnARePn8Zg7nCTTZpump'
const POOL = 'FnzKY6x7entQ1111111111111111111111111111111'
const EVM = '0xBEEA1111111111111111111111111111117777'

describe('gmgnUrl', () => {
  it('builds the four chains GMGN covers', () => {
    expect(gmgnUrl('solana', MINT)).toBe(`https://gmgn.ai/sol/token/${MINT}`)
    expect(gmgnUrl('ethereum', EVM)).toBe(`https://gmgn.ai/eth/token/${EVM}`)
    expect(gmgnUrl('bsc', EVM)).toBe(`https://gmgn.ai/bsc/token/${EVM}`)
    expect(gmgnUrl('base', EVM)).toBe(`https://gmgn.ai/base/token/${EVM}`)
  })

  it('has no link for a chain GMGN does not cover', () => {
    // Robinhood Chain is absent from GMGN, and a guessed slug would 404 in an
    // alert someone is about to act on.
    expect(gmgnUrl('robinhood', EVM)).toBeUndefined()
    expect(gmgnUrl('arbitrum', EVM)).toBeUndefined()
  })
})

describe('jupiterUrl', () => {
  it('takes the mint, and only on Solana', () => {
    expect(jupiterUrl('solana', MINT)).toBe(`https://jup.ag/tokens/${MINT}`)
    expect(jupiterUrl('ethereum', EVM)).toBeUndefined()
    expect(jupiterUrl('robinhood', EVM)).toBeUndefined()
  })
})

describe('axiomUrl', () => {
  it('uses the PumpSwap pool address, never the mint', () => {
    // Axiom's path is the pool or bonding curve. Passing a mint gives a page
    // for nothing.
    expect(axiomUrl('solana', 'pumpswap', POOL)).toBe(`https://axiom.trade/meme/${POOL}?chain=sol`)
  })

  it('refuses a pool Axiom is not known to accept', () => {
    // A Raydium or Meteora pool is not a PumpSwap pool, and the bonding-curve
    // PDA those tokens would need cannot be derived without a Solana SDK.
    expect(axiomUrl('solana', 'raydium', POOL)).toBeUndefined()
    expect(axiomUrl('solana', 'meteora', POOL)).toBeUndefined()
    expect(axiomUrl('solana', undefined, POOL)).toBeUndefined()
  })

  it('needs a pool address, and only works on Solana', () => {
    expect(axiomUrl('solana', 'pumpswap', undefined)).toBeUndefined()
    expect(axiomUrl('bsc', 'pumpswap', POOL)).toBeUndefined()
  })

  it('matches dexId case-insensitively', () => {
    expect(axiomUrl('solana', 'PumpSwap', POOL)).toBeDefined()
  })
})

describe('tradeLinks', () => {
  it('offers every venue that can be built, FOMO first', () => {
    const links = tradeLinks('solana', MINT, { dexId: 'pumpswap', pairAddress: POOL })
    expect(links.map((l) => l.label)).toEqual(['FOMO', 'Axiom', 'GMGN', 'Jupiter'])
  })

  it('drops Axiom for a non-PumpSwap Solana pair, keeping the rest', () => {
    const links = tradeLinks('solana', MINT, { dexId: 'raydium', pairAddress: POOL })
    expect(links.map((l) => l.label)).toEqual(['FOMO', 'GMGN', 'Jupiter'])
  })

  it('gives an EVM chain only what applies there', () => {
    expect(tradeLinks('bsc', EVM).map((l) => l.label)).toEqual(['FOMO', 'GMGN'])
  })

  it('leaves Robinhood Chain with FOMO alone', () => {
    // FOMO is the only one of the four that indexes it.
    expect(tradeLinks('robinhood', EVM).map((l) => l.label)).toEqual(['FOMO'])
  })

  it('says "FOMO" rather than "Trade on FOMO"', () => {
    expect(tradeLinks('solana', MINT)[0]?.label).toBe('FOMO')
  })
})
