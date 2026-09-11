import { log } from '../logger.js'
import { fetchJson } from './http.js'
import { dexDiscoveryLimiter, dexPairsLimiter } from './limiter.js'

const BASE = 'https://api.dexscreener.com'

export interface DexToken {
  address: string
  name: string
  symbol: string
}

export interface DexPair {
  chainId: string
  dexId: string
  url: string
  pairAddress: string
  baseToken: DexToken
  quoteToken: DexToken
  priceNative: string
  priceUsd?: string
  txns?: Record<'m5' | 'h1' | 'h6' | 'h24', { buys: number; sells: number }>
  volume?: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', number>>
  priceChange?: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', number>>
  liquidity?: { usd?: number; base?: number; quote?: number }
  fdv?: number
  marketCap?: number
  pairCreatedAt?: number
  info?: {
    imageUrl?: string
    websites?: { label?: string; url: string }[]
    socials?: { type?: string; platform?: string; url: string; handle?: string }[]
  }
}

interface PairsResponse {
  schemaVersion?: string
  pairs: DexPair[] | null
}

export interface TokenProfile {
  url: string
  chainId: string
  tokenAddress: string
  icon?: string
  header?: string
  description?: string
  links?: { type?: string; label?: string; url: string }[]
}

/**
 * Every pair for a single token address.
 *
 * Always query one address at a time. The endpoint accepts a comma-separated
 * list, but it caps the response at 30 pairs *in total* - ask for 20 addresses
 * and each token comes back with roughly one arbitrary pair, which is not
 * enough to tell a real pool from a broken one.
 */
export async function getPairsForToken(address: string): Promise<DexPair[]> {
  const result = await lookupPairsForToken(address)
  if (result.ok) return result.pairs
  log.market.warn({ err: result.reason, address }, 'getPairsForToken failed')
  return []
}

/**
 * The same lookup, but saying whether it actually happened.
 *
 * `getPairsForToken` returns `[]` for both "this token has no pairs" and "the
 * request never succeeded", which is fine for a caller that only wants to skip
 * a token this cycle and disastrous for one recording a conclusion: a rate-
 * limited lookup gets written down as a fact about the token. A 429 is routine
 * here - the pairs budget is shared and usually at its ceiling - so any caller
 * that persists a negative must be able to tell the two apart.
 *
 * Same request, same limiter, same filtering. The only difference is that the
 * failure is handed back instead of being flattened into an empty list.
 */
export type PairsLookup = { ok: true; pairs: DexPair[] } | { ok: false; reason: string }

export async function lookupPairsForToken(address: string): Promise<PairsLookup> {
  try {
    const data = await fetchJson<PairsResponse>(`${BASE}/latest/dex/tokens/${address}`, {
      limiter: dexPairsLimiter,
    })
    return {
      ok: true,
      pairs: (data.pairs ?? []).filter((p) => p.baseToken.address.toLowerCase() === address.toLowerCase()),
    }
  } catch (err) {
    return { ok: false, reason: String(err) }
  }
}

/** Runs `fn` over `items` with at most `limit` requests in flight. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index]!)
    }
  })

  await Promise.all(workers)
  return results
}

/** Pairs for many tokens, keyed by lowercased address. One request per token. */
export async function getPairsForTokens(
  addresses: string[],
  concurrency = 8,
): Promise<Map<string, DexPair[]>> {
  const unique = [...new Set(addresses.map((a) => a.trim()).filter(Boolean))]
  const out = new Map<string, DexPair[]>()
  if (unique.length === 0) return out

  const lists = await mapWithConcurrency(unique, concurrency, getPairsForToken)
  unique.forEach((address, i) => {
    const pairs = lists[i] ?? []
    if (pairs.length > 0) out.set(address.toLowerCase(), pairs)
  })

  return out
}

/**
 * Most addresses DexScreener accepts in one batched path segment.
 *
 * Asking for 31 does not fail - it returns 200 with the thirty-first silently
 * missing, which is exactly the shape of bug that shows up weeks later as "that
 * coin never alerts". Every batched caller chunks to this.
 */
export const MAX_BATCH = 30

