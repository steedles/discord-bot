import type { Candle } from '../market/geckoterminal.js'
import { ema, macd, pctChange, rsi, type Series } from './indicators.js'

/**
 * Turn detection on one-minute candles.
 *
 * The question this answers is narrow: has the trend just flipped, up to down or
 * down to up? Three independent, standard signals vote:
 *
 *   EMA 9/21   the fast average crossing the slow one - trend
 *   MACD 12/26/9   the histogram changing sign - momentum against its own average
 *   RSI 14     crossing the 50 midline - momentum outright
 *
 * A single crossover on a one-minute memecoin chart is mostly noise, which is
 * why agreement is required rather than any one signal. That is a threshold, not
 * a magic number: `confirmations` is a setting, and the notification always says
 * which signals fired and which did not, so a reader can judge the call rather
 * than trust it.
 *
 * Everything here runs on CLOSED candles. See getMinuteCandles().
 */

export type Direction = 'up' | 'down'

export interface Detector {
  key: 'ema' | 'macd' | 'rsi'
  /** Short human label, e.g. "EMA 9/21 crossed up". */
  label: string
  direction: Direction
  /** 0 means it crossed on the most recent closed candle. */
  barsAgo: number
  /** The numbers behind it. */
  detail: string
}

export interface TurnSignal {
  direction: Direction
  /** Detectors pointing the same way, most recent cross first. */
  agreeing: Detector[]
  /** Detectors that fired the other way inside the window. Shown, not hidden. */
  disagreeing: Detector[]
  /** How many of the three had an opinion at all. */
  considered: number
  price: number
  /** Unix seconds of the closed candle that triggered it. */
  candleTime: number
  change5m?: number
  change15m?: number
  change1h?: number
  rsi?: number
  macdHistogram?: number
  emaFast?: number
  emaSlow?: number
  lastVolume?: number
}

export interface TurnOptions {
  /** How many of the three signals must agree. */
  confirmations: number
  /** A cross this many closed candles back still counts towards agreement. */
  lookback: number
}

/**
 * MACD(26) plus its 9-period signal needs ~35 bars before it means anything, and
 * RSI needs 15. Below this the indicators exist but are still converging, and a
 * "turn" off a half-warm EMA is an artefact of the seeding, not the market.
 */
export const MIN_CANDLES = 40

export const DEFAULT_LOOKBACK = 3

/**
 * How much of the recent chart is allowed to be missing.
 *
 * A minute with no trades produces no candle at all, so a quiet pool returns a
 * series that *looks* like consecutive minutes and is not. Forty candles
 * spanning three days would compute a perfectly valid EMA of something that is
 * not a one-minute trend, and it would be announced as one.
 *
 * 2.0 means the window may be up to half gaps. Past that the chart is too thin
 * to describe as minute-by-minute, and the detector declines rather than
 * flattering the data.
 */
export const MAX_GAP_RATIO = 2

export interface Cadence {
  bars: number
  spanMinutes: number
  /** Minutes covered per candle. 1.0 is a trade every minute; 2.0 is half empty. */
  gapRatio: number
}

/** How dense the recent chart is - see MAX_GAP_RATIO. */
export function cadence(candles: Candle[], window = MIN_CANDLES): Cadence | undefined {
  const recent = candles.slice(-window)
  if (recent.length < 2) return undefined

  const spanMinutes = (recent[recent.length - 1]!.t - recent[0]!.t) / 60
  const intervals = recent.length - 1

  return { bars: recent.length, spanMinutes, gapRatio: spanMinutes / intervals }
}

