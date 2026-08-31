import { log } from '../../logger.js'
import { isSupportedChain } from '../../market/chains.js'
import {
  busiestPair,
  getPairsByAddresses,
  getPairsForTokens,
  getTopBoostedTokens,
  hasSocials,
  priceOf,
  selectPricePair,
  trustedPairs,
  type DexPair,
} from '../../market/dexscreener.js'
import type { MarketSnapshot, TokenRef } from './types.js'

/**
 * The market half of every provider.
 *
 * DexScreener is chain-agnostic - one token address, one request, every pool it
 * trades in - so there is no reason for each chain's provider to reimplement
 * this. Each provider owns its *whale* strategy and delegates market state here.
 */

/**
 * Builds one snapshot from every pool a token trades in on one chain.
 *
 * Volume and transaction counts are **summed across pools**, because a spike is
 * a fact about a token and a token's trading is routinely split across several
 * pools. Price and liquidity are *not* summed: they come from the pool
 * `selectPricePair` picks, since the question they answer is "what would a trade
 * actually get filled at", and adding up depth that sits in separate pools
 * overstates what a single position can absorb.
 *
 * Two consequences worth knowing:
 *
 *  - A brand-new pool joining the set adds its history all at once, which looks
 *    briefly like rising volume. The momentum detector requires price to be
 *    rising too, which a new pool does not do on its own.
 *  - `pairCreatedAt` is the *busiest* pool's age, not the token's. A token whose
 *    volume has moved to a fresh pool therefore reads as young and gets filtered
 *    by the minimum-age gate. That bias is deliberate: for a rug filter, a fresh
 *    pool with all the volume in it is the thing being guarded against.
 */
export function snapshotFromPairs(
  chainId: string,
  tokenAddress: string,
  pairs: DexPair[],
  now = Date.now(),
): MarketSnapshot | undefined {
  const trusted = trustedPairs(pairs, chainId)
  if (trusted.length === 0) return undefined

  const reference = busiestPair(trusted, chainId) ?? trusted[0]!
  const priced = selectPricePair(trusted, chainId) ?? reference

  const volume: MarketSnapshot['volume'] = {}
  for (const window of ['m5', 'h1', 'h6', 'h24'] as const) {
    const total = sum(trusted.map((p) => p.volume?.[window]))
    if (total !== undefined) volume[window] = total
  }

  const txns: MarketSnapshot['txns'] = {}
  for (const window of ['m5', 'h1', 'h24'] as const) {
    const counted = trusted.map((p) => p.txns?.[window]).filter((t) => t !== undefined)
    if (counted.length === 0) continue
    txns[window] = {
      buys: counted.reduce((n, t) => n + t.buys, 0),
      sells: counted.reduce((n, t) => n + t.sells, 0),
    }
  }

  // Price change is a property of the price, so it comes from the priced pool
  // rather than being averaged across pools that may disagree.
  const priceChange: MarketSnapshot['priceChange'] = {}
  for (const window of ['m5', 'h1', 'h6', 'h24'] as const) {
    const change = priced.priceChange?.[window]
    if (change !== undefined && Number.isFinite(change)) priceChange[window] = change
  }

  return {
    chainId,
    tokenAddress,
    pairAddress: reference.pairAddress,
    dexId: reference.dexId,
    symbol: reference.baseToken.symbol,
    name: reference.baseToken.name,
    priceUsd: priceOf(priced),
    liquidityUsd: priced.liquidity?.usd,
    marketCapUsd: priced.marketCap ?? priced.fdv,
    volume,
    txns,
    priceChange,
    pairCreatedAt: reference.pairCreatedAt,
    url: reference.url,
    // Any pool that carries an icon will do. The token's image is a fact about
    // the token, not about the pool that happens to trade most - and the busiest
    // pool is routinely a fresh one with no listing metadata at all, which is
    // how a token with a perfectly good icon ends up posting without one.
    imageUrl: trusted.find((p) => p.info?.imageUrl)?.info?.imageUrl,
    hasSocials: trusted.some(hasSocials),
    fetchedAt: now,
  }
}

/** Total of the defined values, or undefined when none were reported at all. */
function sum(values: (number | undefined)[]): number | undefined {
  const present = values.filter((v): v is number => v !== undefined && Number.isFinite(v))
  return present.length === 0 ? undefined : present.reduce((a, b) => a + b, 0)
}

