import type { FeatureDescriptor } from '../types.js'
import { monitorGateFields } from './volume-spikes.js'

/**
 * Single large swaps.
 *
 * Only fires on chains that can report an individual transaction: Solana via
 * Helius, and the EVM chains with an RPC configured. Everywhere else the bot has
 * transaction *counts* and nothing more, and dividing volume by count to
 * manufacture an average "whale buy" would report trades nobody made. The
 * dashboard shows which chains are live under `/monitor status`.
 */
export const WHALE_BUYS: FeatureDescriptor = {
  id: 'whale-buys',
  name: 'Whale Buys',
  description: 'Posts single swaps above a USD threshold, read transaction by transaction.',
  icon: '🐋',
  kind: 'push',
  defaultEnabled: false,
  commands: [],
  help: {
    detail: [
      'Posts single swaps above a USD threshold, read transaction by transaction - Solana over a Helius webhook, EVM chains from Uniswap V2/V3 swap logs on a node.',
      'A chain with no per-transaction source stays silent rather than approximating. Dividing 5-minute volume by the 5-minute trade count gives an *average* trade, and reporting that as a transaction would be inventing whale buys nobody made. `/monitor status` names which chains have a source and why the others do not.',
      'After an outage the log sweep looks back at most 2,000 blocks. Missing an old whale buy is the right outcome: it is news for about a minute, and posting an hour-old one as if it just happened is worse than not posting it.',
    ],
    seeAlso: [
      '`/watch add <token>` - put a coin on the shared watchlist this reads from',
      '`/monitor status` - data source health, watchlist size and the request budget',
    ],
    firstStep: 'Check `/monitor status` first - this one needs a data source per chain.',
  },
  settings: [
    {
      key: 'minUsd',
      type: 'number',
      label: 'Minimum swap size',
      description:
        'USD value of one transaction. Worked out as the token amount that moved on-chain times our last quoted price, so it can differ slightly from what an explorer shows.',
      default: 10_000,
      min: 100,
      max: 100_000_000,
      step: 1_000,
      unit: 'USD',
    },
    {
      key: 'highPriorityUsd',
      type: 'number',
      label: 'High-priority swap size',
      description: 'At or above this the alert may ping the role below.',
      default: 50_000,
      min: 100,
      max: 100_000_000,
      step: 5_000,
      unit: 'USD',
    },
    {
      key: 'buysOnly',
      type: 'boolean',
      label: 'Buys only',
      description: 'Turn off to hear about large sells too.',
      default: true,
    },
    ...monitorGateFields({
      // A whale-sized trade in a shallow pool is the pool being drained, so the
      // liquidity floor here is deliberately higher than the spike channel's.
      minLiquidityUsd: 100_000,
      minPairAgeMinutes: 1_440,
      minTxns5m: 0,
      minVolume24hUsd: 50_000,
      cooldownMinutes: 30,
      maxAlertsPerHour: 12,
    }),
  ],
}
