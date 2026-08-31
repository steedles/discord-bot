/**
 * Turns an alert into a chart, or decides it should not have one.
 *
 * The rule this file exists to enforce: **a chart is attached only when the
 * picture is evidence for what the alert says.** That is true two ways, and no
 * others.
 *
 * Either the alert is about a *level* the chart can draw - Dip Hunter has a high
 * it fell from, Level Break has the level it crossed, Call Tracker has the price
 * the call was made at, a price alert has its target. Or the alert is a claim
 * about the *shape of the series itself*, which is what a trend turn is, and
 * there the candles are the evidence rather than a backdrop for a rail.
 *
 * A volume spike is neither. The spike is in volume, the renderer draws no
 * volume panel, and a price chart beside a volume alert implies a claim about
 * price that nobody measured - the same failure as inventing a risk score, in
 * pictures.
 *
 * Three ways this returns nothing, all of them normal:
 *
 *  - the alert is neither about a level nor about the shape of the series
 *  - the chain has no candle feed (Robinhood Chain is not on GeckoTerminal, and
 *    a third of the live watchlist sits there)
 *  - the candle budget is spent, or the pool is too quiet to have candles
 *
 * None of them is an error, and none of them may cost the alert. The message
 * goes out either way: a chart is a garnish on a fact, never the fact.
 *
 * Every skip is nonetheless *logged with its reason*. Silence that looks like
 * success is its own bug: shipping this with a swallowed rate-limit error meant
 * eleven of sixteen alerts arrived without a chart and nothing anywhere said
 * why - the logs read zero failures because the one likely cause had been made
 * deliberately quiet.
 */
import { AttachmentBuilder } from 'discord.js'
import { renderChart, CYAN, DOWN, UP, VIOLET, type Rail } from '../analysis/chart.js'
import { cadence } from '../analysis/trend.js'
import { formatAge } from '../market/format.js'
import {
  CandleRateLimitError,
  getMinuteCandles,
  supportsCandles,
  type Candle,
} from '../market/geckoterminal.js'
import { log } from '../logger.js'
import { CALL_TRACKER, DIP_HUNTER, LEVEL_BREAK } from '../features/registry.js'
import type { Trigger } from './detect/types.js'
import type { MarketSnapshot } from './providers/types.js'

/** Features whose alerts carry a level worth drawing. */
const CHARTED_FEATURES = new Set<string>([DIP_HUNTER.id, LEVEL_BREAK.id, CALL_TRACKER.id])

/**
 * Below this there is not enough series to read a shape off.
 */
const MIN_CHART_CANDLES = 20

/**
 * How much of the chart may be missing.
 *
 * Looser than the trend detector's `MAX_GAP_RATIO` of 2, and deliberately: the
 * detector computes an EMA over the series and a gap corrupts the arithmetic,
 * while a chart only has to be a fair picture. Three means a pool trading
 * roughly every three minutes still gets drawn, and the LICKINGCAT case -
 * 150 candles across four and a half days, a ratio of 43 - does not.
 */
const MAX_CHART_GAP_RATIO = 3

/**
 * How stale a chart's candles may be.
 *
 * Far longer than the trend detector's minute, because the two are answering
 * different questions: a detector judges the newest closed bar, while a chart
 * shows two and a half hours of shape that does not change meaningfully in five
 * minutes. The saving is real - a dip and a second alert on the same coin inside
 * this window cost one request between them rather than two.
 */
const CHART_CANDLE_MAX_AGE_MS = 5 * 60_000

/**
 * How stale stored candles may be when upstream refuses the fetch.
 *
 * The point of keeping a store at all: "candle budget spent" was the likeliest
 * reason an alert arrived without a chart, and in most of those cases the
 * candles were already on disk. A picture half an hour behind on a two-hour
 * window is worth having; past that the last bar is far enough from the price in
 * the text beside it to be its own kind of wrong.
 */
const CHART_CANDLE_STALE_FALLBACK_MS = 30 * 60_000

export const FILE_NAME = 'chart.png'
/** Referenced from the embed. Discord resolves it against the uploaded file. */
export const ATTACHMENT_URL = `attachment://${FILE_NAME}`

export function featureWantsChart(featureId: string): boolean {
  return CHARTED_FEATURES.has(featureId)
}

/**
 * The rails for one alert kind.
 *
 * Every value here is one the alert already measured and printed - the rail is a
 * second rendering of a number in the text, never a new one. `threshold` is what
 * the detector had to beat, which is precisely the level worth a line.
 *
 * Exported for src/monitor/personal-alerts.ts, which needs the same per-kind
 * rails a Discord alert would draw as its first choice, before falling back to
 * a plain "now" rail for the kinds that return none here (see that file for
 * why a personal alert always gets a chart where a channel alert does not).
 */
export function railsFor(trigger: Trigger, snapshot: MarketSnapshot): Rail[] {
  const price = snapshot.priceUsd
  const rails: Rail[] = []

  switch (trigger.kind) {
    case 'drawdown':
      // `value` is the drawdown percentage, `threshold` the depth configured;
      // the high itself is what the reader wants to see, and it is recoverable
      // from the current price and the measured drawdown.
      if (price && trigger.value > 0 && trigger.value < 100) {
        rails.push({ value: price / (1 - trigger.value / 100), colour: CYAN, label: 'high' })
      }
      if (price) rails.push({ value: price, colour: VIOLET, label: 'alert' })
      break

    case 'recovery':
      if (price) rails.push({ value: price, colour: UP, label: 'recovered' })
      break

    case 'level':
      // The level is the whole alert. Drawn as a rail rather than a shaded zone
      // because the token can be on either side of it.
      rails.push({
        value: trigger.threshold,
        colour: trigger.value < trigger.threshold ? DOWN : UP,
        label: 'level',
      })
      if (price) rails.push({ value: price, colour: VIOLET, label: 'now' })
      break

    case 'call':
      // A multiple is measured from the call, so the call price is the only
      // baseline that matters - `value` is the multiple achieved.
      if (price && trigger.value > 0) {
        rails.push({ value: price / trigger.value, colour: VIOLET, label: 'called' })
      }
      if (price) rails.push({ value: price, colour: UP, label: 'now' })
      break

    default:
      return []
  }

  return rails.filter((r) => Number.isFinite(r.value) && r.value > 0)
}

