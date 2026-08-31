/**
 * Round-number level breaks.
 *
 * Every other detector here asks "is this moving unusually". This one asks a
 * question that has nothing to do with rate: has the token just crossed a number
 * people actually talk about. A coin sliding from $31M to $24M is one continuous
 * move to a spike detector and two separate events to everyone in the channel,
 * because $30M and $25M are the numbers they hold in their heads.
 *
 * The levels are a 1-2-5 ladder, not a fit to the chart. That matters: a level
 * derived by looking for places price *happened* to turn is curve-fitting - it
 * will always find something, and naming it "support" is the same invention as
 * a hand-rolled risk score. A round number is chosen by the market's own
 * conventions before the fact, and the alert only ever claims the crossing.
 */
import type { MarketSnapshot } from '../providers/types.js'
import { formatCompactUsd } from '../../market/format.js'
import type { Reading, Trigger } from './types.js'

export interface LevelConfig {
  /**
   * How far past a level the token must be before the crossing counts, as a
   * percentage of the level.
   */
  bufferPct: number
  /** Alert when a level is crossed downward. */
  onFall: boolean
  /** Alert when a level is crossed upward. */
  onRise: boolean
  /** Crossings this far apart in size may ping the role. */
  highPriorityPct: number
  /** Oldest prior reading that may serve as "before". */
  maxLookbackMinutes: number
}

/**
 * The ladder. 1, 2 and 5 at every order of magnitude.
 *
 * Three rungs per decade rather than ten: $1M/$2M/$5M/$10M are the numbers a
 * channel reacts to, while $3M and $7M are not, and a ladder that fires on every
 * million turns a slow bleed into a stream of identical alerts.
 */
export function levelsBetween(low: number, high: number): number[] {
  if (!(low > 0) || !(high > low)) return []

  const out: number[] = []
  const startExp = Math.floor(Math.log10(low))
  const endExp = Math.ceil(Math.log10(high))

  for (let exp = startExp; exp <= endExp; exp++) {
    for (const mantissa of [1, 2, 5]) {
      const level = mantissa * 10 ** exp
      if (level > low && level < high) out.push(level)
    }
  }

  return out.sort((a, b) => a - b)
}

/**
 * The reading to measure "before" from.
 *
 * The most recent one that carries a market cap, not the oldest available: a
 * crossing is an event between two consecutive observations, and comparing
 * against two hours ago would report a level the token crossed long ago as if it
 * had just happened.
 */
function previousValue(history: Reading[], config: LevelConfig, now: number): number | undefined {
  const cutoff = now - config.maxLookbackMinutes * 60_000
  const usable = history
    .filter((r) => r.at >= cutoff && r.marketCapUsd !== undefined && r.marketCapUsd > 0)
    .sort((a, b) => b.at - a.at)

  return usable[0]?.marketCapUsd
}

export function detectLevelBreak(
  snapshot: MarketSnapshot,
  history: Reading[],
  config: LevelConfig,
  now = snapshot.fetchedAt,
): Trigger | undefined {
  const current = snapshot.marketCapUsd
  if (current === undefined || !(current > 0)) return undefined

  const previous = previousValue(history, config, now)
  if (previous === undefined) return undefined

  const falling = current < previous
  if (falling && !config.onFall) return undefined
  if (!falling && !config.onRise) return undefined

  const crossed = levelsBetween(Math.min(previous, current), Math.max(previous, current))
  if (crossed.length === 0) return undefined

  // The level furthest into the move is the one worth naming. A coin that fell
  // through $30M and $25M in one cycle broke $25M; saying "$30M" would describe
  // where it started rather than where it is.
  const level = falling ? Math.min(...crossed) : Math.max(...crossed)

  // Hysteresis. Sitting a hair under a level would otherwise re-alert every
  // cycle as the last digit wobbles across it.
  const distancePct = (Math.abs(current - level) / level) * 100
  if (distancePct < config.bufferPct) return undefined

  const movePct = Math.abs((current - previous) / previous) * 100

  return {
    kind: 'level',
    headline: `Market cap ${falling ? 'fell through' : 'broke above'} ${formatCompactUsd(level)}`,
    value: current,
    threshold: level,
    priority: movePct >= config.highPriorityPct ? 'high' : 'normal',
    // Comparable with the other detectors, which score as multiples of what they
    // had to beat: here that is how far past the level the move carried.
    score: 1 + distancePct / 100,
    /*
     * Said in words rather than as another arrow. The embed already carries a
     * "was → now" for market cap, measured over a couple of hours, and printing
     * a second arrow here - from the previous reading a minute ago - puts two
     * different baselines in identical notation directly above each other.
     */
    detail: [
      `Crossed ${falling ? 'down' : 'up'} through ${formatCompactUsd(level)} from ${formatCompactUsd(previous)}, now ${distancePct.toFixed(1)}% ${falling ? 'below' : 'above'} it`,
    ],
  }
}
