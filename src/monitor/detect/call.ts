import { bandValue, type Band } from '../../features/types.js'
import type { MarketSnapshot } from '../providers/types.js'
import type { Trigger } from './types.js'

/**
 * Following up on a called coin.
 *
 * Two decisions, both pure. Did this call go anywhere worth saying so - and if
 * not, is it time to stop paying to watch it?
 *
 * The multiple is measured from the price when the call was seen, not from the
 * detector's usual baseline. That is the whole point of the feature: it answers
 * "would you have made money following that call", which is a different question
 * from "is this token unusually busy right now".
 */

export interface CallConfig {
  /** Multiples worth announcing, e.g. 1.5, 2, 5. Each fires at most once. */
  alertMultiples: number[]
  /** How long a call is followed when nothing happens. */
  watchMinutes: number
  /** Below this, a coin is not going anywhere. */
  minMarketCapUsd: number
  /** How long it has to sit under that cap, or traded this thinly, to be dropped. */
  stuckMinutes: number
  /**
   * What counts as "effectively no volume", per market-cap band.
   *
   * A single figure cannot serve both ends of the range: $1k in five minutes is
   * a living $30k coin and a dead $5m one.
   */
  volumeFloors: Band[]
}

export interface CallState {
  priceAtCall: number
  calledAt: number
  /** Multiples already announced for this call. */
  alerted: number[]
}

/**
 * The next multiple this call has reached, if any.
 *
 * Only ever upward: a call that halved is not news the caller wants tagging in,
 * and the feature exists to report the ones that worked. The *highest* reached
 * multiple is returned rather than the next one up, so a coin that 5x'd between
 * two polls posts once at 5x instead of three times climbing the ladder.
 */
export function detectCallSpike(
  snapshot: MarketSnapshot,
  call: CallState,
  config: CallConfig,
): Trigger | undefined {
  const price = snapshot.priceUsd
  if (price === undefined || !Number.isFinite(price) || price <= 0) return undefined
  if (!(call.priceAtCall > 0)) return undefined

  const multiple = price / call.priceAtCall
  if (multiple <= 1) return undefined

  const reached = config.alertMultiples
    .filter((m) => m > 1 && multiple >= m && !call.alerted.includes(m))
    .sort((a, b) => b - a)[0]

  if (reached === undefined) return undefined

  const gainPct = (multiple - 1) * 100
  const minutes = Math.max(0, Math.round((snapshot.fetchedAt - call.calledAt) / 60_000))

  return {
    kind: 'call',
    headline: `${formatMultiple(multiple)} since the call`,
    value: multiple,
    threshold: reached,
    // A call that ran is the one alert in this bot worth interrupting for.
    priority: 'high',
    score: multiple / reached,
    detail: [
      `${price$(call.priceAtCall)} when called, ${price$(price)} now (+${gainPct.toFixed(0)}%)`,
      `${minutes}m after the call`,
    ],
  }
}

export interface Retirement {
  retire: boolean
  reason?: string
}

/**
 * Whether a call has stopped being worth watching.
 *
 * A call that has already run is exempt from the "going nowhere" rules and only
 * ages out on the clock - having proved itself once, it is worth the poll.
 */
export function callRetirement(
  snapshot: MarketSnapshot | undefined,
  call: CallState,
  config: CallConfig,
  now: number,
): Retirement {
  const ageMinutes = (now - call.calledAt) / 60_000

  if (ageMinutes >= config.watchMinutes) {
    return { retire: true, reason: `nothing after ${config.watchMinutes}m` }
  }

  // Below the stuck window nothing is decided yet: a coin called at the moment
  // it launches has no volume and no market cap for the first minute by nature.
  if (ageMinutes < config.stuckMinutes) return { retire: false }
  if (call.alerted.length > 0) return { retire: false }

  // No snapshot at all is not evidence of a dud - it is evidence of a failed
  // poll, and dropping the call for that would lose the ones that mattered.
  if (!snapshot) return { retire: false }

  const marketCap = snapshot.marketCapUsd
  if (marketCap !== undefined && marketCap < config.minMarketCapUsd) {
    return {
      retire: true,
      reason: `under ${usd(config.minMarketCapUsd)} for ${Math.floor(ageMinutes)}m`,
    }
  }

  // Which floor applies depends on the size of the coin, and without a market
  // cap there is no band to pick - so the volume rule simply does not apply,
  // rather than guessing at one.
  const floor = bandValue(config.volumeFloors, marketCap)
  const volume = snapshot.volume.m5
  if (floor !== undefined && floor > 0 && volume !== undefined && volume < floor) {
    return {
      retire: true,
      reason: `${usd(volume)} of 5m volume at a ${usd(marketCap ?? 0)} cap, under the ${usd(floor)} floor for that size`,
    }
  }

  return { retire: false }
}

function formatMultiple(multiple: number): string {
  return multiple >= 10 ? `${multiple.toFixed(0)}x` : `${multiple.toFixed(2).replace(/0$/, '')}x`
}

function usd(value: number): string {
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`
  return `$${value.toFixed(0)}`
}

function price$(value: number): string {
  if (value >= 1) return `$${value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`
  if (value >= 0.0001) return `$${value.toPrecision(4)}`
  return `$${value.toExponential(2)}`
}
