import { CHAINS } from '../../market/chains.js'

/**
 * Fomo's numeric `networkId` to our chain id.
 *
 * Fomo uses two identifiers and we need both: the numeric `networkId` appears in
 * websocket payloads, while the URL slug (`bnb` for what we call `bsc`) builds a
 * fomo.family link and already lives in `src/market/fomo.ts`.
 *
 * Every entry below was seen in real traffic. `1`, `56` and `8453` are the
 * standard EVM chain ids; `1399811149` and `4663` are Fomo's own numbering for
 * Solana and Robinhood Chain.
 *
 * A `networkId` of **143** was observed in `trending_tokens` and has NOT been
 * identified. It is deliberately absent: guessing it would attach real trades to
 * the wrong chain, and an alert someone acts on is the worst place to be wrong.
 * An unmapped id yields `undefined`, and the event still posts - without a chain
 * and without a trade link, which is honest about what we know.
 */
const NETWORK_TO_CHAIN: Record<number, string> = {
  1399811149: 'solana',
  1: 'ethereum',
  56: 'bsc',
  8453: 'base',
  4663: 'robinhood',
}

/** Our chain id for a Fomo networkId, or undefined when we have not confirmed one. */
export function chainIdForNetwork(networkId: number | undefined): string | undefined {
  if (networkId === undefined) return undefined
  const id = NETWORK_TO_CHAIN[networkId]
  // Guard against the map drifting out of step with chains.ts.
  return id && id in CHAINS ? id : undefined
}

/** Whether we can name the chain a Fomo event happened on. */
export function isKnownNetwork(networkId: number | undefined): boolean {
  return chainIdForNetwork(networkId) !== undefined
}
