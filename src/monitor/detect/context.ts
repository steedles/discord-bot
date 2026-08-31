/**
 * The narrative half of an alert.
 *
 * A detector answers "did something happen". This answers "what does the reader
 * need to see next to it" - what the numbers *were*, over what span, and whether
 * two of them moved in ways worth pointing at.
 *
 * Every sentence here is a restatement of two measured figures. Nothing is
 * inferred, estimated, or scored: "the pool is holding while price came off" is
 * liquidity down 2% against market cap down 5%, in words. That distinction is
 * the same one `src/analysis/brief.ts` lives by - if a provider did not answer,
 * the line is absent rather than softened.
 */
import { formatCompactUsd, truncateAddress } from '../../market/format.js'
import type { MarketSnapshot, WhaleSwap } from '../providers/types.js'
import type { Reading } from './types.js'

/** A measured quantity's move between two readings. */
export interface Movement {
  from: number
  to: number
  /** Signed percentage change from `from` to `to`. */
  changePct: number
}

export interface AlertContext {
  /**
   * Minutes actually covered by the readings behind these figures - never the
   * window that was asked for. A token added ten minutes ago has ten minutes of
   * history, and an alert that says "over the last 2 hours" about it is lying.
   */
  spanMinutes?: number
  price?: Movement
  liquidity?: Movement
  marketCap?: Movement
  /** One sentence about two measures disagreeing. Absent when they do not. */
  divergence?: string
  /** Real transactions behind the move. Absent on chains with no swap source. */
  flow?: string
}

/**
 * How far back a comparison may reach.
 *
 * Deliberately shorter than the six hours of history the detectors get. An alert
 * is about what is happening now, and a baseline from six hours ago lets a token
 * that ran to 3x and gave it all back read as flat - the same trap Dip Hunter
 * avoids by taking its high from a series rather than a trailing window.
 */
const CONTEXT_WINDOW_MS = 2 * 60 * 60_000
/**
 * Shortest span worth comparing across.
 *
 * Two readings a minute apart mostly measure noise, and a "was → now" pair built
 * from them invites the reader to act on a rounding error.
 */
const MIN_SPAN_MINUTES = 5
/** A move smaller than this is called flat rather than named as a direction. */
const MATERIAL_PCT = 3
/** How far back `flow` looks for transactions. */
const FLOW_WINDOW_MS = 5 * 60_000

function movement(from: number | undefined, to: number | undefined): Movement | undefined {
  if (from === undefined || to === undefined) return undefined
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return undefined
  return { from, to, changePct: ((to - from) / from) * 100 }
}

/**
 * The oldest reading inside the context window that is old enough to compare
 * against. Readings arrive newest-first.
 */
function baselineReading(history: Reading[], now: number): Reading | undefined {
  const usable = history.filter(
    (r) => now - r.at <= CONTEXT_WINDOW_MS && now - r.at >= MIN_SPAN_MINUTES * 60_000,
  )
  if (usable.length === 0) return undefined

  return usable.reduce((oldest, r) => (r.at < oldest.at ? r : oldest))
}

export function buildAlertContext(
  snapshot: MarketSnapshot,
  history: Reading[],
  swaps: WhaleSwap[] = [],
  now = Date.now(),
): AlertContext {
  const baseline = baselineReading(history, now)

  const context: AlertContext = {
    flow: describeFlow(swaps, snapshot, now),
  }

  if (!baseline) return context

  context.spanMinutes = Math.round((now - baseline.at) / 60_000)
  context.price = movement(baseline.priceUsd, snapshot.priceUsd)
  context.liquidity = movement(baseline.liquidityUsd, snapshot.liquidityUsd)
  context.marketCap = movement(baseline.marketCapUsd, snapshot.marketCapUsd)

  // Market cap is the figure a reader thinks in, but it is only stored on newer
  // rows - so the comparison falls back to price, which moves with it.
  context.divergence = describeDivergence(context.marketCap ?? context.price, context.liquidity)

  return context
}

const magnitude = (m: Movement): string => `${Math.abs(m.changePct).toFixed(1)}%`

