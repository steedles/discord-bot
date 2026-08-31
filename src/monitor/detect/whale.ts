import type { WhaleSwap } from '../providers/types.js'
import type { Trigger } from './types.js'

export interface WhaleConfig {
  /** Minimum USD value of a single swap. */
  minUsd: number
  /** At or above this the alert may ping a role. */
  highPriorityUsd: number
  /** Sells are usually not what a buy-side channel wants to hear about. */
  buysOnly: boolean
}

/**
 * Turns one real swap into an alert.
 *
 * The only thing this adds to the swap itself is the threshold comparison and
 * the priority call - which is the point. Every number in the resulting alert
 * came from a transaction that happened: the token amount from the chain, the
 * USD value from that amount times a price we independently hold. Nothing here
 * derives a swap from aggregate volume, because a 5-minute total divided by a
 * 5-minute trade count is an average trade, and an average trade is not a trade
 * anybody made.
 */
export function detectWhale(swap: WhaleSwap, config: WhaleConfig): Trigger | undefined {
  if (config.buysOnly && swap.side !== 'buy') return undefined
  if (!Number.isFinite(swap.amountUsd) || swap.amountUsd < config.minUsd) return undefined

  const verb = swap.side === 'buy' ? 'bought' : 'sold'

  const detail = [`${usd(swap.amountUsd)} ${verb} in a single transaction`]
  if (swap.tokenAmount !== undefined && Number.isFinite(swap.tokenAmount)) {
    detail.push(`${swap.tokenAmount.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${swap.symbol}`)
  }
  // Priced with our own feed rather than the chain's, so say so - the two can
  // disagree, and a reader comparing this against the block explorer should
  // know which number they are looking at.
  detail.push('USD value is the token amount at our last quoted price')

  return {
    kind: 'whale',
    headline: `${usd(swap.amountUsd)} single ${swap.side}`,
    value: swap.amountUsd,
    threshold: config.minUsd,
    priority: swap.amountUsd >= config.highPriorityUsd ? 'high' : 'normal',
    score: swap.amountUsd / Math.max(1, config.minUsd),
    detail,
  }
}

function usd(value: number): string {
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`
  return `$${value.toFixed(0)}`
}
