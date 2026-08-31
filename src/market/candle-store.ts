/**
 * Candles kept in Mongo, so the same pool is not fetched twice for nothing.
 *
 * ## What this can and cannot save
 *
 * It cannot make a request cheaper. GeckoTerminal's OHLCV endpoint returns its
 * newest N candles or nothing - there is no "only what I am missing" parameter -
 * so a pool we last saw thirty minutes ago still costs one full request to bring
 * up to date. Anyone expecting a partial fetch here will be disappointed, and
 * anyone building one will find no endpoint to build it against.
 *
 * What it saves is *whole requests*, two ways. A second chart of the same coin
 * inside the freshness window costs nothing, which is the common case when a
 * coin is moving enough to trip more than one alert. And the store outlives the
 * process, so a redeploy no longer starts every pool from cold - which the
 * in-memory cache did, on the same deploys that were losing the logs.
 *
 * ## Why freshness is a separate field
 *
 * It cannot be read off the candles. A candle exists only for a minute that
 * traded, so a gap means either "quiet pool" or "nobody asked" and the rows
 * themselves cannot tell you which. `candle_pools` records when we last asked.
 */
import { getCollections } from '../db/mongo.js'
import { log } from '../logger.js'
import type { Candle } from './geckoterminal.js'

const key = (chainId: string, poolAddress: string) => ({
  chainId,
  poolAddress: poolAddress.toLowerCase(),
})

/** Reads stored candles for a pool, oldest first. Never throws. */
export async function loadCandles(
  chainId: string,
  poolAddress: string,
  limit: number,
): Promise<Candle[]> {
  try {
    const { candles } = getCollections()
    const rows = await candles
      .find(key(chainId, poolAddress))
      .sort({ t: -1 })
      .limit(limit)
      .toArray()

    return rows
      .map((r) => ({ t: r.t, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v }))
      .sort((a, b) => a.t - b.t)
  } catch (err) {
    log.market.warn({ err: String(err), chainId, poolAddress }, 'could not read stored candles')
    return []
  }
}

/** How long ago the pool was last fetched, in ms. Infinity when never. */
export async function ageOfLastFetch(chainId: string, poolAddress: string): Promise<number> {
  try {
    const { candlePools } = getCollections()
    const row = await candlePools.findOne(key(chainId, poolAddress))
    return row ? Date.now() - row.fetchedAt.getTime() : Number.POSITIVE_INFINITY
  } catch {
    // Unknown freshness is treated as stale: fetching once too often is a
    // request, while serving a stale chart is a wrong picture.
    return Number.POSITIVE_INFINITY
  }
}

/**
 * Stores a fetch. Upserts by (chain, pool, minute), so the overlap between
 * consecutive fetches rewrites the same rows instead of duplicating them.
 */
export async function storeCandles(
  chainId: string,
  poolAddress: string,
  fetched: Candle[],
): Promise<void> {
  if (fetched.length === 0) return

  try {
    const { candles, candlePools } = getCollections()
    const at = new Date()
    const k = key(chainId, poolAddress)

    await candles.bulkWrite(
      fetched.map((c) => ({
        updateOne: {
          filter: { ...k, t: c.t },
          update: {
            $set: { o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume, at },
            $setOnInsert: { ...k, t: c.t },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    )

    await candlePools.updateOne(k, { $set: { fetchedAt: at } }, { upsert: true })
  } catch (err) {
    // A lost write costs one future request, which is not worth failing a chart.
    log.market.warn({ err: String(err), chainId, poolAddress }, 'could not store candles')
  }
}

/**
 * Merges stored and freshly fetched candles, newest `limit` kept.
 *
 * Keyed by timestamp, which is sound because a closed minute is immutable - the
 * two sources cannot disagree about a minute they both saw. The cap matters:
 * a long-lived pool accumulates more history than one fetch returns, and handing
 * a detector a longer series than it has always had would change how its
 * indicators seed.
 */
export function mergeCandles(stored: Candle[], fetched: Candle[], limit: number): Candle[] {
  const byMinute = new Map<number, Candle>()
  for (const c of stored) byMinute.set(c.t, c)
  // Fetched wins on conflict: it is the more recent read of the same minute.
  for (const c of fetched) byMinute.set(c.t, c)

  return [...byMinute.values()].sort((a, b) => a.t - b.t).slice(-limit)
}