export function detectTurn(candles: Candle[], options: TurnOptions): TurnSignal | undefined {
  if (candles.length < MIN_CANDLES) return undefined

  const density = cadence(candles)
  if (!density || density.gapRatio > MAX_GAP_RATIO) return undefined

  const closes = candles.map((c) => c.close)
  const last = closes.length - 1

  const fast = ema(closes, 9)
  const slow = ema(closes, 21)
  const momentum = macd(closes)
  const strength = rsi(closes, 14)

  const lookback = Math.max(1, options.lookback)
  const fired: Detector[] = []

  const emaCross = crossOf(diff(fast, slow), last, lookback)
  if (emaCross) {
    fired.push({
      key: 'ema',
      label: `EMA 9/21 crossed ${emaCross.direction}`,
      direction: emaCross.direction,
      barsAgo: emaCross.barsAgo,
      detail: `fast ${fmt(fast[last])} vs slow ${fmt(slow[last])}`,
    })
  }

  const macdCross = crossOf(momentum.histogram, last, lookback)
  if (macdCross) {
    fired.push({
      key: 'macd',
      label: `MACD crossed ${macdCross.direction === 'up' ? 'above' : 'below'} its signal`,
      direction: macdCross.direction,
      barsAgo: macdCross.barsAgo,
      detail: `histogram ${fmt(momentum.histogram[last])}`,
    })
  }

  const rsiCross = crossOf(
    strength.map((v) => (v === undefined ? undefined : v - 50)),
    last,
    lookback,
  )
  if (rsiCross) {
    const now = strength[last]
    const extreme =
      now === undefined ? '' : now >= 70 ? ' (overbought)' : now <= 30 ? ' (oversold)' : ''
    fired.push({
      key: 'rsi',
      label: `RSI crossed ${rsiCross.direction === 'up' ? 'above' : 'below'} 50`,
      direction: rsiCross.direction,
      barsAgo: rsiCross.barsAgo,
      detail: `RSI ${fmt(now, 1)}${extreme}`,
    })
  }

  if (fired.length === 0) return undefined

  // Only report a turn as it happens. Without this, a cross three bars back
  // would re-announce itself every minute until it left the lookback window.
  const justCrossed = fired.filter((d) => d.barsAgo === 0)
  if (justCrossed.length === 0) return undefined

  const direction = pickDirection(fired, justCrossed)
  const agreeing = fired.filter((d) => d.direction === direction).sort((a, b) => a.barsAgo - b.barsAgo)
  if (agreeing.length < options.confirmations) return undefined

  return {
    direction,
    agreeing,
    disagreeing: fired.filter((d) => d.direction !== direction),
    considered: fired.length,
    price: closes[last]!,
    candleTime: candles[last]!.t,
    ...defined('change5m', changeOver(candles, 5)),
    ...defined('change15m', changeOver(candles, 15)),
    ...defined('change1h', changeOver(candles, 60)),
    ...defined('rsi', strength[last]),
    ...defined('macdHistogram', momentum.histogram[last]),
    ...defined('emaFast', fast[last]),
    ...defined('emaSlow', slow[last]),
    ...defined('lastVolume', candles[last]!.volume),
  }
}

/**
 * When signals split, the freshest crossing wins - it is the one making the
 * claim that the trend has *just* turned. Ties on freshness go to the side with
 * more signals behind it.
 */
function pickDirection(fired: Detector[], justCrossed: Detector[]): Direction {
  const up = justCrossed.filter((d) => d.direction === 'up').length
  const down = justCrossed.filter((d) => d.direction === 'down').length
  if (up !== down) return up > down ? 'up' : 'down'

  const upTotal = fired.filter((d) => d.direction === 'up').length
  const downTotal = fired.filter((d) => d.direction === 'down').length
  return upTotal >= downTotal ? 'up' : 'down'
}

/** Element-wise a - b, undefined wherever either side is. */
function diff(a: Series, b: Series): Series {
  return a.map((v, i) => {
    const other = b[i]
    return v !== undefined && other !== undefined ? v - other : undefined
  })
}

/**
 * The most recent sign change in a series, within `lookback` bars of the end.
 *
 * A value of exactly zero is treated as no crossing rather than as a side - two
 * EMAs briefly equal have not crossed yet, and calling it either way produces a
 * signal that immediately reverses.
 */
function crossOf(
  series: Series,
  last: number,
  lookback: number,
): { direction: Direction; barsAgo: number } | undefined {
  for (let i = last; i > last - lookback && i > 0; i--) {
    const now = series[i]
    const before = series[i - 1]
    if (now === undefined || before === undefined || now === 0 || before === 0) continue

    if (before < 0 && now > 0) return { direction: 'up', barsAgo: last - i }
    if (before > 0 && now < 0) return { direction: 'down', barsAgo: last - i }
  }
  return undefined
}

/**
 * Change over a wall-clock window, not over a bar count.
 *
 * Counting back 15 bars is only 15 minutes on a pool that trades every minute.
 * Labelling a gappy pool's 15-bar move as "15m" would be a quietly wrong number
 * in every notification it appears in.
 */
function changeOver(candles: Candle[], minutes: number): number | undefined {
  const latest = candles[candles.length - 1]!
  const cutoff = latest.t - minutes * 60

  // The last candle at or before the cutoff, i.e. where price was back then.
  let reference: Candle | undefined
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i]!.t <= cutoff) {
      reference = candles[i]
      break
    }
  }

  return reference ? pctChange(reference.close, latest.close) : undefined
}

/** Keeps optional fields off the object entirely rather than setting undefined. */
function defined<K extends string>(key: K, value: number | undefined): Record<K, number> | object {
  return value === undefined || !Number.isFinite(value) ? {} : ({ [key]: value } as Record<K, number>)
}

function fmt(value: number | undefined, digits = 6): string {
  if (value === undefined || !Number.isFinite(value)) return 'n/a'
  return Math.abs(value) >= 1 ? value.toFixed(2) : value.toPrecision(digits === 1 ? 3 : 4)
}
