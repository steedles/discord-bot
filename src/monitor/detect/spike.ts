import type { MarketSnapshot } from '../providers/types.js'
import type { Reading, Trigger } from './types.js'

export interface SpikeConfig {
  /** How many times its own baseline the 5m volume has to reach. */
  multiplier: number
  /** Absolute floor. A 20x jump on $400 of volume is arithmetic, not news. */
  minVolume5mUsd: number
  /** At or above this multiple the alert may ping a role. */
  highPriorityMultiplier: number
  /**
   * Leave the live five minutes out of the baseline.
   *
   * For a token that arrived because somebody called it, the ordinary baseline
   * is measured while the thing being measured is already happening: people post
   * coins that are pumping, so `h1` contains the pump and `h1 / 12` is the pump's
   * own rate. The token then has to beat itself to register, and the move that
   * prompted the call never fires.
   */
  excludeCurrentWindow?: boolean
  /**
   * Which way price has to be going for the spike to count.
   *
   * `both` is volume-only: a spike is a spike whether the candles are green or
   * red, which is the honest default because heavy selling is also news.
   * `up` requires price to be rising over the same five minutes the volume
   * spiked in - the same window, deliberately, because a spike measured over
   * five minutes and a direction measured over an hour can disagree and the
   * pair would describe two different events.
   */
  direction?: 'up' | 'both'
}

/** Readings closer together than this overlap too much to be separate samples. */
const MIN_SAMPLE_GAP_MS = 5 * 60_000

/** Below this many independent samples the measured baseline is not a baseline. */
const MIN_SAMPLES = 3

/** How far back measured samples are drawn from. */
const HISTORY_WINDOW_MS = 6 * 60 * 60_000

/**
 * Volume spike detection.
 *
 * ## What "baseline" means here
 *
 * DexScreener reports trailing windows, so the token's own longer windows
 * already say what a normal five minutes looks like: `h1 / 12`, `h6 / 72` and
 * `h24 / 288` are three independent estimates of its 5-minute rate. Stored
 * history gives a fourth - the median of past `m5` readings - which is the only
 * one that survives a token that is *always* busy in bursts.
 *
 * The baseline is the **median of whichever estimates exist**. A mean would let
 * one distorted window set the bar: `h1` contains the spike itself and is pulled
 * up by it, `h24` is dragged down by a dead overnight stretch, and either alone
 * produces a threshold that has nothing to do with the token.
 *
 * ## Why measured samples are spaced out
 *
 * At a 60-second poll, consecutive `m5` readings share four of their five
 * minutes. Averaging fifty of them is averaging the same trades over and over
 * and produces a confidently wrong number, so samples closer than five minutes
 * apart are discarded rather than counted.
 */
export function detectSpike(
  snapshot: MarketSnapshot,
  history: Reading[],
  config: SpikeConfig,
): Trigger | undefined {
  const current = snapshot.volume.m5
  if (current === undefined || !Number.isFinite(current)) return undefined

  // The floor comes first. Everything below it is noise regardless of ratio.
  if (current < config.minVolume5mUsd) return undefined

  /*
   * An up-only channel wants green candles, so the five minutes that spiked
   * must also have gone up. A *missing* price change is not treated as flat and
   * allowed through: the provider did not answer, and admitting an unmeasured
   * direction into a filter whose whole job is direction would quietly turn
   * "up only" into "up, or unknown".
   */
  if (config.direction === 'up') {
    const move = snapshot.priceChange.m5
    if (move === undefined || !Number.isFinite(move) || move <= 0) return undefined
  }

  const baseline = spikeBaseline(snapshot, history, config.excludeCurrentWindow)

  // No baseline at all means the token traded nothing measurable until now.
  // That is a real event and the floor above already proved the size of it, but
  // it is not a multiple of anything, so it is described as what it is.
  if (baseline === undefined || baseline <= 0) {
    return {
      kind: 'spike',
      headline: `first significant volume - ${fmt(current)} in 5m against a flat baseline`,
      value: current,
      threshold: config.minVolume5mUsd,
      priority: 'normal',
      score: current / Math.max(1, config.minVolume5mUsd),
      detail: [`5m volume ${fmt(current)}`, 'No prior volume to compare against'],
    }
  }

  const ratio = current / baseline
  if (ratio < config.multiplier) return undefined

  return {
    kind: 'spike',
    headline: `5m volume ${ratio.toFixed(1)}x its baseline`,
    value: ratio,
    threshold: config.multiplier,
    priority: ratio >= config.highPriorityMultiplier ? 'high' : 'normal',
    score: ratio / config.multiplier,
    detail: [
      `5m volume ${fmt(current)} against a ${fmt(baseline)} baseline`,
      `Baseline from ${describeBasis(snapshot, history, config.excludeCurrentWindow)}`,
    ],
  }
}