export interface ChartCard {
  attachment: AttachmentBuilder
}

/** What a card needs, independent of which worker is asking. */
export interface CardRequest {
  symbol: string
  chainId: string
  pairAddress: string
  rails: Rail[]
  subline?: string
  /** Price and market cap, so the axis can read in market cap. Both or neither. */
  priceUsd?: number
  marketCapUsd?: number
  /** Candles the caller already holds. Fetched here when absent. */
  candles?: Candle[]
  /**
   * Set when the picture is the point rather than the rails - a trend turn is a
   * claim about the shape of the series, and the candles are the evidence for
   * it. Everything else must bring a rail or go without a chart.
   */
  seriesIsTheClaim?: boolean
}

/**
 * The shared path. Both the monitor and the standalone workers come through
 * here, so the candle budget and the "no chart is not an error" contract are
 * enforced in exactly one place. Returns raw PNG bytes - no `discord.js`
 * involved - so a non-Discord caller (src/monitor/personal-alerts.ts, sending
 * to Telegram) gets the same gating without pulling in `AttachmentBuilder`.
 */
export async function renderChartPng(req: CardRequest): Promise<Buffer | undefined> {
  const skip = (reason: string, extra: Record<string, unknown> = {}): undefined => {
    log.monitor.info({ symbol: req.symbol, chain: req.chainId, reason, ...extra }, 'chart skipped')
    return undefined
  }

  if (!supportsCandles(req.chainId)) return skip('chain has no candle feed')

  const rails = req.rails.filter((r) => Number.isFinite(r.value) && r.value > 0)
  if (rails.length === 0 && !req.seriesIsTheClaim) return skip('no rail to draw')

  let candles = req.candles
  if (!candles) {
    try {
      candles = await getMinuteCandles(req.chainId, req.pairAddress, {
        maxAgeMs: CHART_CANDLE_MAX_AGE_MS,
        staleFallbackMs: CHART_CANDLE_STALE_FALLBACK_MS,
      })
    } catch (err) {
      // A spent budget is not a failed alert. Rate limiting is not failure -
      // but it is the single likeliest reason a chart is missing, so it is the
      // one that most needs saying out loud.
      if (err instanceof CandleRateLimitError) return skip('candle budget spent')
      return skip('candle fetch failed', { err: String(err) })
    }
  }

  // Too few candles is not a chart, it is a rumour.
  if (!candles || candles.length < MIN_CHART_CANDLES) {
    return skip('too few candles', { candles: candles?.length ?? 0 })
  }

  /*
   * A candle exists only for a minute that traded, and the renderer plots them
   * by index rather than by time - so a hundred and fifty candles spanning four
   * days draws exactly like a hundred and fifty consecutive minutes. Labelling
   * the span honestly is necessary but not sufficient; past a point the picture
   * itself misrepresents time, and the only honest response is no picture.
   *
   * Measured over the whole series rather than the trailing window the detector
   * uses, because the chart shows all of it.
   */
  const density = cadence(candles, candles.length)
  if (!density || density.gapRatio > MAX_CHART_GAP_RATIO) {
    return skip('series too sparse to plot', {
      candles: candles.length,
      gapRatio: density ? Number(density.gapRatio.toFixed(2)) : undefined,
      spanMinutes: density ? Math.round(density.spanMinutes) : undefined,
    })
  }

  const supply =
    req.priceUsd && req.marketCapUsd && req.priceUsd > 0 && req.marketCapUsd > 0
      ? req.marketCapUsd / req.priceUsd
      : undefined

  try {
    return renderChart(candles, {
      symbol: req.symbol,
      supply,
      rails,
      subline: req.subline,
      footer: `${density.bars} candles · ${formatAge(density.spanMinutes)}`,
    })
  } catch (err) {
    return skip('render failed', { err: String(err) })
  }
}

/** Discord-shaped wrapper around {@link renderChartPng} - every call site here keeps working unchanged. */
export async function renderCard(req: CardRequest): Promise<ChartCard | undefined> {
  const png = await renderChartPng(req)
  return png ? { attachment: new AttachmentBuilder(png, { name: FILE_NAME }) } : undefined
}

/**
 * Renders the card for an alert, or returns undefined.
 *
 * `candles` may be supplied by a caller that already has them - the coin tracker
 * fetches a token's candles to decide whether to alert at all, and paying twice
 * for the same minute of data against a 24/minute budget is the arithmetic this
 * whole codebase keeps getting wrong.
 */
export async function chartCardFor(
  featureId: string,
  trigger: Trigger,
  snapshot: MarketSnapshot,
  options: { candles?: Candle[]; subline?: string } = {},
): Promise<ChartCard | undefined> {
  if (!featureWantsChart(featureId)) return undefined

  return renderCard({
    symbol: snapshot.symbol,
    chainId: snapshot.chainId,
    pairAddress: snapshot.pairAddress,
    rails: railsFor(trigger, snapshot),
    subline: options.subline ?? trigger.headline,
    priceUsd: snapshot.priceUsd,
    marketCapUsd: snapshot.marketCapUsd,
    candles: options.candles,
  })
}
