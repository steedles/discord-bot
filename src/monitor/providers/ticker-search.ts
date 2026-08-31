/**
 * Finding the other tokens trading under a watched token's ticker.
 *
 * This lives in `providers/` for the same reason everything else here does:
 * it is the only part of the vamp feature that touches DexScreener, and it hands
 * the detector `MarketSnapshot` values rather than `DexPair`. `detect/vamp.ts`
 * stays a pure comparison of two snapshots and can be tested against fixtures.
 *
 * ## Discovery and pricing are separate requests, deliberately
 *
 * `/latest/dex/search` is a discovery feed: it caps its response at thirty pairs
 * across every match, so the pools it returns for any one token are a sample.
 * Summing that sample's volume would understate a busy token by an unknown
 * amount - and when the watched token is the copy, that understatement lands on
 * the *denominator* of the ratio and inflates the alert. So the search is used
 * only to learn which addresses exist under a ticker, and every candidate that
 * survives the screen is then read properly, one request per token, exactly as
 * the pricing path does everywhere else in the codebase.
 *
 * ## The budget, and why coverage is deliberately slow
 *
 * Every other monitor feature is free once the watchlist has been polled - it
 * reads figures that were already fetched. This one is not: it costs a search
 * per ticker plus a confirmation per candidate, against the same DexScreener
 * bucket that prices every alert in the bot. So it is capped hard, at
 * `SEARCHES_PER_MINUTE` tickers, oldest cache entry first - a *rate* rather than
 * a per-cycle count, because the poll interval is a setting and the bucket it
 * draws from is not.
 *
 * The consequence is worth stating out loud rather than discovering later: on a
 * 120-token watchlist a given ticker is re-checked roughly every half hour,
 * whatever the poll interval. That is the right trade for this alert - a
 * vamp plays out over hours - but it means a copy launched sixty seconds ago is
 * not news here for a while yet. Capping is logged rather than silent, for the
 * same reason: a quiet cap reads as full coverage.
 */
import { config } from '../../config.js'
import { log } from '../../logger.js'
import { isSupportedChain } from '../../market/chains.js'
import { getPairsForTokens, searchPairs, type DexPair } from '../../market/dexscreener.js'
import { normaliseTicker } from '../detect/vamp.js'
import { snapshotFromPairs } from './dexscreener-source.js'
import type { MarketSnapshot } from './types.js'

/**
 * Tickers searched per minute. See the budget note above.
 *
 * A *rate*, not a per-cycle count, because the poll interval is configurable and
 * the budget this spends from is not: the live deployment polls every 20
 * seconds, where a flat "four a cycle" would quietly be twelve searches a minute
 * plus their confirmations - a third of the pairs bucket that prices every other
 * alert in the bot.
 */
const SEARCHES_PER_MINUTE = 4

/**
 * The allowance for one cycle at the configured poll interval, never below one -
 * a budget that rounded to zero would switch the feature off silently.
 */
export function searchesPerCycle(pollSeconds = config.MONITOR_POLL_SECONDS): number {
  return Math.max(1, Math.round((SEARCHES_PER_MINUTE * pollSeconds) / 60))
}

/**
 * Candidates confirmed per ticker.
 *
 * A popular ticker returns a long tail of dead namesakes. Confirming them all
 * would cost a request each to learn they trade nothing, so the tail is cut by
 * the search's own volume figures - which is exactly what a sampled feed is fit
 * for, since it is ordering candidates rather than pricing them.
 */
const MAX_RIVALS_PER_TICKER = 2

/** How long a ticker's rival set stands before it is worth spending on again. */
const CACHE_TTL_MS = 10 * 60_000

/** Cached tickers. Bounded so a long-lived process cannot grow one entry per coin ever watched. */
const MAX_CACHE_ENTRIES = 500

interface CacheEntry {
  at: number
  rivals: MarketSnapshot[]
}

export class TickerSearch {
  private readonly cache = new Map<string, CacheEntry>()

