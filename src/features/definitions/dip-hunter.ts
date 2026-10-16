import type { FeatureDescriptor } from '../types.js'
import { monitorGateFields } from './volume-spikes.js'

/**
 * Buy-the-dip alerts, and the follow-up that says whether it bounced.
 *
 * The other monitor features look for something starting. This one looks for
 * something that already ran and has come off its high, which is a different
 * question and needs a different memory: the high has to come from our own
 * recorded readings, because the upstream only reports "against N hours ago" and
 * a token that ran to 3x and gave it all back reads as flat on that measure.
 *
 * A dip alert arms a follow-up. When the token climbs back past the recovery
 * target - measured from the price the first alert went out at, which is what
 * anyone acting on it would have paid - a recovery alert closes the pair. The
 * follow-up ignores the cooldown, since it is the second half of an alert
 * already sent rather than a new one.
 */
export const DIP_HUNTER: FeatureDescriptor = {
  id: 'dip-hunter',
  name: 'Dip Hunter',
  description:
    'Posts when a watched token falls a set percentage off its own recent high, then again when it recovers.',
  icon: '🩸',
  kind: 'push',
  defaultEnabled: false,
  commands: [],
  help: {
    detail: [
      'Two alerts, one pair. The first fires when a watched token is far enough below its own recent high and quotes that move in market cap; that arms a follow-up which replies to the same message when price climbs back past the recovery target. A dip that never recovers is forgotten after the wait, and the token becomes eligible for a fresh one.',
      'The high comes from our own recorded readings, not from the upstream. "Down 5% against an hour ago" is a different question - a token that ran to 3x and gave it all back reads as flat on that measure, while the peak only exists in a series.',
      'A drawdown is only as old as the history behind it. A token added ten minutes ago genuinely can be 60% off its high, but it is a ten-minute high - so the detector refuses below its minimum coverage, and every headline names the span actually measured rather than the one configured.',
    ],
    seeAlso: [
      '`/watch add <token>` - put a coin on the shared watchlist this reads from',
      '`/monitor status` - data source health, watchlist size and the request budget',
    ],
    firstStep: 'Add coins and wait out the minimum coverage before judging it.',
  },
  settings: [
    {
      key: 'includeChart',
      type: 'boolean',
      label: 'Attach a price chart',
      description:
        'Adds a candlestick image showing the level this alert is about. Silently skipped when the pool is too quiet to draw fairly or the candle feed is busy - the alert still posts either way.',
      default: true,
    },
    {
      key: 'drawdownPct',
      type: 'number',
      label: 'Drawdown to alert on',
      description:
        'How far below its own recent high the token has to be. On a fresh runner 30-40% is a normal breath; 60% is the kind of flush this is for.',
      default: 50,
      min: 5,
      max: 95,
      step: 5,
      unit: '%',
    },
    {
      key: 'highWindowMinutes',
      type: 'number',
      label: 'High measured over',
      description:
        'How far back the high is taken from. Readings are kept for 48h, but only the last 6h are loaded, so anything above 360 quietly behaves as 360.',
      default: 180,
      min: 15,
      max: 360,
      step: 15,
      unit: 'minutes',
    },
    {
      key: 'minCoverageMinutes',
      type: 'number',
      label: 'History needed first',
      description:
        'The bot refuses to call something a 180-minute high when it has only been watching for ten. Below this much recorded history a token cannot trigger a dip alert at all.',
      default: 45,
      min: 5,
      max: 360,
      step: 5,
      unit: 'minutes',
    },
    {
      key: 'recoveryPct',
      type: 'number',
      label: 'Recovery target',
      description:
        'How far above the dip-alert price the token must climb for the follow-up to fire. Set to 0 to alert the moment it is back to the alert price.',
      default: 10,
      min: 0,
      max: 200,
      step: 5,
      unit: '%',
    },
    {
      key: 'armedForMinutes',
      type: 'number',
      label: 'Wait for a recovery for',
      description:
        'After this long with no recovery the dip is forgotten, and the token can trigger a fresh dip alert instead.',
      default: 360,
      min: 15,
      max: 2_880,
      step: 15,
      unit: 'minutes',
    },
    {
      key: 'highPriorityDrawdownPct',
      type: 'number',
      label: 'High-priority drawdown',
      description: 'At or beyond this depth the alert may ping the role below.',
      default: 70,
      min: 5,
      max: 95,
      step: 5,
      unit: '%',
    },
    ...monitorGateFields({
      // Dips worth buying happen on coins young enough that a 24h age floor
      // would exclude the entire use case, so this leans on liquidity instead.
      minLiquidityUsd: 25_000,
      minPairAgeMinutes: 60,
      minTxns5m: 5,
      minVolume24hUsd: 50_000,
      // A token that keeps sliding should not print a new dip every cycle; the
      // recovery follow-up is exempt from this.
      cooldownMinutes: 120,
      maxAlertsPerHour: 10,
    }),
  ],
}