/**
 * Which pools each watched token trades in.
 *
 * This exists to make the poll cheap. Asking the *token* endpoint costs one
 * request per token and is the only way to learn a token's pools - but a
 * watchlist's pools barely change between polls, while its prices change every
 * second. So the expensive question is asked rarely and the cheap one often:
 * discover the pool set per token every `POOL_SET_TTL_MS`, then re-read those
 * pools by address, thirty to a request, on every poll in between.
 *
 * The saving is the whole point of the cache. Thirty tokens averaging four
 * pools each is 30 requests a poll through the token endpoint and 4 through the
 * pair endpoint.
 *
 * Note this is not the batched-token trap: `getPairsByAddresses` returns
 * exactly the pools named, so `trustedPairs` still sees a token's full pool set
 * and the cross-pool price consensus survives. Asking the token endpoint for
 * many addresses at once is what caps the response at 30 pairs *in total* and
 * silently ruins every number built on it - that is still never done.
 */
interface PoolSet {
  /** Pool addresses as the upstream spells them. */
  pairAddresses: string[]
  discoveredAt: number
}

const poolSets = new Map<string, PoolSet>()
const poolSetKey = (chainId: string, tokenAddress: string): string =>
  `${chainId}:${tokenAddress.toLowerCase()}`

/** How long a token's pool set is believed before it is looked up again. */
const POOL_SET_TTL_MS = 10 * 60_000
/**
 * Pool sets re-discovered per chain per cycle.
 *
 * Expiries would otherwise arrive together - every token discovered in the same
 * cycle expires in the same cycle - which would restore the spike this cache
 * exists to remove. Capping them spreads the refresh out; a set a minute past
 * its TTL is not meaningfully worse than one a minute inside it.
 */
const MAX_REFRESHES_PER_CYCLE = 4
/**
 * Pool sets not re-discovered in this long are dropped. A token still being
 * polled refreshes well inside it, so this only ever catches retired tokens.
 */
const POOL_SET_IDLE_MS = 60 * 60_000

/**
 * Market snapshots for tokens on one chain.
 *
 * Two request shapes, for two different questions. A token whose pools are
 * unknown or stale is looked up on its own - that is the only call that can
 * *discover* a pool. Everything else is read in bulk by pool address.
 */
