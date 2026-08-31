import { addressKind, getChain, isSupportedChain } from './chains.js'
import {
  getPairsForToken,
  getPairsForTokens,
  priceOf,
  searchPairs,
  selectPricePair,
  type DexPair,
} from './dexscreener.js'
import { lookupKnown, type KnownToken } from './known-tokens.js'

export interface TokenMatch {
  chainId: string
  address: string
  symbol: string
  /** The pair to quote prices from - outliers already rejected. */
  pair: DexPair
  liquidityUsd: number
  volume24h: number
  score: number
}

export interface ResolveResult {
  pair: DexPair
  /** Runner-up tokens that also matched. */
  alternatives: TokenMatch[]
  /**
   * True when the query was a ticker rather than an address. Tickers are not
   * unique - the caller should show the contract address so a member can check
   * they got the token they meant.
   */
  bySymbol: boolean
  /**
   * True when the token came from an address, or from the curated registry of
   * canonical tickers. False means it was matched by fuzzy search and could be
   * an impostor - say so in the reply.
   */
  verified: boolean
}

export class TokenNotFoundError extends Error {
  constructor(query: string, chainId?: string) {
    // "Try pasting the contract address" is useless advice to somebody who just
    // pasted one, so the hint is only offered when the query was a ticker.
    const looksLikeAddress = addressKind(query.trim().replace(/^\$/, '')) !== 'unknown'

    super(
      chainId
        ? `No traded pair found for "${query}" on ${getChain(chainId)?.label ?? chainId}.`
        : looksLikeAddress
          ? `No traded pair found for "${query}". Nothing on any supported chain is trading this contract.`
          : `No traded pair found for "${query}". Try pasting the contract address.`,
    )
    this.name = 'TokenNotFoundError'
  }
}

/**
 * The token exists and trades - just not anywhere this bot reads.
 *
 * Worth its own error because the two cases need opposite responses: a token
 * nobody trades is a dead end, while a token on an unlisted chain is a decision
 * about which chains to support. Reporting both as "not found" sends somebody
 * looking for a typo in an address that was correct.
 */
