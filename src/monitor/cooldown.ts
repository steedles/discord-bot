import { getCollections } from '../db/mongo.js'
import { log } from '../logger.js'
import type { PostedAlert } from './detect/dedupe.js'
import { tokenKey } from './detect/dedupe.js'
import type { Priority } from './detect/types.js'

/**
 * The stored side of dedupe. The decision itself lives in `detect/dedupe.ts` as
 * a pure function; this only fetches what it needs and writes down what was
 * said.
 */

/** Longest cooldown any settings schema allows, so nothing older can matter. */
const MAX_RELEVANT_MS = 24 * 60 * 60_000

/**
 * What a channel has already heard, for one feature.
 *
 * Loaded per channel per cycle rather than per token: a channel posts at most a
 * couple of dozen alerts an hour, so this is a small query, and doing it per
 * token would multiply it by the watchlist.
 */
export async function recentAlerts(
  channelId: string,
  featureId: string,
  now = Date.now(),
): Promise<PostedAlert[]> {
  try {
    const { monitorAlerts } = getCollections()

    const rows = await monitorAlerts
      .find({ channelId, featureId, postedAt: { $gte: new Date(now - MAX_RELEVANT_MS) } })
      .project<{ chainId: string; tokenAddress: string; postedAt: Date }>({
        chainId: 1,
        tokenAddress: 1,
        postedAt: 1,
      })
      .toArray()

    return rows.map((row) => ({
      tokenKey: tokenKey(row.chainId, row.tokenAddress),
      postedAt: row.postedAt.getTime(),
    }))
  } catch (err) {
    // Failing to read history would mean posting everything again. Treating the
    // channel as saturated is the safer way to be wrong.
    log.monitor.warn({ err: String(err), channelId, featureId }, 'could not read alert history')
    throw err
  }
}

export interface AlertRecord {
  guildId: string
  channelId: string
  featureId: string
  chainId: string
  tokenAddress: string
  symbol: string
  trigger: string
  priority: Priority
}

/** Writes an alert down. Called after a successful send, never before. */
export async function recordAlert(record: AlertRecord, now = new Date()): Promise<void> {
  try {
    const { monitorAlerts } = getCollections()
    await monitorAlerts.insertOne({ ...record, postedAt: now })
  } catch (err) {
    log.monitor.warn({ err: String(err), ...record }, 'could not record alert')
  }
}

/** The most recent alerts across every channel, for `/monitor status`. */
export async function latestAlerts(limit = 10) {
  const { monitorAlerts } = getCollections()
  return monitorAlerts.find({}).sort({ postedAt: -1 }).limit(limit).toArray()
}