/**
 * The expected 5-minute volume for this token, or undefined if nothing supports
 * an estimate. Exported so tests can pin the maths directly.
 */
export function spikeBaseline(
  snapshot: MarketSnapshot,
  history: Reading[],
  excludeCurrentWindow = false,
): number | undefined {
  const estimates = baselineEstimates(snapshot, history, excludeCurrentWindow)
  return estimates.length === 0 ? undefined : median(estimates)
}

function baselineEstimates(
  snapshot: MarketSnapshot,
  history: Reading[],
  excludeCurrentWindow = false,
): number[] {
  const out: number[] = excludeCurrentWindow
    ? priorWindowRates(snapshot)
    : wholeWindowRates(snapshot)

  const measured = measuredBaseline(history, snapshot.fetchedAt)
  if (measured !== undefined) out.push(measured)

  return out
}

/** The token's own trailing windows, each as a 5-minute rate. */
function wholeWindowRates(snapshot: MarketSnapshot): number[] {
  const out: number[] = []

  const { h1, h6, h24 } = snapshot.volume
  if (h1 !== undefined && h1 > 0) out.push(h1 / 12)
  if (h6 !== undefined && h6 > 0) out.push(h6 / 72)
  if (h24 !== undefined && h24 > 0) out.push(h24 / 288)

  return out
}

/**
 * The same rates with the live window taken out by subtraction.
 *
 * The windows are trailing and all end at the same instant, so the difference
 * between two of them is the stretch between their edges - `h1 - m5` is exactly
 * the 55 minutes before the current five, and `h6 - h1` the five hours before
 * the current one. That is the one arithmetic these overlapping windows do
 * support, and it produces a baseline from before whatever is happening now.
 *
 * A difference at or below zero is not a quiet stretch, it is a token whose
 * entire hour of volume happened in the last five minutes. There is no prior
 * rate to state, so nothing is pushed and the detector falls through to saying
 * exactly that rather than inventing a multiple.
 */
export function priorWindowRates(snapshot: MarketSnapshot): number[] {
  const out: number[] = []
  const { m5, h1, h6, h24 } = snapshot.volume

  if (h1 !== undefined && m5 !== undefined && h1 - m5 > 0) out.push((h1 - m5) / 11)
  if (h6 !== undefined && h1 !== undefined && h6 - h1 > 0) out.push((h6 - h1) / 60)
  if (h24 !== undefined && h6 !== undefined && h24 - h6 > 0) out.push((h24 - h6) / 216)

  return out
}

/** Median of past 5m readings, sampled far enough apart not to overlap. */
export function measuredBaseline(history: Reading[], now: number): number | undefined {
  const samples: number[] = []
  let lastAt: number | undefined

  // Newest first, so the spacing rule keeps the most recent of each cluster.
  const ordered = [...history].sort((a, b) => b.at - a.at)

  for (const reading of ordered) {
    if (now - reading.at > HISTORY_WINDOW_MS) break
    if (reading.volM5 === undefined || !Number.isFinite(reading.volM5)) continue
    if (lastAt !== undefined && lastAt - reading.at < MIN_SAMPLE_GAP_MS) continue

    samples.push(reading.volM5)
    lastAt = reading.at
  }

  return samples.length >= MIN_SAMPLES ? median(samples) : undefined
}

function describeBasis(
  snapshot: MarketSnapshot,
  history: Reading[],
  excludeCurrentWindow = false,
): string {
  const parts: string[] = []
  const { m5, h1, h6, h24 } = snapshot.volume

  if (excludeCurrentWindow) {
    // Named as what was actually measured, so a reader can tell that the live
    // window was left out rather than wonder why the multiple looks large.
    if (h1 !== undefined && m5 !== undefined && h1 - m5 > 0) parts.push('the 55m before this one')
    if (h6 !== undefined && h1 !== undefined && h6 - h1 > 0) parts.push('the 5h before that')
    if (h24 !== undefined && h6 !== undefined && h24 - h6 > 0) parts.push('the 18h before that')
  } else {
    if (h1) parts.push('1h')
    if (h6) parts.push('6h')
    if (h24) parts.push('24h')
  }

  if (measuredBaseline(history, snapshot.fetchedAt) !== undefined) parts.push('measured history')
  return parts.length > 0 ? parts.join(' + ') : 'no basis'
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]!
  return (sorted[mid - 1]! + sorted[mid]!) / 2
}

function fmt(usd: number): string {
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(2)}M`
  if (usd >= 1e3) return `$${(usd / 1e3).toFixed(1)}K`
  return `$${usd.toFixed(0)}`
}
