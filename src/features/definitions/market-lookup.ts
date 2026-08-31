import { CHAINS } from '../../market/chains.js'
import type { FeatureDescriptor } from '../types.js'

const CHAIN_OPTIONS = Object.values(CHAINS).map((c) => ({ value: c.id, label: c.label }))

export const MARKET_LOOKUP: FeatureDescriptor = {
  id: 'market-lookup',
  name: 'Market Lookup',
  description: 'On-demand price and risk checks with /price and /scan.',
  icon: '📊',
  kind: 'command',
  defaultEnabled: true,
  commands: ['price', 'scan'],
  help: {
    detail: [
      '`/price` answers what a token is worth right now - price, market cap, liquidity, 24h volume and how old the pool is. The price comes from a consensus across the token\'s pools rather than the deepest one, because a deep pool quoting orders of magnitude off is common and picking it by size alone would report the wrong number confidently.',
      '`/scan` adds the risk half: the vendor\'s own verdict - RugCheck on Solana, honeypot.is on Ethereum, BSC and Base, GoPlus elsewhere - plus holders and whether the pool looks tradable. The score always comes from a vendor. The bot never invents one, and data a vendor did not return reads as **Unknown** rather than as clean.',
      'A ticker you type is matched by search and can be the wrong coin. Any reply built that way shows the contract address and says it is unverified - paste a contract address instead when it matters.',
    ],
    seeAlso: [
      '`/price <token> [chain]` - what it is worth right now',
      '`/scan <token> [chain]` - the same token, with the risk report',
    ],
    firstStep: 'Try `/price WIF`, or paste a contract address.',
  },
  settings: [
    {
      key: 'chains',
      type: 'multiselect',
      label: 'Allowed chains',
      description: 'Leave empty to allow lookups on every supported chain.',
      default: [],
      options: CHAIN_OPTIONS,
      emptyMeansAll: true,
    },
    {
      key: 'ephemeral',
      type: 'boolean',
      label: 'Private replies',
      description: 'Only the member who ran the command sees the result. Keeps busy channels clean.',
      default: false,
    },
    {
      key: 'showRiskOnPrice',
      type: 'boolean',
      label: 'Include risk on /price',
      description: 'Adds a risk line to /price. Costs an extra provider call per lookup.',
      default: false,
    },
    {
      key: 'warnUnverified',
      type: 'boolean',
      label: 'Warn on ticker guesses',
      description:
        'Flags results matched by ticker rather than address or the verified list. Strongly recommended - tickers are not unique.',
      default: true,
    },
  ],
}
