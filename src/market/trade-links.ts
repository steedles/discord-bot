/**
 * The venues an alert links out to, so someone can act on it.
 *
 * Every link here was confirmed against how the venue actually builds URLs
 * rather than guessed from its domain, because a 404 in a trading alert is worse
 * than a missing link - the same rule `fomo.ts` was written under. Where a venue
 * cannot be built correctly for a given token, it is omitted.
 *
 * ## How each one is built
 *
 * **FOMO** - `/tokens/<slug>/<token>`, slugs in `fomo.ts` (BNB Chain is `bnb`).
 *
 * **GMGN** - `/<slug>/token/<token>`, and it covers only Solana, Ethereum, BSC
 * and Base. Robinhood Chain is absent, so Robinhood tokens get no GMGN link.
 *
 * **Jupiter** - `/tokens/<mint>`, Solana only. The one format verified by HTTP:
 * GMGN and Axiom both sit behind Cloudflare and answer a scripted request with
 * 403 whatever the path, so neither could be checked that way.
 *
 * **Axiom** - the awkward one, and the reason this file has a comment this long.
 * Axiom does *not* take a mint: the path is `/meme/<poolOrCurveAddress>`, which
 * is the **PumpSwap pool** for a graduated token and the **pump.fun bonding
 * curve PDA** before that (`memefun`'s `axiomMint` / `deriveBcPda`).
 *
 * Deriving that PDA needs `findProgramAddressSync`, which needs ed25519 curve
 * arithmetic, which would mean adding a Solana SDK to a codebase that decodes
 * pool accounts by hand precisely to avoid one. It is not worth a dependency for
 * one URL - and it is not needed, because DexScreener already hands us the pool
 * address, and for a `pumpswap` pair that address *is* the PumpSwap pool.
 *
 * So: Axiom is linked when the pair is on PumpSwap, using the pool we already
 * have, and omitted otherwise. A Raydium or Meteora pool address is not
 * something Axiom is known to accept, and guessing would put a dead link in
 * front of someone about to trade. `dexId` is the signal rather than a `pump`
 * suffix on the mint - PANTS trades on PumpSwap with a mint that ends in neither.
 */
import { fomoUrl } from './fomo.js'

export interface TradeLink {
  label: string
  url: string
}

/** Our chain id to GMGN's slug. GMGN covers these four and no others. */
const GMGN_CHAIN: Record<string, string> = {
  solana: 'sol',
  ethereum: 'eth',
  bsc: 'bsc',
  base: 'base',
}

/** DexScreener dex ids whose pair address is a PumpSwap pool Axiom understands. */
const AXIOM_DEX_IDS = new Set(['pumpswap'])

export function gmgnUrl(chainId: string, tokenAddress: string): string | undefined {
  const slug = GMGN_CHAIN[chainId]
  if (!slug || !tokenAddress) return undefined
  return `https://gmgn.ai/${slug}/token/${tokenAddress}`
}

/** Jupiter is Solana-only, and takes the mint. */
export function jupiterUrl(chainId: string, tokenAddress: string): string | undefined {
  if (chainId !== 'solana' || !tokenAddress) return undefined
  return `https://jup.ag/tokens/${tokenAddress}`
}

/**
 * Axiom, from the PumpSwap pool address - never from the mint.
 *
 * Returns undefined for anything that is not a PumpSwap pair, because the
 * address Axiom wants for those is a bonding-curve PDA we cannot derive without
 * a Solana SDK, and the mint is not a substitute for it.
 */
export function axiomUrl(
  chainId: string,
  dexId: string | undefined,
  pairAddress: string | undefined,
): string | undefined {
  if (chainId !== 'solana' || !pairAddress) return undefined
  if (!dexId || !AXIOM_DEX_IDS.has(dexId.toLowerCase())) return undefined
  return `https://axiom.trade/meme/${pairAddress}?chain=sol`
}

/**
 * Every venue that can be built for this token, in the order they are shown.
 *
 * FOMO leads because it is where the group actually trades; the rest follow as
 * alternatives. A venue that cannot be built for this chain or pair is simply
 * not in the list.
 */
export function tradeLinks(
  chainId: string,
  tokenAddress: string,
  pair?: { dexId?: string; pairAddress?: string },
): TradeLink[] {
  const candidates: [string, string | undefined][] = [
    ['FOMO', fomoUrl(chainId, tokenAddress)],
    ['Axiom', axiomUrl(chainId, pair?.dexId, pair?.pairAddress)],
    ['GMGN', gmgnUrl(chainId, tokenAddress)],
    ['Jupiter', jupiterUrl(chainId, tokenAddress)],
  ]

  return candidates
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([label, url]) => ({ label, url }))
}

/** The same list as Discord markdown. */
export function tradeLinksMarkdown(
  chainId: string,
  tokenAddress: string,
  pair?: { dexId?: string; pairAddress?: string },
): string[] {
  return tradeLinks(chainId, tokenAddress, pair).map((l) => `[${l.label}](${l.url})`)
}
