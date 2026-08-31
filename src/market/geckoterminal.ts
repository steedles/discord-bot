import { log } from '../logger.js'
import { fetchJson, HttpError } from './http.js'
import { geckoCandlesLimiter } from './limiter.js'
import { ageOfLastFetch, loadCandles, mergeCandles, storeCandles } from './candle-store.js'

/**
 * Minute candles for a DEX pool.
 *
 * DexScreener gives a price and a set of percentage changes, which is enough to
 * say where a token is but not how it got there. Technical analysis needs a
 * series, and GeckoTerminal publishes real OHLCV per pool for free with no key.
 *
 * The alternative was sampling DexScreener once a minute and building our own
 * series, which would mean every newly tracked coin sat blind for an hour before
 * it could say anything - and would only ever see closes, not the wicks.
 *
 * Free tier is roughly 30 calls a minute for the whole bot, so callers must
 * share: one fetch per pool per tick, never per subscriber.
 */

const BASE = 'https://api.geckoterminal.com/api/v2'

/** GeckoTerminal pins its schema to this header rather than to the path. */
const HEADERS = { accept: 'application/json;version=20230302' }

export interface Candle {
  /** Unix seconds at the start of the minute. */
  t: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/** DexScreener chain id -> GeckoTerminal network id. They disagree on four. */
const NETWORKS: Record<string, string> = {
  solana: 'solana',
  ethereum: 'eth',
  bsc: 'bsc',
  base: 'base',
  arbitrum: 'arbitrum',
  polygon: 'polygon_pos',
  optimism: 'optimism',
  avalanche: 'avax',
  blast: 'blast',
  /*
   * Added after the fact. GeckoTerminal had no Robinhood network when this map
   * was written and does now - verified by listing every network and pulling
   * OHLCV for a live pool, which came back 150 candles at a 1.03 gap ratio.
   */
  robinhood: 'robinhood',
}

export function geckoNetwork(chainId: string): string | undefined {
  return NETWORKS[chainId.toLowerCase()]
}

/**
 * The free tier said no, for now.
 *
 * Kept distinct from "this pool has no chart" because the two demand opposite
 * responses: a dead pool should eventually be dropped, while a rate limit means
 * try again shortly and change nothing. Conflating them retires every healthy
 * tracker after a busy few minutes.
 */
export class CandleRateLimitError extends Error {
  constructor() {
    super('GeckoTerminal rate limit reached')
    this.name = 'CandleRateLimitError'
  }
}

export const supportsCandles = (chainId: string): boolean => geckoNetwork(chainId) !== undefined

interface OhlcvResponse {
  data?: { attributes?: { ohlcv_list?: number[][] } }
}

/** Enough history for MACD(12/26/9) and RSI(14) to be meaningful, with room over. */
const CANDLE_LIMIT = 150

const cache = new Map<string, { at: number; candles: Candle[] }>()
/** A one-minute candle cannot change more often than once a minute. */
const TTL_MS = 50_000
const MAX_ENTRIES = 500

/**
 * One-minute candles for a pool, oldest first.
 *
 * The newest entry GeckoTerminal returns is the minute currently forming. It is
 * dropped: an unfinished candle moves under your feet, and an indicator built on
 * it crosses and uncrosses within the same minute. Signals must come off closed
 * bars only.
 */
/** Testing seam - the cache is module-level and would mask the store path. */
export function clearCandleCache(): void {
  cache.clear()
}

export async function getMinuteCandles(
  chainId: string,
  poolAddress: string,
  options: { maxAgeMs?: number; staleFallbackMs?: number } = {},
): Promise<Candle[]> {
  const network = geckoNetwork(chainId)
  if (!network) return []

  /*
   * How stale an answer the caller will accept.
   *
   * The default is the detector's: a trend turn is judged off the newest closed
   * bar, so anything older than a minute risks reporting a cross that has
   * already un-crossed. A chart of the last two and a half hours does not move
   * meaningfully in five minutes, so `chart-card.ts` asks for a longer window
   * and two alerts on the same coin inside it cost one request between them.
   */
  const maxAge = options.maxAgeMs ?? TTL_MS

  const key = `${network}:${poolAddress.toLowerCase()}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < maxAge) return hit.candles

  // Then the persistent store, which unlike the memory cache survives a deploy.
  const storedAge = await ageOfLastFetch(chainId, poolAddress)
  if (storedAge < maxAge) {
    const stored = await loadCandles(chainId, poolAddress, CANDLE_LIMIT)
    if (stored.length > 0) {
      cache.set(key, { at: Date.now() - storedAge, candles: stored })
      return stored
    }
  }

  let data: OhlcvResponse
  try {
    data = await fetchJson<OhlcvResponse>(
      `${BASE}/networks/${network}/pools/${poolAddress}/ohlcv/minute?aggregate=1&limit=${CANDLE_LIMIT}`,
      // No retries. The rate limit is shared across every tracker, and retrying
      // inside a limited window spends the budget the others need on the one
      // request already known to be unlucky. The next poll is a minute away.
      { timeoutMs: 12_000, retries: 0, headers: HEADERS, limiter: geckoCandlesLimiter },
    )
  } catch (err) {
    /*
     * Refused, but the store may still hold something usable.
     *
     * Only offered to callers that asked for it. A chart of the last two hours
     * is barely worse for being ten minutes stale, and far better than no chart;
     * a trend detector judging the newest closed bar off stale candles would
     * announce a cross that may already have un-crossed, which is a wrong signal
     * rather than a late one. So the fallback is opt-in and the detectors do not
     * opt in.
     */
    const rateLimited = err instanceof HttpError && err.status === 429
    if (options.staleFallbackMs !== undefined) {
      const age = await ageOfLastFetch(chainId, poolAddress)
      if (age <= options.staleFallbackMs) {
        const stale = await loadCandles(chainId, poolAddress, CANDLE_LIMIT)
        if (stale.length > 0) {
          log.market.debug(
            { network, poolAddress, ageMs: age, rateLimited },
            'serving stored candles after a refused fetch',
          )
          return stale
        }
      }
    }

    if (rateLimited) throw new CandleRateLimitError()
    log.market.warn({ err: String(err), network, poolAddress }, 'geckoterminal candles failed')
    return []
  }

  const rows = data.data?.attributes?.ohlcv_list ?? []
  const nowSeconds = Math.floor(Date.now() / 1000)

  const candles = rows
    .filter((r) => r.length >= 6 && r.every((n) => Number.isFinite(n)))
    .map(([t, open, high, low, close, volume]) => ({
      t: t!,
      open: open!,
      high: high!,
      low: low!,
      close: close!,
      volume: volume!,
    }))
    // GeckoTerminal returns newest first; indicators read forwards.
    .sort((a, b) => a.t - b.t)
    .filter((c) => c.t + 60 <= nowSeconds)

  if (candles.length === 0) return candles

  // Merged against what we already had, so a pool keeps a continuous series
  // across restarts instead of only ever holding the last fetch.
  const stored = await loadCandles(chainId, poolAddress, CANDLE_LIMIT)
  const merged = mergeCandles(stored, candles, CANDLE_LIMIT)
  void storeCandles(chainId, poolAddress, candles)

  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, { at: Date.now(), candles: merged })

  return merged
}
