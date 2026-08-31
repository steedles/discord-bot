import type { MarketSnapshot } from '../providers/types.js'
import type { Reading, Trigger } from './types.js'

export interface MomentumConfig {
  /** Consecutive windows that must each be up on the one before. */
  windows: number
  windowMinutes: number
  /** Total price gain across the whole run. */
  minPriceGainPct: number
  /** Total volume-rate gain across the whole run. */
  minVolumeGainPct: number
  /** Price gain at or above which the alert may ping a role. */
  highPriorityPriceGainPct: number
}

/**
 * How far a reading may sit from its intended sample time, as a fraction of the
 * window. Beyond this it is describing a different moment.
 */
const TOLERANCE = 0.5

/**
 * Sustained momentum: several windows in a row of rising volume *and* rising
 * price.
 *
 * ## Why this needs stored history
 *
 * The obvious implementation - read `volume.h1` and `priceChange.h1` and call a
 * positive number momentum - measures one instant. It cannot tell three quarters
 * of steady climbing from a single spike sixty minutes ago that has been sitting
 * in the trailing window ever since. Consecutiveness is the entire signal, and
 * consecutiveness only exists across readings, so this differences our own.
 *
 * ## Why rising `h1` is the right volume test
 *
 * `h1` is a rolling window, so comparing it 15 minutes apart is not comparing
 * two hours: `h1(t) - h1(t-15)` is exactly *the last 15 minutes minus the 15
 * minutes that just aged out of the window*. A rising sequence therefore says
 * each quarter-hour outsold the one it displaced, which is what accelerating
 * means. Nothing here needs a discrete bucket the API does not provide.
 *
 * ## Why price has to rise too
 *
 * Volume alone rises for reasons that are not momentum - a second pool opening
 * adds its whole history to the aggregate at once, a bot cycling inventory
 * trades hard in both directions. Requiring price to climb across the same
 * windows removes both: neither moves the price up for three windows running.
 */
export function detectMomentum(
  snapshot: MarketSnapshot,
  history: Reading[],
  config: MomentumConfig,
): Trigger | undefined {
  if (config.windows < 2) return undefined

  const samples = sampleWindows(snapshot, history, config)
  if (!samples) return undefined

  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i - 1]!
    const current = samples[i]!
    if (!(current.volume > previous.volume)) return undefined
    if (!(current.price > previous.price)) return undefined
  }

  const first = samples[0]!
  const last = samples[samples.length - 1]!

  const priceGainPct = ((last.price - first.price) / first.price) * 100
  const volumeGainPct = ((last.volume - first.volume) / first.volume) * 100

  if (priceGainPct < config.minPriceGainPct) return undefined
  if (volumeGainPct < config.minVolumeGainPct) return undefined

  const spanMinutes = config.windows * config.windowMinutes

  return {
    kind: 'momentum',
    headline: `${config.windows} straight ${config.windowMinutes}m windows of rising volume and price`,
    value: priceGainPct,
    threshold: config.minPriceGainPct,
    priority: priceGainPct >= config.highPriorityPriceGainPct ? 'high' : 'normal',
    score: priceGainPct / Math.max(1, config.minPriceGainPct),
    detail: [
      `Price +${priceGainPct.toFixed(1)}% over ${spanMinutes}m`,
      `Hourly volume rate +${volumeGainPct.toFixed(0)}% over the same span`,
      `Each window beat the one before it - ${config.windows} for ${config.windows}`,
    ],
  }
}

interface Sample {
  at: number
  price: number
  volume: number
}

/**
 * One reading per window boundary, oldest first.
 *
 * Returns undefined unless *every* boundary has a reading close enough to it.
 * A run with a hole in it is not a run, and filling the hole by reaching for the
 * nearest reading an hour away would manufacture the very consecutiveness this
 * detector exists to prove.
 */
export function sampleWindows(
  snapshot: MarketSnapshot,
  history: Reading[],
  config: MomentumConfig,
): Sample[] | undefined {
  const windowMs = config.windowMinutes * 60_000
  const toleranceMs = windowMs * TOLERANCE

  const latest = toSample({
    at: snapshot.fetchedAt,
    priceUsd: snapshot.priceUsd,
    volH1: snapshot.volume.h1,
  })
  if (!latest) return undefined

  const samples: Sample[] = [latest]

  for (let step = 1; step <= config.windows; step++) {
    const target = snapshot.fetchedAt - step * windowMs
    const match = nearestReading(history, target, toleranceMs)
    if (!match) return undefined

    const sample = toSample(match)
    if (!sample) return undefined
    samples.push(sample)
  }

  return samples.reverse()
}

function toSample(reading: Reading): Sample | undefined {
  const price = reading.priceUsd
  const volume = reading.volH1
  if (price === undefined || !Number.isFinite(price) || price <= 0) return undefined
  if (volume === undefined || !Number.isFinite(volume) || volume <= 0) return undefined
  return { at: reading.at, price, volume }
}

function nearestReading(
  history: Reading[],
  target: number,
  toleranceMs: number,
): Reading | undefined {
  let best: Reading | undefined
  let bestDistance = Infinity

  for (const reading of history) {
    const distance = Math.abs(reading.at - target)
    if (distance <= toleranceMs && distance < bestDistance) {
      best = reading
      bestDistance = distance
    }
  }

  return best
}
