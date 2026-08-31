import type { FeatureDescriptor } from '../types.js'
import { monitorGateFields } from './volume-spikes.js'

export const PVP_COINS: FeatureDescriptor = {
  id: 'pvp-coins',
  name: 'PvP Coins',
  description:
    'Posts when a token trades several times its own market cap in an hour, buys and sells matched, and ends up nowhere.',
  icon: '⚔️',
  kind: 'push',
  defaultEnabled: false,
  commands: [],
  help: {
    detail: [
      'Posts when a token trades several times its own market cap in an hour, with buys and sells matched by count, and price flat or down over that same hour. Traders call that a PvP coin - no outside flow left, the same people selling to each other while the fees leak out the bottom.',
      'That phrase is a judgement and the alert does not make it. The headline states the arithmetic - *"1h volume is 6.0x its market cap, price -14.2%"* - and the feature\'s name carries the interpretation, the same split as a spike alert saying "8.2x its baseline" rather than "about to run".',
      'All three legs are required. A token whose transaction counts nobody reported has not been shown to be two-sided; it has not been checked, and letting it through would turn the balance test into "balanced, or nobody looked". The age and liquidity floors default lower than the spike channel\'s, because this describes tokens that are hours old by nature.',
    ],
    seeAlso: [
      '`/watch add <token>` - put a coin on the shared watchlist this reads from',
      '`/monitor status` - data source health, watchlist size and the request budget',
    ],
    firstStep: 'Costs no extra requests - safe to switch on and leave.',
  },
  settings: [
    {
      key: 'minTurnover',
      type: 'number',
      label: 'Minimum turnover',
      description:
        'How many times its own market cap the token must trade in an hour. 3x means the entire cap changed hands three times over - not a figure a token with money coming into it produces.',
      default: 3,
      min: 0.5,
      max: 100,
      step: 0.5,
      unit: 'x',
    },
    {
      key: 'maxImbalancePct',
      type: 'number',
      label: 'Maximum buy/sell imbalance',
      description:
        'How far apart buys and sells may be by count, as a percentage of all trades in the hour. A one-sided book is a token being bought or being dumped; a matched one is a token being passed around. 0 would demand a perfect match, which no real book produces.',
      default: 15,
      min: 0,
      max: 100,
      step: 5,
      unit: '%',
    },
    {
      key: 'maxPriceChangePct',
      type: 'number',
      label: 'Maximum price change',
      description:
        'The most price may have risen over the same hour. Above this the volume bought something, which is a different event with a different name. Negative values require the token to have actually fallen.',
      default: 5,
      min: -100,
      max: 500,
      step: 5,
      unit: '%',
    },
    {
      key: 'minVolume1hUsd',
      type: 'number',
      label: 'Minimum 1h volume',
      description:
        'Absolute floor, checked before the ratio. A token with a $4k market cap turns it over on a single trade and would otherwise be the loudest thing on the list.',
      default: 50_000,
      min: 0,
      max: 10_000_000,
      step: 5_000,
      unit: 'USD',
    },
    {
      key: 'highPriorityTurnover',
      type: 'number',
      label: 'High-priority turnover',
      description: 'At or above this the alert may ping the role below.',
      default: 8,
      min: 1,
      max: 500,
      step: 1,
      unit: 'x',
    },
    /*
     * Looser age and liquidity floors than the spike channel, because this
     * describes tokens that are hours old by nature. A 24-hour minimum would
     * leave the feature switched on and silent.
     */
    ...monitorGateFields({
      minLiquidityUsd: 20_000,
      minPairAgeMinutes: 60,
      minTxns5m: 20,
      minVolume24hUsd: 50_000,
      cooldownMinutes: 180,
      maxAlertsPerHour: 6,
    }),
  ],
}