export class UnsupportedChainError extends TokenNotFoundError {
  constructor(
    query: string,
    readonly chains: string[],
    readonly symbol?: string,
  ) {
    super(query)
    this.name = 'UnsupportedChainError'

    const named = chains.map((c) => getChain(c)?.label ?? titleCase(c))
    const list =
      named.length === 1
        ? named[0]!
        : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]!}`

    this.message =
      `**${symbol ?? 'That token'}** trades on ${list}, which this bot does not support.\n` +
      `The contract address is fine - there is just no data feed configured for ${named.length === 1 ? 'that chain' : 'those chains'}.`
  }
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/** Tickers are written "$WIF", "wif" and "WIF" interchangeably. */
function normalizeSymbol(symbol: string): string {
  return symbol.trim().replace(/^\$/, '').toLowerCase()
}

/** How many search hits get a full per-address lookup. Each one is a request. */
const MAX_CANDIDATES = 8

/**
 * Turns "$WIF", "wif" or a raw contract address into the pair we should quote.
 *
 * Symbol lookup runs in two stages on purpose. DexScreener's search returns one
 * pair per match, and for a popular ticker that is mostly impostors - often
 * with the real token represented only by a dead pool. Ranking those directly
 * picks the impostor. So we take the matching token *addresses*, re-query each
 * one on its own for its full pool list, and rank on liquidity combined with
 * real trading volume.
 *
 * Even then a ticker is a guess. Search does not always return the canonical
 * token at all, so callers must surface the contract address rather than let a
 * member assume. An address query is exact and has none of this ambiguity.
 */
export async function resolveToken(query: string, chainId?: string): Promise<ResolveResult> {
  const trimmed = query.trim().replace(/^\$/, '')
  if (!trimmed) throw new TokenNotFoundError(query, chainId)

  const kind = addressKind(trimmed)

  if (kind !== 'unknown') {
    const { matches, unsupported } = await resolveByAddress(trimmed, kind, chainId)
    const winner = matches[0]

    if (!winner) {
      // An address that resolves to real pools on chains we do not read is a
      // different problem from an address nothing trades, and saying so saves
      // somebody hunting for a typo that is not there.
      if (unsupported.chains.length > 0) {
        throw new UnsupportedChainError(query, unsupported.chains, unsupported.symbol)
      }
      throw new TokenNotFoundError(query, chainId)
    }

    return { pair: winner.pair, alternatives: [], bySymbol: false, verified: true }
  }

  // Majors are pinned to known addresses so a copycat can never win.
  const known = lookupKnown(trimmed, chainId)
  if (known.length > 0) {
    const matches = await resolveKnown(known)
    const winner = matches[0]
    if (winner) {
      return { pair: winner.pair, alternatives: matches.slice(1, 4), bySymbol: true, verified: true }
    }
    // Fall through to search if the pinned addresses are somehow untradeable.
  }

  const matches = await resolveBySymbol(trimmed, chainId)
  const winner = matches[0]
  if (!winner) throw new TokenNotFoundError(query, chainId)

  return { pair: winner.pair, alternatives: matches.slice(1, 4), bySymbol: true, verified: false }
}

/** Quotes a curated ticker from its pinned addresses, deepest chain first. */
async function resolveKnown(entries: KnownToken[]): Promise<TokenMatch[]> {
  const byAddress = await getPairsForTokens(entries.map((e) => e.address))

  const pairs: DexPair[] = []
  for (const entry of entries) {
    const list = byAddress.get(entry.address.toLowerCase()) ?? []
    pairs.push(...list.filter((p) => p.chainId === entry.chainId))
  }

  return rankMatches(pairs)
}

interface AddressResolution {
  matches: TokenMatch[]
  /** Chains the token does trade on that this bot has no feed for. */
  unsupported: { chains: string[]; symbol?: string }
}

async function resolveByAddress(
  address: string,
  kind: 'solana' | 'evm',
  chainId?: string,
): Promise<AddressResolution> {
  const pairs = await getPairsForToken(address)

  // The same address string can be valid on more than one chain, so narrow to
  // the chain family the address format implies before picking a winner.
  const scoped = pairs.filter((p) => {
    if (!isSupportedChain(p.chainId)) return false
    if (chainId) return p.chainId === chainId
    return getChain(p.chainId)?.kind === kind
  })

  const matches = rankMatches(scoped)
  if (matches.length > 0) return { matches, unsupported: { chains: [] } }

  const foreign = pairs.filter((p) => !isSupportedChain(p.chainId))

  return {
    matches,
    unsupported: {
      chains: [...new Set(foreign.map((p) => p.chainId))],
      symbol: foreign[0]?.baseToken.symbol,
    },
  }
}

async function resolveBySymbol(symbol: string, chainId?: string): Promise<TokenMatch[]> {
  const hits = await searchPairs(symbol)
  const wanted = normalizeSymbol(symbol)

  let scoped = hits.filter((p) => isSupportedChain(p.chainId))
  if (chainId) scoped = scoped.filter((p) => p.chainId === chainId)
  if (scoped.length === 0) return []

  // An exact ticker match beats a fuzzy name match every time. Fall back to the
  // fuzzy set only when nothing matches exactly.
  const exact = scoped.filter((p) => normalizeSymbol(p.baseToken.symbol) === wanted)
  const shortlist = exact.length > 0 ? exact : scoped

  const addresses: string[] = []
  const seen = new Set<string>()
  for (const pair of shortlist) {
    const key = pair.baseToken.address.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    addresses.push(pair.baseToken.address)
    if (addresses.length >= MAX_CANDIDATES) break
  }

  const byAddress = await getPairsForTokens(addresses)

  let usable = [...byAddress.values()].flat().filter((p) => isSupportedChain(p.chainId))
  if (chainId) usable = usable.filter((p) => p.chainId === chainId)

  if (exact.length > 0) {
    const stillExact = usable.filter((p) => normalizeSymbol(p.baseToken.symbol) === wanted)
    if (stillExact.length > 0) usable = stillExact
  }

  const ranked = rankMatches(usable)
  // If every re-query came back empty, fall back to what search gave us.
  return ranked.length > 0 ? ranked : rankMatches(shortlist)
}

/**
 * Groups pairs by token and ranks on the geometric mean of liquidity and 24h
 * volume. Both matter: an impostor can park a small pool to fake depth but has
 * no real flow, and volume without depth is not quotable. The geometric mean
 * demands both, which is what separates the real token from the copies.
 */
function rankMatches(pairs: DexPair[]): TokenMatch[] {
  const grouped = new Map<string, DexPair[]>()

  for (const pair of pairs) {
    const key = `${pair.chainId}:${pair.baseToken.address.toLowerCase()}`
    const list = grouped.get(key)
    if (list) list.push(pair)
    else grouped.set(key, [pair])
  }

  const matches: TokenMatch[] = []
  for (const list of grouped.values()) {
    const pair = selectPricePair(list)
    if (!pair || priceOf(pair) === undefined) continue

    const liquidityUsd = list.reduce((sum, p) => sum + (p.liquidity?.usd ?? 0), 0)
    const volume24h = list.reduce((sum, p) => sum + (p.volume?.h24 ?? 0), 0)

    matches.push({
      chainId: pair.chainId,
      address: pair.baseToken.address,
      symbol: pair.baseToken.symbol,
      pair,
      liquidityUsd,
      volume24h,
      score: Math.sqrt(liquidityUsd * volume24h),
    })
  }

  // A brand new token can legitimately have no volume yet, in which case every
  // geometric mean is zero - fall back to raw depth.
  const anyScored = matches.some((m) => m.score > 0)
  matches.sort((a, b) => (anyScored ? b.score - a.score : b.liquidityUsd - a.liquidityUsd))

  return matches
}

/** Current USD price for a token we already resolved, or undefined if it went dark. */
export async function refreshPrice(chainId: string, tokenAddress: string): Promise<number | undefined> {
  const pairs = await getPairsForToken(tokenAddress)
  const pair = selectPricePair(pairs, chainId)
  return pair ? priceOf(pair) : undefined
}
