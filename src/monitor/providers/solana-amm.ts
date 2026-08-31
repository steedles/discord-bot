/**
 * Reading Solana pool accounts.
 *
 * Solana has no equivalent of an EVM `Sync` event: a swap does not announce the
 * new price, it rewrites an account. So the live price comes from subscribing to
 * whichever account holds the pool's state and decoding it - which means knowing
 * each AMM's byte layout.
 *
 * Every offset below was verified against live mainnet accounts rather than read
 * off a document, and the captured bytes are in `__tests__/solana-fixtures.ts`
 * so the decoders are tested against what a validator actually served. A wrong
 * offset does not throw; it produces a price out by orders of magnitude and a
 * dip alert fires on it. Tests are the only thing that catches that.
 *
 * Three of the four AMMs price the same way - reserves of one side against the
 * other - so they differ only in where the vault addresses live. Meteora is the
 * exception and is explained at `dlmmPrice`.
 */

/** Program owners, which is how a pool announces which decoder it needs. */
export const SOLANA_PROGRAMS = {
  pumpSwap: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  pumpFun: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  raydiumV4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  meteoraDlmm: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  splToken: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  /**
   * pump.fun mints are Token-2022, so their vaults are owned by this rather than
   * the classic token program. The first 165 bytes are the same either way, so
   * the balance is read identically - but code that checks the owner has to
   * accept both or it decides a real vault is not a vault.
   */
  splToken2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
} as const

/** Either token program: a vault can be owned by either, and both hold the
 * balance at the same offset. */
export function isTokenAccountOwner(owner: string): boolean {
  return owner === SOLANA_PROGRAMS.splToken || owner === SOLANA_PROGRAMS.splToken2022
}

export type PoolKind = 'pump-swap' | 'raydium-v4' | 'meteora-dlmm' | 'pump-curve'

export function poolKindFor(owner: string): PoolKind | undefined {
  switch (owner) {
    case SOLANA_PROGRAMS.pumpSwap:
      return 'pump-swap'
    case SOLANA_PROGRAMS.raydiumV4:
      return 'raydium-v4'
    case SOLANA_PROGRAMS.meteoraDlmm:
      return 'meteora-dlmm'
    case SOLANA_PROGRAMS.pumpFun:
      return 'pump-curve'
    default:
      return undefined
  }
}

// --- base58, for reading a pubkey out of a byte range ----------------------

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Only ever used on 32-byte keys, so the simple bigint form is fast enough. */
export function base58(bytes: Uint8Array): string {
  let value = 0n
  for (const byte of bytes) value = value * 256n + BigInt(byte)

  let out = ''
  while (value > 0n) {
    out = B58_ALPHABET[Number(value % 58n)] + out
    value /= 58n
  }

  // Leading zero bytes are '1's, and dropping them changes the address.
  for (const byte of bytes) {
    if (byte !== 0) break
    out = `1${out}`
  }

  return out
}

const key = (data: Buffer, offset: number): string => base58(data.subarray(offset, offset + 32))

// --- vault-priced pools ----------------------------------------------------

/** Where a pool keeps the two sides it prices against each other. */
export interface VaultPool {
  kind: PoolKind
  baseMint: string
  quoteMint: string
  baseVault: string
  quoteVault: string
  /** Raydium stores decimals in the pool; elsewhere they come from the mints. */
  baseDecimals?: number
  quoteDecimals?: number
}

/**
 * PumpSwap, the AMM a pump.fun coin lands in after graduation - and so the one
 * most of a call-tracking watchlist ends up on.
 *
 * Verified: base mint at 43 matched the watched token, quote at 75 was WSOL, and
 * both vault accounts reported the matching mints.
 */
export function decodePumpSwapPool(data: Buffer): VaultPool | undefined {
  if (data.length < 203) return undefined
  return {
    kind: 'pump-swap',
    baseMint: key(data, 43),
    quoteMint: key(data, 75),
    baseVault: key(data, 139),
    quoteVault: key(data, 171),
  }
}

/**
 * Raydium AMM v4, which carries its own decimals rather than making us read the
 * mints. Offsets follow the SDK's field order and were confirmed against the
 * SOL/USDC pool: 0.23% from DexScreener's own figure.
 */