/** Splits into batches of at most `MAX_BATCH`. */
function chunk<T>(items: T[], size = MAX_BATCH): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * The single best pool for each of many tokens on one chain - **one request per
 * thirty tokens** instead of one per token.
 *
 * This is the cheap half of a trade-off, and the expensive half matters: the
 * endpoint returns exactly *one* pool per token, chosen by DexScreener. That is
 * enough to answer "does this token trade yet, and how deep is it" - which is
 * all discovery needs from a coin that is minutes old and has one pool by
 * definition.
 *
 * It is **not** enough to answer "what is this worth". `selectPricePair` spots a
 * lying pool by comparing pools against each other, and it cannot do that with a
 * sample of one. Anything pricing a token - alerts, briefs, the monitor's
 * snapshots - must keep asking per token, or batch by *pair* address through
 * `getPairsByAddresses` once the pools are known.
 */
export async function getTopPairPerToken(
  chainId: string,
  addresses: string[],
): Promise<Map<string, DexPair>> {
  const out = new Map<string, DexPair>()
  const unique = [...new Set(addresses.map((a) => a.trim()).filter(Boolean))]
  if (unique.length === 0) return out

  for (const batch of chunk(unique)) {
    try {
      const pairs = await fetchJson<DexPair[] | null>(
        `${BASE}/tokens/v1/${chainId}/${batch.join(',')}`,
        { limiter: dexPairsLimiter },
      )
      for (const pair of pairs ?? []) {
        const key = pair.baseToken.address.toLowerCase()
        if (!out.has(key)) out.set(key, pair)
      }
    } catch (err) {
      log.market.warn({ err: String(err), chainId, count: batch.length }, 'getTopPairPerToken failed')
    }
  }

  return out
}

/**
 * Full data for pools named by address - **one request per thirty pools**.
 *
 * Unlike the token endpoints, this returns exactly the pools asked for rather
 * than a capped sample, so a caller that already knows a token's pool set gets
 * every pool back and keeps `selectPricePair`'s cross-pool consensus. That is
 * what makes it the monitor's fast path: discover pools per token occasionally,
 * then re-read them in bulk on every poll.
 *
 * Batches are per chain because the chain is in the path.
 */
export async function getPairsByAddresses(
  chainId: string,
  pairAddresses: string[],
): Promise<DexPair[]> {
  const unique = [...new Set(pairAddresses.map((a) => a.trim()).filter(Boolean))]
  if (unique.length === 0) return []

  const out: DexPair[] = []
  for (const batch of chunk(unique)) {
    try {
      const data = await fetchJson<PairsResponse>(
        `${BASE}/latest/dex/pairs/${chainId}/${batch.join(',')}`,
        { limiter: dexPairsLimiter },
      )
      out.push(...(data.pairs ?? []))
    } catch (err) {
      log.market.warn({ err: String(err), chainId, count: batch.length }, 'getPairsByAddresses failed')
    }
  }

  return out
}

/** Free-text search - matches symbols, names and addresses. */
export async function searchPairs(query: string): Promise<DexPair[]> {
  const data = await fetchJson<PairsResponse>(`${BASE}/latest/dex/search?q=${encodeURIComponent(query)}`, {
    limiter: dexPairsLimiter,
  })
  return data.pairs ?? []
}

export async function getPair(chainId: string, pairAddress: string): Promise<DexPair | undefined> {
  const data = await fetchJson<PairsResponse>(`${BASE}/latest/dex/pairs/${chainId}/${pairAddress}`, {
    limiter: dexPairsLimiter,
  })
  return data.pairs?.[0]
}

/**
 * Newest token profiles across all chains. This is the launch scanner's
 * discovery feed - tokens appear here shortly after a team sets up their
 * DexScreener listing, which is early but not pure noise.
 * Rate limited to 60 requests/minute by DexScreener.
 */
export async function getLatestTokenProfiles(): Promise<TokenProfile[]> {
  const data = await fetchJson<TokenProfile[]>(`${BASE}/token-profiles/latest/v1`, {
    limiter: dexDiscoveryLimiter,
  })
  return Array.isArray(data) ? data : []
}

export interface BoostedToken {
  url: string
  chainId: string
  tokenAddress: string
  amount?: number
  totalAmount?: number
}