  /**
   * Refreshes the stalest tickers among the ones asked about, within budget.
   *
   * Takes the watched snapshots rather than bare strings so a token whose ticker
   * is too short to match on is dropped here, before it costs a request.
   */
  async prefetch(subjects: MarketSnapshot[], now = Date.now()): Promise<void> {
    const wanted = new Map<string, MarketSnapshot>()
    for (const subject of subjects) {
      const ticker = normaliseTicker(subject.symbol)
      if (ticker !== undefined) wanted.set(ticker, subject)
    }

    const stale = [...wanted.keys()]
      .filter((ticker) => {
        const entry = this.cache.get(ticker)
        return entry === undefined || now - entry.at >= CACHE_TTL_MS
      })
      // Oldest first, so a watchlist larger than the budget round-robins
      // instead of re-checking the same few tickers for ever.
      .sort((a, b) => (this.cache.get(a)?.at ?? 0) - (this.cache.get(b)?.at ?? 0))

    const searching = stale.slice(0, searchesPerCycle())
    if (stale.length > searching.length) {
      log.monitor.debug(
        { searching: searching.length, waiting: stale.length - searching.length },
        'ticker search budget spent for this cycle',
      )
    }

    for (const ticker of searching) {
      const subject = wanted.get(ticker)!
      try {
        this.remember(ticker, await this.lookUp(ticker, subject), now)
      } catch (err) {
        // A refused search is not a failed cycle. The previous answer stands
        // until it is replaced, which is better than clearing it and reporting
        // "no rivals" - a claim nothing measured.
        log.monitor.warn({ err: String(err), ticker }, 'ticker search failed')
      }
    }

    this.prune(now)
  }

  /**
   * What is known about a ticker right now. Empty when nothing has been fetched
   * yet - the detector treats that as "no rivals found", which is the same thing
   * as far as an alert is concerned: nothing measured, nothing said.
   */
  rivals(symbol: string | undefined): MarketSnapshot[] {
    const ticker = normaliseTicker(symbol)
    if (ticker === undefined) return []
    return this.cache.get(ticker)?.rivals ?? []
  }

  /** Cached tickers and how fresh they are, for `/monitor status`. */
  stats(now = Date.now()): { tickers: number; fresh: number } {
    let fresh = 0
    for (const entry of this.cache.values()) if (now - entry.at < CACHE_TTL_MS) fresh += 1
    return { tickers: this.cache.size, fresh }
  }

  /** Search for the ticker, screen the results, then read the survivors properly. */
  private async lookUp(ticker: string, subject: MarketSnapshot): Promise<MarketSnapshot[]> {
    const found = await searchPairs(subject.symbol)
    const candidates = screen(found, ticker, subject)
    if (candidates.length === 0) return []

    const pairsByToken = await getPairsForTokens(candidates)

    const out: MarketSnapshot[] = []
    for (const address of candidates) {
      const pairs = pairsByToken.get(address.toLowerCase())
      if (!pairs || pairs.length === 0) continue
      // Built from the token's whole pool set, exactly as a polled snapshot is,
      // so the two sides of the ratio are measured the same way.
      const snapshot = snapshotFromPairs(subject.chainId, address, pairs)
      if (snapshot) out.push(snapshot)
    }

    return out
  }

  private remember(ticker: string, rivals: MarketSnapshot[], now: number): void {
    this.cache.set(ticker, { at: now, rivals })
  }

  /** Drops the oldest entries once the cache is over size. */
  private prune(now: number): void {
    if (this.cache.size <= MAX_CACHE_ENTRIES) return

    const ordered = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at)
    for (const [ticker] of ordered.slice(0, this.cache.size - MAX_CACHE_ENTRIES)) {
      this.cache.delete(ticker)
    }
    log.monitor.debug({ kept: this.cache.size, now }, 'ticker cache pruned')
  }
}

/**
 * Which addresses from a search are worth a confirmation request.
 *
 * Same chain and the same ticker, a different mint from the one being watched,
 * and ordered by the busiest hour the sample shows - the ranking a sampled feed
 * can be trusted with, unlike the figure itself.
 */
export function screen(pairs: DexPair[], ticker: string, subject: MarketSnapshot): string[] {
  const bestVolume = new Map<string, { address: string; volume: number }>()

  for (const pair of pairs) {
    if (pair.chainId !== subject.chainId) continue
    if (!isSupportedChain(pair.chainId)) continue

    const address = pair.baseToken?.address
    if (!address) continue
    if (address.toLowerCase() === subject.tokenAddress.toLowerCase()) continue
    if (normaliseTicker(pair.baseToken.symbol) !== ticker) continue

    const key = address.toLowerCase()
    const volume = pair.volume?.h1 ?? 0
    const seen = bestVolume.get(key)
    // Summed rather than maxed on purpose: this is a rank, and a token split
    // across three sampled pools should not read as a third of itself.
    if (seen) seen.volume += volume
    else bestVolume.set(key, { address, volume })
  }

  return [...bestVolume.values()]
    .sort((a, b) => b.volume - a.volume)
    .slice(0, MAX_RIVALS_PER_TICKER)
    .map((entry) => entry.address)
}
