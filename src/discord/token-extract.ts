import type { Message } from 'discord.js'
import { CHAINS, addressKind, getChain, isSupportedChain } from '../market/chains.js'

/**
 * Pulls token references out of a Discord message.
 *
 * This deliberately does not model any particular bot's embed layout. Rick's
 * output format is not documented and other token bots differ anyway, so
 * instead of parsing a structure we sweep every piece of text the message
 * carries - content, embed title, description, url, author, footer and every
 * field - and pick out anything that looks like a contract address or a link
 * that contains one. A layout change upstream then costs us nothing.
 *
 * Precision comes from the far end rather than the regex: a candidate is only
 * reported once DexScreener confirms it is a real traded token.
 */

export interface TokenRef {
  address: string
  /** DexScreener chain id, when the source made it unambiguous. */
  chainId?: string
  /**
   * Some links carry the *pair* address rather than the token address.
   * The resolver tries the token lookup first and falls back to the pair.
   */
  mayBePair: boolean
  /** Where it came from, for logging and the "why did you reply" question. */
  source: string
}

/** Every scrap of text a message carries, embeds included. */
export function messageText(message: Message): string {
  const parts: string[] = [message.content ?? '']

  for (const embed of message.embeds ?? []) {
    parts.push(
      embed.title ?? '',
      embed.description ?? '',
      embed.url ?? '',
      embed.author?.name ?? '',
      embed.author?.url ?? '',
      embed.footer?.text ?? '',
      embed.thumbnail?.url ?? '',
      embed.image?.url ?? '',
    )
    for (const field of embed.fields ?? []) {
      parts.push(field.name ?? '', field.value ?? '')
    }
  }

  return parts.filter(Boolean).join('\n')
}

// An EVM address, not preceded or followed by more hex - so a 64-char hash
// does not yield a bogus 40-char "address".
const EVM_RE = /(?<![a-fA-F0-9])(0x[a-fA-F0-9]{40})(?![a-fA-F0-9])/g

// Base58, 32-44 chars. Solana transaction signatures are 86-88 chars, so the
// upper bound keeps those out.
const B58_RE = /(?<![1-9A-HJ-NP-Za-km-z])([1-9A-HJ-NP-Za-km-z]{32,44})(?![1-9A-HJ-NP-Za-km-z])/g

/**
 * Chain slugs as they appear in third-party URLs, mapped to our chain ids.
 * DexScreener, DexTools and Birdeye all spell some chains differently.
 */
const URL_CHAIN_ALIASES: Record<string, string> = {
  solana: 'solana',
  sol: 'solana',
  ether: 'ethereum',
  ethereum: 'ethereum',
  eth: 'ethereum',
  bsc: 'bsc',
  bnb: 'bsc',
  binance: 'bsc',
  base: 'base',
  arbitrum: 'arbitrum',
  arbitrumone: 'arbitrum',
  arb: 'arbitrum',
  polygon: 'polygon',
  matic: 'polygon',
  optimism: 'optimism',
  op: 'optimism',
  avalanche: 'avalanche',
  avax: 'avalanche',
  blast: 'blast',
}

/**
 * Link shapes that pin a chain to an address.
 *
 * `pair` marks sources whose address is usually a pool rather than the token -
 * DexScreener and DexTools pair-explorer links in particular.
 */
