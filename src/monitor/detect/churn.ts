/**
 * PvP coins: the whole market cap changing hands, going nowhere.
 *
 * A "PvP coin" is trader shorthand for a token with no external flow left in
 * it - the volume is the same people selling to each other, and the fees and
 * the tax leak out the bottom. The phrase is a judgement, and this file does
 * not make it. What it measures is three arithmetic facts about one reading,
 * and the alert says only those:
 *
 *  1. **Turnover** - `volume.h1 / marketCap`. Six times the token's entire
 *     market cap traded in an hour is not accumulation, it is the same dollars
 *     going round.
 *  2. **Two-sidedness** - buys and sells within a few percent of each other by
 *     count. A one-sided book is a token being bought or being dumped; a
 *     matched one is a token being passed around.
 *  3. **Nothing to show for it** - price flat or down over that same hour.
 *     Turnover with price up 400% is a launch running, and calling that PvP
 *     would be wrong in the most expensive direction.
 *
 * The feature's *name* carries the interpretation. Its headline carries the
 * numbers. That split is the same one the rest of `detect/` runs on: a spike
 * alert says "8.2x its baseline", never "this is about to run".
 *
 * ## Why every figure comes from the 1h window
 *
 * Volume, transaction counts and price change are all read from `h1`, which is
 * one trailing hour ending at `fetchedAt` for all three - so the three facts
 * describe the same stretch of time and can be stated in one sentence. Mixing
 * `m5` volume with `h1` price would be two different events in one headline.
 *
 * The usual rolling-window trap does not apply here. It bites when consecutive
 * *readings* of an overlapping window are combined; a single reading divided by
 * the market cap at the same instant is a ratio of two figures measured
 * together, and needs no differencing.
 *
 * ## Why a missing figure refuses rather than defaults
 *
 * All three legs are required. A token with no `txns.h1` has not been shown to
 * be two-sided - it has not been checked - and admitting it would turn the
 * balance test into "balanced, or nobody looked". Same rule as the direction
 * filter on volume spikes.
 */
import { formatCompactUsd } from '../../market/format.js'
import type { MarketSnapshot } from '../providers/types.js'
import type { Trigger } from './types.js'

export interface ChurnConfig {
  /** Multiples of its own market cap the token must trade in an hour. */
  minTurnover: number
  /**
   * How far apart buys and sells may be, by count, as a percentage of all
   * trades. Zero would demand a perfect match, which no real book produces.
   */
  maxImbalancePct: number
  /**
   * The most price may have *risen* over the same hour. Above this the volume
   * bought something, which is a different event with a different name.
   */
  maxPriceChangePct: number
  /** Absolute floor on the hour's volume. A ratio on $900 is arithmetic. */
  minVolume1hUsd: number
  /** At or above this turnover the alert may ping a role. */
  highPriorityTurnover: number
}

export function detectChurn(snapshot: MarketSnapshot, config: ChurnConfig): Trigger | undefined {
  const volume = snapshot.volume.h1
  const marketCap = snapshot.marketCapUsd
  const txns = snapshot.txns.h1
  const priceChange = snapshot.priceChange.h1

  if (volume === undefined || !Number.isFinite(volume)) return undefined
  if (marketCap === undefined || !(marketCap > 0)) return undefined
  if (txns === undefined) return undefined
  if (priceChange === undefined || !Number.isFinite(priceChange)) return undefined

  // The floor first, as everywhere else: a token whose whole cap is $4k turns
  // it over on one trade, and the ratio would be the loudest on the list.
  if (volume < config.minVolume1hUsd) return undefined

  const trades = txns.buys + txns.sells
  if (trades <= 0) return undefined

  const turnover = volume / marketCap
  if (turnover < config.minTurnover) return undefined

  const imbalancePct = (Math.abs(txns.buys - txns.sells) / trades) * 100
  if (imbalancePct > config.maxImbalancePct) return undefined

  if (priceChange > config.maxPriceChangePct) return undefined

  return {
    kind: 'churn',
    headline: `1h volume is ${turnover.toFixed(1)}x its market cap, price ${signed(priceChange)}%`,
    value: turnover,
    threshold: config.minTurnover,
    priority: turnover >= config.highPriorityTurnover ? 'high' : 'normal',
    score: turnover / config.minTurnover,
    detail: [
      `${formatCompactUsd(volume)} traded in 1h against a ${formatCompactUsd(marketCap)} market cap`,
      `${txns.buys.toLocaleString()} buys / ${txns.sells.toLocaleString()} sells - ${imbalancePct.toFixed(1)}% apart`,
      `Price ${signed(priceChange)}% over the same hour`,
    ],
  }
}

function signed(pct: number): string {
  return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}`
}
