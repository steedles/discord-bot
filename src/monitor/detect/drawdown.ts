import type { MarketSnapshot } from '../providers/types.js'
import type { Reading, Trigger } from './types.js'

/**
 * Dip and recovery detection.
 *
 * Two halves of one idea: say when a token has fallen a long way from its own
 * recent high, then say when it has climbed back. Both are pure functions -
 * where the dip is remembered between the two lives in `monitor/dips.ts`.
 *
 * ## Why the high comes from our own readings
 *
 * The upstream reports trailing windows (`priceChange.h1` is "against the price
 * 60 minutes ago"), which answers a different question: a token that ran to 3x
 * and fell back to where it started has an `h1` of roughly zero and a very real
 * drawdown. The peak is only visible in a series, so the high is taken from
 * recorded snapshots.
 *
 * ## Why coverage is checked before anything is claimed
 *
 * A token added to the watchlist ten minutes ago has ten minutes of history. It
 * can still be 60% off its high - but the high is a ten-minute high, and calling
 * it a three-hour one is inventing a fact. `windowHigh` reports how much of the
 * window it actually covers, the detector refuses below `minCoverageMinutes`,
 * and the headline names the span that was really measured.
 */

export interface DipConfig {
  /** How far below the window high counts as a dip. */
  drawdownPct: number
  /** How far back the high is taken from. */
  highWindowMinutes: number
  /** How far above the alert price the token must climb to count as recovered. */
  recoveryPct: number
  /** Refuse to describe a high the recorded history does not cover this much of. */
  minCoverageMinutes: number
  /** At or beyond this depth the alert may ping a role. */
  highPriorityDrawdownPct: number
}

/** A dip already announced, waiting to see whether it comes back. */
export interface ArmedDip {
  /** Price when the drawdown alert was posted. Recovery is measured from this. */
  alertPriceUsd: number
  /** Lowest price seen since that alert. */
  lowPriceUsd: number
  /** Epoch ms the dip was announced. */
  armedAt: number
}

export interface WindowHigh {
  priceUsd: number
  /** Epoch ms the high was recorded. */
  at: number
  /** How many readings the high was drawn from. */
  samples: number
  /** How much of the requested window the readings actually span, in ms. */
  coveredMs: number
}

/**
 * The highest price recorded inside the window, and how much of that window the
 * readings really cover. The current snapshot counts as the newest reading, so a
 * token making a new high has a drawdown of zero rather than a stale one.
 */
export function windowHigh(
  snapshot: MarketSnapshot,
  history: Reading[],
  windowMs: number,
): WindowHigh | undefined {
  const now = snapshot.fetchedAt
  const cutoff = now - windowMs

  let high: number | undefined
  let highAt = now
  let oldestAt = now
  let samples = 0

  const consider = (priceUsd: number | undefined, at: number): void => {
    if (priceUsd === undefined || !Number.isFinite(priceUsd) || priceUsd <= 0) return
    if (at < cutoff || at > now) return

    samples += 1
    if (at < oldestAt) oldestAt = at
    if (high === undefined || priceUsd > high) {
      high = priceUsd
      highAt = at
    }
  }

  consider(snapshot.priceUsd, now)
  for (const reading of history) consider(reading.priceUsd, reading.at)

  if (high === undefined) return undefined

  return { priceUsd: high, at: highAt, samples, coveredMs: now - oldestAt }
}

/** Fires when a token is far enough below its own recent high. */
export function detectDrawdown(
  snapshot: MarketSnapshot,
  history: Reading[],
  config: DipConfig,
): Trigger | undefined {
  const price = snapshot.priceUsd
  if (price === undefined || !Number.isFinite(price) || price <= 0) return undefined

  const high = windowHigh(snapshot, history, Math.max(1, config.highWindowMinutes) * 60_000)
  if (!high) return undefined

  // Two readings a minute apart are not a window, whatever they say about it.
  if (high.coveredMs < Math.max(0, config.minCoverageMinutes) * 60_000) return undefined

  const dropPct = ((high.priceUsd - price) / high.priceUsd) * 100
  if (dropPct < config.drawdownPct) return undefined

  const spanMinutes = Math.round(high.coveredMs / 60_000)
  const highAgoMinutes = Math.round((snapshot.fetchedAt - high.at) / 60_000)

  return {
    kind: 'drawdown',
    // The span is the one measured, not the one configured - see the note above.
    headline: `${dropPct.toFixed(1)}% below its ${spanMinutes}m high`,
    value: dropPct,
    threshold: config.drawdownPct,
    priority: dropPct >= config.highPriorityDrawdownPct ? 'high' : 'normal',
    score: dropPct / Math.max(1, config.drawdownPct),
    detail: [
      `High ${price$(high.priceUsd)} ${highAgoMinutes}m ago, now ${price$(price)}`,
      `Measured over ${spanMinutes}m of recorded readings (${high.samples} samples)`,
    ],
  }
}

/**
 * Fires when an announced dip has climbed back to its recovery target.
 *
 * The target is measured from the price the dip alert went out at, not from the
 * bottom: a bounce off the low means nothing if the low keeps making new lows,
 * and the alert price is the number anyone acting on the first alert would have
 * paid. The post-alert low is reported alongside it as a measurement, never as
 * the thing being compared against.
 */
export function detectRecovery(
  snapshot: MarketSnapshot,
  armed: ArmedDip,
  config: DipConfig,
): Trigger | undefined {
  const price = snapshot.priceUsd
  if (price === undefined || !Number.isFinite(price) || price <= 0) return undefined
  if (!Number.isFinite(armed.alertPriceUsd) || armed.alertPriceUsd <= 0) return undefined

  const target = armed.alertPriceUsd * (1 + Math.max(0, config.recoveryPct) / 100)
  if (price < target) return undefined

  const gainPct = ((price - armed.alertPriceUsd) / armed.alertPriceUsd) * 100
  const detail = [
    `Alert price ${price$(armed.alertPriceUsd)}, target ${price$(target)} (+${config.recoveryPct}%)`,
    `Now ${price$(price)}`,
  ]

  if (Number.isFinite(armed.lowPriceUsd) && armed.lowPriceUsd > 0) {
    const fromLowPct = ((price - armed.lowPriceUsd) / armed.lowPriceUsd) * 100
    detail.push(`Post-alert low ${price$(armed.lowPriceUsd)}, up ${fromLowPct.toFixed(1)}% from it`)
  }

  const heldMinutes = Math.round((snapshot.fetchedAt - armed.armedAt) / 60_000)
  detail.push(`${heldMinutes}m since the dip alert`)

  return {
    kind: 'recovery',
    headline: `${gainPct.toFixed(1)}% recovery from the alert price`,
    value: gainPct,
    threshold: config.recoveryPct,
    priority: 'normal',
    score: gainPct / Math.max(1, config.recoveryPct),
    detail,
  }
}

/**
 * Prices here span nine orders of magnitude, so a fixed number of decimals is
 * either noise or `$0.00`.
 */
function price$(value: number): string {
  if (value >= 1) return `$${value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`
  if (value >= 0.0001) return `$${value.toPrecision(4)}`
  return `$${value.toExponential(2)}`
}
