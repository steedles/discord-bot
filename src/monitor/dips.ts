import { getCollections } from '../db/mongo.js'
import { log } from '../logger.js'
import type { ArmedDip } from './detect/drawdown.js'
import { tokenKey } from './detect/dedupe.js'

/**
 * The stored side of dip hunting.
 *
 * `detect/drawdown.ts` decides; this remembers. Same split as
 * `cooldown.ts`/`detect/dedupe.ts`, and for the same reason: the arithmetic that
 * decides whether to shout stays testable without a database.
 */

export interface ArmInput {
  guildId: string
  channelId: string
  chainId: string
  tokenAddress: string
  symbol: string
  alertPriceUsd: number
  /** Market cap beside `alertPriceUsd`. Omitted when the snapshot had none. */
  alertMarketCapUsd?: number
  /** How long to keep waiting for a recovery before giving up on this dip. */
  armedForMinutes: number
  /** Message the recovery should reply to. */
  alertMessageId?: string
}

/**
 * Every dip this channel is still waiting on, keyed the way the worker keys
 * tokens. One query per channel per cycle - a channel holds a handful of armed
 * dips, and asking per token would multiply it by the watchlist.
 */
export async function loadArmedDips(channelId: string): Promise<Map<string, ArmedDip>> {
  const out = new Map<string, ArmedDip>()

  try {
    const { dipStates } = getCollections()
    const rows = await dipStates.find({ channelId }).toArray()

    for (const row of rows) {
      // The TTL monitor runs about once a minute, so an expired row can still be
      // here. Treating it as armed would announce a recovery for a dip nobody
      // was told about any more.
      if (row.expiresAt.getTime() <= Date.now()) continue

      out.set(tokenKey(row.chainId, row.tokenAddress), {
        alertPriceUsd: row.alertPriceUsd,
        ...(row.alertMarketCapUsd !== undefined ? { alertMarketCapUsd: row.alertMarketCapUsd } : {}),
        lowPriceUsd: row.lowPriceUsd,
        ...(row.lowMarketCapUsd !== undefined ? { lowMarketCapUsd: row.lowMarketCapUsd } : {}),
        armedAt: row.armedAt.getTime(),
        ...(row.alertMessageId ? { alertMessageId: row.alertMessageId } : {}),
      })
    }
  } catch (err) {
    // No state means no recovery alerts this cycle, which is quiet rather than
    // wrong. Arming again on the next drawdown re-establishes it.
    log.monitor.warn({ err: String(err), channelId }, 'could not read armed dips')
  }

  return out
}

/** Records a dip alert that has just been posted. */
export async function armDip(input: ArmInput, now = new Date()): Promise<void> {
  try {
    const { dipStates } = getCollections()
    const expiresAt = new Date(now.getTime() + Math.max(1, input.armedForMinutes) * 60_000)

    const mcap = positiveUsd(input.alertMarketCapUsd)
    const unset: Record<string, ''> = {
      ...(mcap === undefined ? { alertMarketCapUsd: '', lowMarketCapUsd: '' } : {}),
      ...(!input.alertMessageId ? { alertMessageId: '' } : {}),
    }
    await dipStates.updateOne(
      { channelId: input.channelId, chainId: input.chainId, tokenAddress: input.tokenAddress },
      {
        $set: {
          guildId: input.guildId,
          symbol: input.symbol,
          alertPriceUsd: input.alertPriceUsd,
          // A fresh alert restarts the wait: the low that matters is the one
          // after the price anyone acting on this alert would have paid.
          lowPriceUsd: input.alertPriceUsd,
          lowAt: now,
          armedAt: now,
          expiresAt,
          ...(mcap !== undefined ? { alertMarketCapUsd: mcap, lowMarketCapUsd: mcap } : {}),
          ...(input.alertMessageId ? { alertMessageId: input.alertMessageId } : {}),
        },
        // A re-arm without a cap or a message id must not keep the previous
        // dip's figures. An explicit undefined in $set becomes BSON null.
        ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
      },
      { upsert: true },
    )
  } catch (err) {
    log.monitor.warn({ err: String(err), ...input }, 'could not arm dip')
  }
}

/** Moves the recorded bottom down. Called only when the price is actually lower. */
export async function noteDipLow(
  channelId: string,
  chainId: string,
  tokenAddress: string,
  priceUsd: number,
  marketCapUsd?: number,
  now = new Date(),
): Promise<void> {
  try {
    const { dipStates } = getCollections()
    const mcap = positiveUsd(marketCapUsd)
    await dipStates.updateOne(
      { channelId, chainId, tokenAddress, lowPriceUsd: { $gt: priceUsd } },
      {
        $set: {
          lowPriceUsd: priceUsd,
          lowAt: now,
          ...(mcap !== undefined ? { lowMarketCapUsd: mcap } : {}),
        },
        // The low moved to a reading with no market cap. Keeping the old one
        // would pair a new price with a cap from an earlier moment.
        ...(mcap === undefined ? { $unset: { lowMarketCapUsd: '' } } : {}),
      },
    )
  } catch (err) {
    log.monitor.warn({ err: String(err), channelId, tokenAddress }, 'could not record dip low')
  }
}

function positiveUsd(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined
  return value
}

/** Clears a dip once its recovery has been announced. */
export async function disarmDip(
  channelId: string,
  chainId: string,
  tokenAddress: string,
): Promise<void> {
  try {
    const { dipStates } = getCollections()
    await dipStates.deleteOne({ channelId, chainId, tokenAddress })
  } catch (err) {
    log.monitor.warn({ err: String(err), channelId, tokenAddress }, 'could not disarm dip')
  }
}
