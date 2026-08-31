import { describe, expect, it } from 'vitest'
import {
  base58,
  bondingCurvePrice,
  decodeMeteoraPair,
  decodePumpSwapPool,
  decodeRaydiumV4Pool,
  decodeTokenAccount,
  dlmmPrice,
  isTokenAccountOwner,
  poolKindFor,
  priceFromVaults,
  SOLANA_PROGRAMS,
} from '../providers/solana-amm.js'
import { SOLANA_ACCOUNTS } from './solana-fixtures.js'

const bytes = (b64: string) => Buffer.from(b64, 'base64')

const WSOL = 'So11111111111111111111111111111111111111112'
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

describe('base58', () => {
  it('round-trips a known key from real account bytes', () => {
    // The pool's own address is not in its data, so this checks a field instead:
    // PumpSwap's quote mint is WSOL, whose encoding is unmistakable.
    const pool = bytes(SOLANA_ACCOUNTS.pumpSwapPool.base64)
    expect(base58(pool.subarray(75, 107))).toBe(WSOL)
  })

  it('keeps leading zero bytes as leading ones', () => {
    expect(base58(new Uint8Array([0, 0, 1]))).toBe('112')
  })
})

describe('poolKindFor', () => {
  it('identifies each program from the fixtures', () => {
    expect(poolKindFor(SOLANA_ACCOUNTS.pumpSwapPool.owner)).toBe('pump-swap')
    expect(poolKindFor(SOLANA_ACCOUNTS.raydiumPool.owner)).toBe('raydium-v4')
    expect(poolKindFor(SOLANA_ACCOUNTS.meteoraPair.owner)).toBe('meteora-dlmm')
    expect(poolKindFor(SOLANA_ACCOUNTS.pumpSwapBaseVault.owner)).toBeUndefined()
  })
})

describe('decodePumpSwapPool', () => {
  const pool = decodePumpSwapPool(bytes(SOLANA_ACCOUNTS.pumpSwapPool.base64))!

  it('finds the mints, with the watched token as base and SOL as quote', () => {
    expect(pool.baseMint).toBe('Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump')
    expect(pool.quoteMint).toBe(WSOL)
  })

  it('finds vaults that really hold those mints', () => {
    // The strongest check available: the vault the offset points at reports the
    // mint the pool said it would.
    const base = decodeTokenAccount(bytes(SOLANA_ACCOUNTS.pumpSwapBaseVault.base64))!
    const quote = decodeTokenAccount(bytes(SOLANA_ACCOUNTS.pumpSwapQuoteVault.base64))!

    expect(pool.baseVault).toBe(SOLANA_ACCOUNTS.pumpSwapBaseVault.address)
    expect(pool.quoteVault).toBe(SOLANA_ACCOUNTS.pumpSwapQuoteVault.address)
    expect(base.mint).toBe(pool.baseMint)
    expect(quote.mint).toBe(pool.quoteMint)
  })

  it('prices the pool where the aggregator priced it', () => {
    const base = decodeTokenAccount(bytes(SOLANA_ACCOUNTS.pumpSwapBaseVault.base64))!
    const quote = decodeTokenAccount(bytes(SOLANA_ACCOUNTS.pumpSwapQuoteVault.base64))!

    // Captured alongside a DexScreener reading of 0.0001668 SOL.
    const price = priceFromVaults(base.amount, 6, quote.amount, 9)!
    expect(price).toBeGreaterThan(0.00016)
    expect(price).toBeLessThan(0.00017)
  })

  it('refuses a buffer too short to be a pool', () => {
    expect(decodePumpSwapPool(Buffer.alloc(100))).toBeUndefined()
  })
})

describe('decodeRaydiumV4Pool', () => {
  const pool = decodeRaydiumV4Pool(bytes(SOLANA_ACCOUNTS.raydiumPool.base64))!

  it('reads the SOL/USDC pool, decimals included', () => {
    expect(pool.baseMint).toBe(WSOL)
    expect(pool.quoteMint).toBe(USDC)
    expect(pool.baseDecimals).toBe(9)
    expect(pool.quoteDecimals).toBe(6)
  })

  it('names vaults, not mints - the offsets are easy to transpose', () => {
    expect(pool.baseVault).not.toBe(pool.baseMint)
    expect(pool.baseVault).toBe('DQyrAcCrDXQ7NeoqGgDCZwBvWDcYmFCjSb9JtteuvPpz')
  })
})

describe('decodeMeteoraPair', () => {
  const pair = decodeMeteoraPair(bytes(SOLANA_ACCOUNTS.meteoraPair.base64))!

  it('finds both mints and both reserve accounts', () => {
    expect(pair.tokenXMint).toBe('6GmAFSYs4gk3FDao5FzzySQpPZaWsa4rUJHacpMpUNgx')
    expect(pair.tokenYMint).toBe(WSOL)
    expect(pair.reserveX).toBe('8f8q2LMFU4xBW5J2s5UVUcNXRVX6XBLi2LUbVZQoVJrY')
    expect(pair.reserveY).toBe('2TLs3JML8GBV39WVk275djo4MMhqvVG84jpeT2qLUFBp')
  })

  it('prices from the active bin, matching the aggregator', () => {
    // Captured alongside a DexScreener reading of 0.0000522 SOL.
    const price = dlmmPrice(pair.activeId, pair.binStep)!
    expect(price).toBeGreaterThan(0.00005)
    expect(price).toBeLessThan(0.000055)
  })

  it('is nothing like the ratio of its reserves', () => {
    // The trap this guards: concentrated liquidity means the reserves say how
    // much sits either side of the price, not what the price is. Reading them
    // as a constant-product pool underprices this pair by about 600x.
    const fromBins = dlmmPrice(pair.activeId, pair.binStep)!
    const fromReserves = priceFromVaults(35_905_578_330_844_235n, 6, 3_021_539_641_445n, 9)!

    expect(fromReserves / fromBins).toBeLessThan(0.01)
  })

  it('refuses a zero bin step rather than returning 1', () => {
    expect(dlmmPrice(-1977, 0)).toBeUndefined()
  })
})

describe('bondingCurvePrice', () => {
  it('prices a curve from its virtual reserves', () => {
    // 30 SOL against 1,000,000,000 tokens at 6 decimals.
    const curve = {
      virtualSolReserves: 30n * 10n ** 9n,
      virtualTokenReserves: 1_000_000_000n * 10n ** 6n,
      complete: false,
    }

    expect(bondingCurvePrice(curve, 6)).toBeCloseTo(3e-8, 12)
  })

  it('says nothing about an empty curve', () => {
    expect(
      bondingCurvePrice({ virtualSolReserves: 0n, virtualTokenReserves: 1n, complete: false }, 6),
    ).toBeUndefined()
  })
})

describe('token programs', () => {
  it('accepts a Token-2022 vault, which is what pump.fun mints use', () => {
    // Found by testing against real bytes: this vault is Token-2022, not the
    // classic program, and an owner check that knows only one rejects it.
    expect(SOLANA_ACCOUNTS.pumpSwapBaseVault.owner).toBe(SOLANA_PROGRAMS.splToken2022)
    expect(isTokenAccountOwner(SOLANA_ACCOUNTS.pumpSwapBaseVault.owner)).toBe(true)
    expect(isTokenAccountOwner(SOLANA_ACCOUNTS.pumpSwapQuoteVault.owner)).toBe(true)
    expect(isTokenAccountOwner(SOLANA_ACCOUNTS.pumpSwapPool.owner)).toBe(false)
  })
})
