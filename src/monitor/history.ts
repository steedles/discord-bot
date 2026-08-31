import { getCollections } from '../db/mongo.js'
import type { VolumeSnapshot } from '../db/models.js'
import { log } from '../logger.js'
import type { Reading } from './detect/types.js'
import type { MarketSnapshot } from './providers/types.js'

/**
 * The monitor's memory.
 *
 * Every poll writes what it saw; the detectors read it back to answer questions
 * the API cannot: what does this token normally do, and has it been climbing?
 * A TTL index throws readings away after 48 hours, which is comfortably past the
 * longest window anything here looks at.
 */

/** How far back a detector may ask for. */
const LOOKBACK_MS = 6 * 60 * 60_000

/** Cap on rows per token, so one very long-lived token cannot dominate a read. */
const MAX_READINGS = 400

export function toSnapshotRow(snapshot: MarketSnapshot): VolumeSnapshot {
  const txns = snapshot.txns
  return {
    chainId: snapshot.chainId,
    tokenAddress: snapshot.tokenAddress,
    pairAddress: snapshot.pairAddress,
    at: new Date(snapshot.fetchedAt),
    priceUsd: snapshot.priceUsd,
    liquidityUsd: snapshot.liquidityUsd,
    marketCapUsd: snapshot.marketCapUsd,
    volM5: snapshot.volume.m5,
    volH1: snapshot.volume.h1,
    volH6: snapshot.volume.h6,
    volH24: snapshot.volume.h24,
    txnsM5: txns.m5 ? txns.m5.buys + txns.m5.sells : undefined,
    txnsH24: txns.h24 ? txns.h24.buys + txns.h24.sells : undefined,
  }
}

/** Records one poll's readings. Never throws - a lost reading is not worth a crash. */
export async function recordSnapshots(snapshots: MarketSnapshot[]): Promise<void> {
  if (snapshots.length === 0) return

  try {
    const { volumeSnapshots } = getCollections()
    await volumeSnapshots.insertMany(snapshots.map(toSnapshotRow), { ordered: false })
  } catch (err) {
    log.monitor.warn({ err: String(err), count: snapshots.length }, 'could not record snapshots')
  }
}

/**
 * Prior readings for every token in one query, newest first per token.
 *
 * One query rather than one per token: a hundred-token watchlist means a hundred
 * round trips otherwise, every single poll, and the whole point of a 60-second
 * cycle is that it finishes inside 60 seconds.
 */
export async function loadHistories(
  tokens: { chainId: string; tokenAddress: string }[],
  now = Date.now(),
): Promise<Map<string, Reading[]>> {
  const out = new Map<string, Reading[]>()
  if (tokens.length === 0) return out

  try {
    const { volumeSnapshots } = getCollections()

    const rows = await volumeSnapshots
      .find({
        at: { $gte: new Date(now - LOOKBACK_MS) },
        $or: tokens.map((t) => ({ chainId: t.chainId, tokenAddress: t.tokenAddress })),
      })
      .sort({ at: -1 })
      .limit(tokens.length * MAX_READINGS)
      .toArray()

    for (const row of rows) {
      const key = historyKey(row.chainId, row.tokenAddress)
      const list = out.get(key)
      const reading: Reading = {
        at: row.at.getTime(),
        priceUsd: row.priceUsd,
        liquidityUsd: row.liquidityUsd,
        marketCapUsd: row.marketCapUsd,
        volM5: row.volM5,
        volH1: row.volH1,
        volH6: row.volH6,
        volH24: row.volH24,
      }
      if (list) list.push(reading)
      else out.set(key, [reading])
    }
  } catch (err) {
    // No history means detectors that need it stay quiet, which is the right
    // failure: momentum without history would be a guess.
    log.monitor.warn({ err: String(err) }, 'could not load snapshot history')
  }

  return out
}

export function historyKey(chainId: string, tokenAddress: string): string {
  return `${chainId}:${tokenAddress.toLowerCase()}`
}