/**
 * Tokens whose listing has been boosted.
 *
 * This is *paid placement*, not a ranking - a team buys visibility and appears
 * here. It is a usable candidate feed only because whatever comes out of it is
 * then measured against real liquidity and volume before anything is watched.
 * Never present it to a reader as "trending".
 * Rate limited to 60 requests/minute by DexScreener.
 */
export async function getTopBoostedTokens(): Promise<BoostedToken[]> {
  const data = await fetchJson<BoostedToken[]>(`${BASE}/token-boosts/top/v1`, {
    limiter: dexDiscoveryLimiter,
  })
  return Array.isArray(data) ? data : []
}

/** Highest-liquidity pair wins - that is the one whose price actually matters. */
export function bestPair(pairs: DexPair[], chainId?: string): DexPair | undefined {
  const candidates = chainId ? pairs.filter((p) => p.chainId === chainId) : pairs
  if (candidates.length === 0) return undefined

  return candidates.reduce((best, p) => ((p.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0) ? p : best))
}

export function priceOf(pair: DexPair): number | undefined {
  const price = pair.priceUsd ? Number(pair.priceUsd) : undefined
  return price !== undefined && Number.isFinite(price) && price > 0 ? price : undefined
}

/** A pool must be within this factor of the consensus price to be trusted. */
const OUTLIER_FACTOR = 3

/**
 * Picks the pair to quote a token from, rejecting broken pools first.
 *
 * Deepest-pool-wins is not safe on its own. Real tokens routinely have a pool
 * whose reported price is orders of magnitude off - wrong decimals, a stale
 * oracle, a wrapped variant - and it is sometimes the *deepest* pool. BONK has
 * had a $2M pool quoting 5000x the price every other pool agrees on, and
 * quoting that to a trading group would be catastrophic.
 *
 * So: take the median price across the token's pools as consensus, drop pools
 * that disagree by more than 3x either way, then pick the deepest survivor.
 */
export function selectPricePair(pairs: DexPair[], chainId?: string): DexPair | undefined {
  const trusted = trustedPairs(pairs, chainId)
  return bestPair(trusted.length > 0 ? trusted : chainId ? pairs.filter((p) => p.chainId === chainId) : pairs)
}

/** The pools whose price agrees with the consensus. See selectPricePair. */
export function trustedPairs(pairs: DexPair[], chainId?: string): DexPair[] {
  const scoped = chainId ? pairs.filter((p) => p.chainId === chainId) : pairs
  const priced = scoped.filter((p) => priceOf(p) !== undefined)

  if (priced.length === 0) return scoped
  // Below three pools there is no consensus to measure against.
  if (priced.length < 3) return priced

  const sorted = priced.map((p) => priceOf(p)!).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]!

  const trusted = priced.filter((p) => {
    const ratio = priceOf(p)! / median
    return ratio >= 1 / OUTLIER_FACTOR && ratio <= OUTLIER_FACTOR
  })

  return trusted.length > 0 ? trusted : priced
}

/**
 * The pool to read a *chart* from: the one that trades most, not the one that
 * holds most.
 *
 * These are different questions. Depth decides whose price to quote, because a
 * deep pool is hard to push around. Minute-by-minute technical analysis needs
 * trades in each minute, and a pool can be deep and quiet - one of WIF's
 * deepest pools prints a candle every seven minutes, which is not a one-minute
 * chart however much liquidity is sitting in it.
 *
 * The consensus price filter still applies first, so this cannot pick a pool
 * quoting nonsense just because it is busy.
 */
export function busiestPair(pairs: DexPair[], chainId?: string): DexPair | undefined {
  const trusted = trustedPairs(pairs, chainId)
  if (trusted.length === 0) return undefined

  return trusted.reduce((best, p) => ((p.volume?.h24 ?? 0) > (best.volume?.h24 ?? 0) ? p : best))
}

export function pairAgeMinutes(pair: DexPair, now = Date.now()): number | undefined {
  if (!pair.pairCreatedAt) return undefined
  return Math.max(0, (now - pair.pairCreatedAt) / 60_000)
}

export function hasSocials(pair: DexPair): boolean {
  return (pair.info?.websites?.length ?? 0) > 0 || (pair.info?.socials?.length ?? 0) > 0
}
