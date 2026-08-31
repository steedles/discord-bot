import { CHAINS } from '../../market/chains.js'
import { mentionRolesField } from '../fields.js'
import type { SettingField, FeatureDescriptor } from '../types.js'

const CHAIN_OPTIONS = Object.values(CHAINS).map((c) => ({ value: c.id, label: c.label }))

/**
 * The gates and rate limits every monitor feature carries.
 *
 * Shared as data rather than inherited, because each channel tunes them
 * separately: a whale-buy channel wants a much higher liquidity floor than a
 * spike channel, and copying the fields lets it have one.
 */
export function monitorGateFields(defaults: {
  minLiquidityUsd: number
  minPairAgeMinutes: number
  minTxns5m: number
  minVolume24hUsd: number
  cooldownMinutes: number
  maxAlertsPerHour: number
}): SettingField[] {
  return [
    {
      key: 'chains',
      type: 'multiselect',
      label: 'Chains',
      description: 'Leave empty to watch every supported chain.',
      default: [],
      options: CHAIN_OPTIONS,
      emptyMeansAll: true,
    },
    {
      key: 'minLiquidityUsd',
      type: 'number',
      label: 'Minimum liquidity',
      description:
        'Measured on the pool the price is quoted from, not summed across pools - it answers what one position could actually get filled at.',
      default: defaults.minLiquidityUsd,
      min: 0,
      max: 100_000_000,
      step: 5_000,
      unit: 'USD',
    },
    {
      key: 'minPairAgeMinutes',
      type: 'number',
      label: 'Minimum pool age',
      description:
        'Most rugs happen inside the first day. 1440 is 24 hours. Set to 0 to allow brand-new pairs, which is noisier by a wide margin.',
      default: defaults.minPairAgeMinutes,
      min: 0,
      max: 43_200,
      step: 60,
      unit: 'minutes',
    },
    {
      key: 'minTxns5m',
      type: 'number',
      label: 'Minimum trades in 5 minutes',
      description:
        'Volume from three trades is two people and a bot. A token with no transaction data at all fails this check rather than skipping it.',
      default: defaults.minTxns5m,
      min: 0,
      max: 1_000,
      step: 1,
    },
    {
      key: 'minVolume24hUsd',
      type: 'number',
      label: 'Minimum 24h volume',
      description: 'Filters tokens with liquidity parked in them but nobody trading.',
      default: defaults.minVolume24hUsd,
      min: 0,
      max: 100_000_000,
      step: 5_000,
      unit: 'USD',
    },
    {
      key: 'minHolders',
      type: 'number',
      label: 'Minimum holders',
      description:
        'Checked with RugCheck on Solana and GoPlus elsewhere, and only for alerts that already passed everything else, so it costs one lookup per alert rather than one per token. A token whose holder count nobody will confirm fails this. 0 turns it off.',
      default: 0,
      min: 0,
      max: 1_000_000,
      step: 100,
    },
    {
      key: 'cooldownMinutes',
      type: 'number',
      label: 'Per-token cooldown',
      description:
        'How long a token stays quiet after alerting. Without this a token sitting just over the threshold posts on every poll.',
      default: defaults.cooldownMinutes,
      min: 5,
      max: 1_440,
      step: 15,
      unit: 'minutes',
    },
    {
      key: 'maxAlertsPerHour',
      type: 'number',
      label: 'Alerts per hour',
      description:
        'Ceiling for this channel. When more qualify than fit, the weakest are dropped - high priority first, then whichever went furthest past its threshold.',
      default: defaults.maxAlertsPerHour,
      min: 1,
      max: 60,
      step: 1,
    },
    {
      key: 'pingOn',
      type: 'select',
      label: 'When to ping',
      description:
        'High priority only is the safe default: a role or person pinged on every alert mutes the ping, which costs you the alerts that actually mattered. Raise the thresholds before switching this to every alert.',
      default: 'high',
      options: [
        { value: 'high', label: 'High-priority alerts only' },
        { value: 'every', label: 'Every alert' },
        { value: 'never', label: 'Never ping' },
      ],
    },
    mentionRolesField(),
    {
      key: 'mentionUserIds',
      type: 'string',
      label: 'People to ping',
      description:
        'Discord user IDs, separated by spaces or commas. Pasting a mention like <@123…> works too. Turn on Developer Mode in Discord and right-click a name to copy an ID.',
      default: '',
      maxLength: 256,
      placeholder: '123456789012345678, 987654321098765432',
    },
  ]
}

export const VOLUME_SPIKES: FeatureDescriptor = {
  id: 'volume-spikes',
  name: 'Volume Spikes',
  description: 'Posts when a watched token trades far above its own normal 5-minute volume.',
  icon: '📊',
  kind: 'push',
  defaultEnabled: false,
  commands: [],
  help: {
    detail: [
      'Posts when a watched token\'s 5-minute volume clears a multiple of its own baseline. The baseline is the median of its 1h, 6h and 24h rates plus measured history, so a token that is always bursty does not trip it constantly, and one distorted window cannot set the bar.',
      'A spike is a fact about volume, so **Which direction counts** defaults to both - heavy selling is news too. Set it to up only and price must be rising over the same five minutes the volume spiked in; a missing price change is refused rather than treated as flat, or "up only" quietly becomes "up, or nobody checked".',
      'No chart is attached, deliberately. The spike is in volume, the renderer draws no volume panel, and a price chart beside a volume alert implies a claim about price that nobody measured.',
    ],
    seeAlso: [
      '`/watch add <token>` - put a coin on the shared watchlist this reads from',
      '`/monitor status` - data source health, watchlist size and the request budget',
    ],
    firstStep: 'Add a few coins with `/watch add`, then leave it a poll or two.',
  },
  settings: [
    {
      key: 'direction',
      type: 'select',
      label: 'Which direction counts',
      description:
        'Volume-only fires on any spike, green candles or red - heavy selling is news too. Up only requires price to be rising over the same five minutes the volume spiked in, so the channel hears about buying rather than about exits.',
      default: 'both',
      options: [
        { value: 'both', label: 'Up and down (any spike)' },
        { value: 'up', label: 'Up only (green candles)' },
      ],
    },
    {
      key: 'multiplier',
      type: 'number',
      label: 'Spike multiplier',
      description:
        'How many times its own baseline the 5-minute volume must reach. The baseline is the median of the token\'s 1h, 6h and 24h rates plus its measured history, so a token that is always bursty does not trip it constantly.',
      default: 5,
      min: 1.5,
      max: 100,
      step: 0.5,
      unit: 'x',
    },
    {
      key: 'minVolume5mUsd',
      type: 'number',
      label: 'Minimum 5m volume',
      description:
        'Absolute floor, checked before the ratio. A 40x jump on $600 of trading is arithmetic, not a signal.',
      default: 15_000,
      min: 0,
      max: 10_000_000,
      step: 1_000,
      unit: 'USD',
    },
    {
      key: 'highPriorityMultiplier',
      type: 'number',
      label: 'High-priority multiplier',
      description: 'At or above this the alert may ping the role below.',
      default: 12,
      min: 2,
      max: 500,
      step: 1,
      unit: 'x',
    },
    ...monitorGateFields({
      minLiquidityUsd: 50_000,
      minPairAgeMinutes: 1_440,
      minTxns5m: 10,
      minVolume24hUsd: 50_000,
      cooldownMinutes: 120,
      maxAlertsPerHour: 12,
    }),
  ],
}