/**
 * What two measures moving differently means, said plainly.
 *
 * Depth and price answer different questions, so the interesting cases are the
 * ones where they disagree: a price that falls while the pool stays put is
 * holders declining to sell into it, and a pool that empties while price holds
 * is the opposite. Neither is a prediction - both are two percentages in a
 * sentence, which is the only claim the data supports.
 */
export function describeDivergence(
  value: Movement | undefined,
  liquidity: Movement | undefined,
): string | undefined {
  if (!value || !liquidity) return undefined

  const valueDown = value.changePct <= -MATERIAL_PCT
  const valueUp = value.changePct >= MATERIAL_PCT
  const liqDown = liquidity.changePct <= -MATERIAL_PCT
  const liqUp = liquidity.changePct >= MATERIAL_PCT
  const liqFlat = !liqDown && !liqUp

  if (valueDown && liqFlat) {
    return `The pool is holding while price came off — liquidity ${magnitude(liquidity)} against a ${magnitude(value)} fall.`
  }
  if (valueDown && liqDown) {
    return `Liquidity is leaving with the price — the pool is down ${magnitude(liquidity)} alongside a ${magnitude(value)} fall.`
  }
  if (valueUp && liqFlat) {
    return `Price is running on the liquidity already there — the pool moved ${magnitude(liquidity)} against a ${magnitude(value)} rise.`
  }
  if (valueUp && liqUp) {
    return `New liquidity arrived with the move — the pool is up ${magnitude(liquidity)} alongside a ${magnitude(value)} rise.`
  }
  if (!valueDown && !valueUp && liqDown) {
    return `The pool is thinning while price holds — liquidity down ${magnitude(liquidity)} on a broadly flat price.`
  }
  if (!valueDown && !valueUp && liqUp) {
    return `Liquidity is being added while price holds — the pool is up ${magnitude(liquidity)}.`
  }

  // Both flat. Two numbers that did nothing is not an observation.
  return undefined
}

/**
 * The transactions behind the move.
 *
 * This is the line nothing built on aggregate data can write: DexScreener
 * reports trade *counts*, never individual trades, so a competitor can say
 * "liquidity fell 2%" and stop there. Solana swaps come from a Helius webhook
 * and EVM swaps from `Swap` logs, and both are real transactions - which is why
 * this counts them rather than dividing volume by a trade count, the same
 * failure as inventing a risk score.
 */
export function describeFlow(
  swaps: WhaleSwap[],
  snapshot: Pick<MarketSnapshot, 'chainId' | 'tokenAddress'>,
  now = Date.now(),
): string | undefined {
  const mine = swaps.filter(
    (s) =>
      s.chainId === snapshot.chainId &&
      s.tokenAddress.toLowerCase() === snapshot.tokenAddress.toLowerCase() &&
      now - s.at <= FLOW_WINDOW_MS,
  )
  if (mine.length === 0) return undefined

  const buys = mine.filter((s) => s.side === 'buy')
  const sells = mine.filter((s) => s.side === 'sell')
  const buyUsd = buys.reduce((n, s) => n + s.amountUsd, 0)
  const sellUsd = sells.reduce((n, s) => n + s.amountUsd, 0)

  // Report the side that actually moved money, not whichever had more receipts.
  const [side, group, total] =
    sellUsd > buyUsd ? (['sell', sells, sellUsd] as const) : (['buy', buys, buyUsd] as const)
  if (group.length === 0) return undefined

  const noun = group.length === 1 ? side : `${side}s`
  const wallets = new Set(group.map((s) => s.wallet).filter((w): w is string => Boolean(w)))

  let who = ''
  if (wallets.size === 1) who = `, one wallet \`${truncateAddress([...wallets][0]!, 6)}\``
  else if (wallets.size > 1) who = `, across ${wallets.size} wallets`

  const minutes = Math.round(FLOW_WINDOW_MS / 60_000)
  return `${group.length} ${noun} totalling ${formatCompactUsd(total)} in the last ${minutes} minutes${who}.`
}
