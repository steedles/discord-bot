/**
 * Textbook indicators, computed the textbook way.
 *
 * Every one of these is a published formula with a settled definition - EMA,
 * RSI (Wilder's smoothing), MACD. That matters for the same reason the risk
 * score always comes from a vendor: a number the bot shows should be one anyone
 * can reproduce in TradingView and get the same answer for. No tweaked
 * variants, no house smoothing.
 *
 * All functions return a series aligned to the input, with `undefined` for the
 * leading periods where the indicator is not yet defined. Callers must treat
 * that as "no answer" rather than zero.
 */

export type Series = (number | undefined)[]

/** Exponential moving average. Seeded with a simple average of the first `period`. */
export function ema(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(undefined)
  if (period <= 0 || values.length < period) return out

  const k = 2 / (period + 1)
  let sum = 0
  for (let i = 0; i < period; i++) sum += values[i]!

  let prev = sum / period
  out[period - 1] = prev

  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k)
    out[i] = prev
  }

  return out
}

/**
 * Relative Strength Index using Wilder's smoothing - the original, and what
 * charting tools mean by "RSI 14" unless told otherwise.
 */
export function rsi(values: number[], period = 14): Series {
  const out: Series = new Array(values.length).fill(undefined)
  if (values.length <= period) return out

  let gains = 0
  let losses = 0
  for (let i = 1; i <= period; i++) {
    const change = values[i]! - values[i - 1]!
    if (change >= 0) gains += change
    else losses -= change
  }

  let avgGain = gains / period
  let avgLoss = losses / period
  out[period] = rsiFrom(avgGain, avgLoss)

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i]! - values[i - 1]!
    const gain = change > 0 ? change : 0
    const loss = change < 0 ? -change : 0

    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    out[i] = rsiFrom(avgGain, avgLoss)
  }

  return out
}

/** All gains and no losses is RSI 100 by definition, not a division by zero. */
function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

export interface Macd {
  macd: Series
  signal: Series
  histogram: Series
}

/**
 * MACD. The signal line is an EMA of the MACD line, which is only defined once
 * the slow EMA is - so the MACD line is compacted, smoothed, then scattered back
 * onto the original index. Smoothing across the undefined head would silently
 * shift every value by 25 bars.
 */
export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): Macd {
  const fastLine = ema(values, fast)
  const slowLine = ema(values, slow)

  const line: Series = values.map((_, i) => {
    const f = fastLine[i]
    const s = slowLine[i]
    return f !== undefined && s !== undefined ? f - s : undefined
  })

  const firstDefined = line.findIndex((v) => v !== undefined)
  if (firstDefined === -1) {
    return { macd: line, signal: line.map(() => undefined), histogram: line.map(() => undefined) }
  }

  const compact = line.slice(firstDefined) as number[]
  const compactSignal = ema(compact, signalPeriod)

  const signal: Series = new Array(values.length).fill(undefined)
  compactSignal.forEach((v, i) => {
    signal[firstDefined + i] = v
  })

  const histogram: Series = values.map((_, i) => {
    const m = line[i]
    const s = signal[i]
    return m !== undefined && s !== undefined ? m - s : undefined
  })

  return { macd: line, signal, histogram }
}

/** Percentage change between two prices, guarding a zero base. */
export function pctChange(from: number, to: number): number | undefined {
  if (!Number.isFinite(from) || from === 0) return undefined
  return ((to - from) / from) * 100
}