export function decodeRaydiumV4Pool(data: Buffer): VaultPool | undefined {
  if (data.length < 464) return undefined
  return {
    kind: 'raydium-v4',
    baseDecimals: Number(data.readBigUInt64LE(32)),
    quoteDecimals: Number(data.readBigUInt64LE(40)),
    baseVault: key(data, 336),
    quoteVault: key(data, 368),
    baseMint: key(data, 400),
    quoteMint: key(data, 432),
  }
}

/** An SPL token account holds its mint at 0 and its balance at 64. */
export function decodeTokenAccount(data: Buffer): { mint: string; amount: bigint } | undefined {
  if (data.length < 72) return undefined
  return { mint: key(data, 0), amount: data.readBigUInt64LE(64) }
}

/** Decimals live at offset 44 of a mint account. */
export function decodeMintDecimals(data: Buffer): number | undefined {
  if (data.length < 45) return undefined
  return data[44]
}

/** Price of the base token in the quote token, from two vault balances. */
export function priceFromVaults(
  baseAmount: bigint,
  baseDecimals: number,
  quoteAmount: bigint,
  quoteDecimals: number,
): number | undefined {
  if (baseAmount <= 0n || quoteAmount <= 0n) return undefined

  const base = Number(baseAmount) / 10 ** baseDecimals
  const quote = Number(quoteAmount) / 10 ** quoteDecimals
  if (!Number.isFinite(base) || !Number.isFinite(quote) || base === 0) return undefined

  const price = quote / base
  return Number.isFinite(price) && price > 0 ? price : undefined
}

// --- Meteora DLMM ----------------------------------------------------------

export interface DlmmPair {
  kind: 'meteora-dlmm'
  tokenXMint: string
  tokenYMint: string
  reserveX: string
  reserveY: string
  activeId: number
  binStep: number
}

export function decodeMeteoraPair(data: Buffer): DlmmPair | undefined {
  if (data.length < 216) return undefined
  return {
    kind: 'meteora-dlmm',
    activeId: data.readInt32LE(76),
    binStep: data.readUInt16LE(80),
    tokenXMint: key(data, 88),
    tokenYMint: key(data, 120),
    reserveX: key(data, 152),
    reserveY: key(data, 184),
  }
}

/**
 * Price of token X in token Y on a DLMM pair.
 *
 * **Not** the ratio of its reserves. Liquidity is concentrated into bins, so the
 * two reserves say how much is sitting either side of the current price rather
 * than what the price is - on the pair checked, the reserve ratio was out by a
 * factor of six hundred. The price is the active bin: each bin is `binStep`
 * basis points wide, so the price is that step compounded `activeId` times.
 *
 * Verified against a live pair at 0.26% from DexScreener.
 */
export function dlmmPrice(activeId: number, binStep: number): number | undefined {
  if (!Number.isFinite(activeId) || !Number.isFinite(binStep)) return undefined
  if (binStep <= 0) return undefined

  const price = (1 + binStep / 10_000) ** activeId
  return Number.isFinite(price) && price > 0 ? price : undefined
}

// --- pump.fun bonding curve ------------------------------------------------

export interface BondingCurve {
  virtualTokenReserves: bigint
  virtualSolReserves: bigint
  /** Graduated to an AMM. The curve stops moving and the pool takes over. */
  complete: boolean
}

export function decodeBondingCurve(data: Buffer): BondingCurve | undefined {
  if (data.length < 49) return undefined
  return {
    virtualTokenReserves: data.readBigUInt64LE(8),
    virtualSolReserves: data.readBigUInt64LE(16),
    complete: data[48] !== 0,
  }
}

/** Price in SOL on the curve. SOL is 9 decimals; the token's are its own. */
export function bondingCurvePrice(curve: BondingCurve, tokenDecimals: number): number | undefined {
  if (curve.virtualTokenReserves <= 0n || curve.virtualSolReserves <= 0n) return undefined

  const sol = Number(curve.virtualSolReserves) / 1e9
  const tokens = Number(curve.virtualTokenReserves) / 10 ** tokenDecimals
  if (tokens === 0) return undefined

  const price = sol / tokens
  return Number.isFinite(price) && price > 0 ? price : undefined
}