export async function fetchSnapshots(chainId: string, tokens: TokenRef[]): Promise<MarketSnapshot[]> {
  const wanted = tokens.filter((t) => t.chainId === chainId)
  if (wanted.length === 0) return []

  const now = Date.now()
  prunePoolSets(now)

  const known: TokenRef[] = []
  const expired: { token: TokenRef; discoveredAt: number }[] = []
  const unknown: TokenRef[] = []

  for (const token of wanted) {
    const set = poolSets.get(poolSetKey(chainId, token.tokenAddress))
    if (!set) unknown.push(token)
    else if (now - set.discoveredAt > POOL_SET_TTL_MS) {
      expired.push({ token, discoveredAt: set.discoveredAt })
    } else known.push(token)
  }

  // A token nobody has looked up yet is always discovered, however many arrive:
  // it has no pool set to fall back on, so deferring it means no snapshot at
  // all - and a coin lands on the watchlist precisely when something is
  // happening to it. Only *refreshes* are rationed, oldest first.
  expired.sort((a, b) => a.discoveredAt - b.discoveredAt)
  const refreshing = expired.slice(0, MAX_REFRESHES_PER_CYCLE)
  const deferred = expired.slice(MAX_REFRESHES_PER_CYCLE)

  const discovering = [...unknown, ...refreshing.map((e) => e.token)]
  known.push(...deferred.map((e) => e.token))

  const pairsByToken = new Map<string, DexPair[]>()

  if (discovering.length > 0) {
    const byAddress = await getPairsForTokens(discovering.map((t) => t.tokenAddress))
    for (const token of discovering) {
      const pairs = byAddress.get(token.tokenAddress.toLowerCase()) ?? []
      const scoped = pairs.filter((p) => p.chainId === chainId)
      pairsByToken.set(token.tokenAddress.toLowerCase(), scoped)

      // Remember the trusted pools only. The untrusted ones are the wrong-price
      // pools `selectPricePair` exists to drop, and paying to re-read them every
      // poll buys nothing.
      const trusted = trustedPairs(scoped, chainId)
      if (trusted.length > 0) {
        poolSets.set(poolSetKey(chainId, token.tokenAddress), {
          pairAddresses: trusted.map((p) => p.pairAddress),
          discoveredAt: now,
        })
      } else {
        poolSets.delete(poolSetKey(chainId, token.tokenAddress))
      }
    }
  }

  if (known.length > 0) {
    // Pools are asked for on behalf of a token, so the answer is mapped back by
    // the address that was asked for rather than by the pool's own base token -
    // a pool can quote the watched token on either side.
    // Two forms of the same address, deliberately. Solana pool addresses are
    // base58 and case-sensitive, so the request must carry them exactly as the
    // upstream spelled them; the lookup is lowercased because EVM chains hand
    // back a different case than they were given.
    const ownerByPool = new Map<string, string>()
    const poolAddresses: string[] = []
    for (const token of known) {
      const set = poolSets.get(poolSetKey(chainId, token.tokenAddress))
      if (!set) continue
      for (const pool of set.pairAddresses) {
        ownerByPool.set(pool.toLowerCase(), token.tokenAddress.toLowerCase())
        poolAddresses.push(pool)
      }
    }

    const pairs = await getPairsByAddresses(chainId, poolAddresses)
    for (const pair of pairs) {
      const owner = ownerByPool.get(pair.pairAddress.toLowerCase())
      if (!owner) continue
      const list = pairsByToken.get(owner)
      if (list) list.push(pair)
      else pairsByToken.set(owner, [pair])
    }

    // A pool set that returns nothing has gone stale - the pool was delisted, or
    // the addresses no longer resolve. Forget it so the next cycle re-discovers
    // rather than quietly reporting the token as dead forever.
    for (const token of known) {
      if (!pairsByToken.has(token.tokenAddress.toLowerCase())) {
        poolSets.delete(poolSetKey(chainId, token.tokenAddress))
      }
    }
  }

  return wanted.flatMap((token) => {
    const pairs = pairsByToken.get(token.tokenAddress.toLowerCase()) ?? []
    const snapshot = snapshotFromPairs(chainId, token.tokenAddress, pairs, now)
    return snapshot ? [snapshot] : []
  })
}

function prunePoolSets(now: number): void {
  for (const [key, set] of poolSets) {
    if (now - set.discoveredAt > POOL_SET_IDLE_MS) poolSets.delete(key)
  }
}

/** Testing seam - the cache is process-wide and would leak between cases. */
export function resetPoolSets(): void {
  poolSets.clear()
}

/**
 * The boost feed is global, so every chain's provider asking for it in the same
 * cycle would spend nine requests to receive the same list nine times. One
 * fetch is shared for the length of a poll.
 */
let boostCache: { at: number; tokens: Awaited<ReturnType<typeof getTopBoostedTokens>> } | undefined
const BOOST_CACHE_MS = 60_000

async function cachedBoostedTokens(): Promise<Awaited<ReturnType<typeof getTopBoostedTokens>>> {
  const now = Date.now()
  if (boostCache && now - boostCache.at < BOOST_CACHE_MS) return boostCache.tokens

  const tokens = await getTopBoostedTokens()
  boostCache = { at: now, tokens }
  return tokens
}

/**
 * Candidate tokens for auto-discovery.
 *
 * The only feed DexScreener offers publicly is boosted listings, which is paid
 * placement rather than a ranking. It is used here purely as a source of
 * addresses to *measure* - the watchlist promotion gate decides what is worth
 * watching, and it works off liquidity and volume, not off who paid.
 */
export async function fetchDiscoveryCandidates(chainId: string): Promise<TokenRef[]> {
  try {
    const boosted = await cachedBoostedTokens()

    return boosted
      .filter((b) => b.chainId === chainId && isSupportedChain(b.chainId) && b.tokenAddress)
      .map((b) => ({
        chainId: b.chainId,
        tokenAddress: b.tokenAddress,
        // Filled in once the token is measured; discovery only supplies addresses.
        pairAddress: '',
        symbol: '',
      }))
  } catch (err) {
    log.monitor.debug({ err: String(err), chainId }, 'discovery feed unavailable')
    return []
  }
}