const URL_PATTERNS: { re: RegExp; chainFrom: 'group' | string; pair: boolean; label: string }[] = [
  // dexscreener.com/solana/<pairOrToken>
  {
    re: /dexscreener\.com\/([a-z0-9]+)\/(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})/gi,
    chainFrom: 'group',
    pair: true,
    label: 'dexscreener',
  },
  // dextools.io/app/en/solana/pair-explorer/<pair>
  {
    re: /dextools\.io\/app\/[a-z-]*\/?([a-z0-9]+)\/pair-explorer\/(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})/gi,
    chainFrom: 'group',
    pair: true,
    label: 'dextools',
  },
  // birdeye.so/token/<mint>
  { re: /birdeye\.so\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})/gi, chainFrom: 'solana', pair: false, label: 'birdeye' },
  // solscan.io/token/<mint>
  { re: /solscan\.io\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})/gi, chainFrom: 'solana', pair: false, label: 'solscan' },
  // pump.fun/coin/<mint>
  { re: /pump\.fun\/(?:coin\/)?([1-9A-HJ-NP-Za-km-z]{32,44})/gi, chainFrom: 'solana', pair: false, label: 'pump.fun' },
  // etherscan / basescan / bscscan / arbiscan token pages
  { re: /etherscan\.io\/(?:token|address)\/(0x[a-fA-F0-9]{40})/gi, chainFrom: 'ethereum', pair: false, label: 'etherscan' },
  { re: /basescan\.org\/(?:token|address)\/(0x[a-fA-F0-9]{40})/gi, chainFrom: 'base', pair: false, label: 'basescan' },
  { re: /bscscan\.com\/(?:token|address)\/(0x[a-fA-F0-9]{40})/gi, chainFrom: 'bsc', pair: false, label: 'bscscan' },
  { re: /arbiscan\.io\/(?:token|address)\/(0x[a-fA-F0-9]{40})/gi, chainFrom: 'arbitrum', pair: false, label: 'arbiscan' },
  // app.bubblemaps.io/sol/token/<mint>
  {
    re: /bubblemaps\.io\/([a-z0-9]+)\/token\/(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})/gi,
    chainFrom: 'group',
    pair: false,
    label: 'bubblemaps',
  },
]

/** Chain named in prose, e.g. Rick printing "Chain: Solana". */
function chainFromProse(text: string): string | undefined {
  const lower = text.toLowerCase()
  for (const chain of Object.values(CHAINS)) {
    // Word-boundary match so "based" does not read as the Base chain.
    if (new RegExp(`\\b${chain.label.toLowerCase()}\\b`).test(lower)) return chain.id
    if (new RegExp(`\\bchain[:\\s]+${chain.id}\\b`).test(lower)) return chain.id
  }
  return undefined
}

/**
 * Extracts every plausible token reference, best-evidence first.
 *
 * Ordering matters: references that came from a link carrying an explicit chain
 * are more trustworthy than a bare address found in prose, so they are returned
 * first and the caller can stop at the first one that resolves.
 */
export function extractTokenRefs(text: string, limit = 5): TokenRef[] {
  const found: TokenRef[] = []
  const seen = new Set<string>()

  const add = (address: string, chainId: string | undefined, mayBePair: boolean, source: string): void => {
    const key = `${chainId ?? '?'}:${address.toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)
    found.push({ address, ...(chainId ? { chainId } : {}), mayBePair, source })
  }

  // Pass 1 - links, which usually name their chain.
  for (const pattern of URL_PATTERNS) {
    pattern.re.lastIndex = 0
    for (const match of text.matchAll(pattern.re)) {
      let chainId: string | undefined
      let address: string | undefined

      if (pattern.chainFrom === 'group') {
        chainId = URL_CHAIN_ALIASES[(match[1] ?? '').toLowerCase()]
        address = match[2]
      } else {
        chainId = pattern.chainFrom
        address = match[1]
      }

      if (!address) continue
      if (chainId && !isSupportedChain(chainId)) continue
      add(address, chainId, pattern.pair, pattern.label)
    }
  }

  // Pass 2 - bare addresses. A chain named in the surrounding text is a hint,
  // but only applied when it matches the address family.
  const prose = chainFromProse(text)

  for (const match of text.matchAll(EVM_RE)) {
    const address = match[1]!
    const hint = prose && getChain(prose)?.kind === 'evm' ? prose : undefined
    add(address, hint, false, 'address')
  }

  for (const match of text.matchAll(B58_RE)) {
    const address = match[1]!
    if (addressKind(address) !== 'solana') continue
    add(address, 'solana', false, 'address')
  }

  return found.slice(0, limit)
}

/** Convenience wrapper over a live Discord message. */
export function extractFromMessage(message: Message, limit = 5): TokenRef[] {
  return extractTokenRefs(messageText(message), limit)
}
