import type { FeatureDescriptor } from '../types.js'
import { monitorGateFields } from './volume-spikes.js'

/**
 * Sustained momentum rather than a single burst.
 *
 * Needs the bot to have been watching the token for the whole run - the windows
 * are differenced from its own recorded readings, because the API only ever
 * reports trailing totals and a trailing total cannot tell three quarters of
 * climbing from one spike an hour ago that has not aged out yet. A token added
 * to the watchlist five minutes ago therefore cannot trigger this until enough
 * history exists, which is correct rather than a limitation.
 */
export const TRENDING: FeatureDescriptor = {
  id: 'trending',
  name: 'Trending Momentum',
  description: 'Posts tokens climbing in both volume and price across consecutive windows.',
  icon: '📈',
  kind: 'push',
  defaultEnabled: false,
  commands: [],
  help: {
    detail: [
      'Posts tokens climbing in both volume *and* price across several consecutive windows. Rising volume alone is a spike; this is the slower thing where both keep going.',
      'It needs history first. The upstream reports trailing windows that overlap - the last hour read now and read in fifteen minutes share forty-five minutes - so "consecutive windows of rising volume" cannot be read off the API and has to be differenced from our own stored readings. A token added minutes ago has nothing to difference yet.',
    ],
    seeAlso: [
      '`/watch add <token>` - put a coin on the shared watchlist this reads from',
      '`/monitor status` - data source health, watchlist size and the request budget',
    ],
    firstStep: 'Add coins, then give it a few windows before expecting anything.',
  },
  settings: [
    {
      key: 'windows',
      type: 'number',
      label: 'Consecutive windows',
      description:
        'How many windows in a row must each beat the one before, in both volume and price. Three is enough to rule out a single burst; more means later but stronger signals.',
      default: 3,
      min: 2,
      max: 8,
      step: 1,
    },
    {
      key: 'windowMinutes',
      type: 'number',
      label: 'Window length',
      description:
        'Shorter windows react sooner and catch more noise. The bot needs a recorded reading near each boundary, so windows below the poll interval will rarely have one.',
      default: 15,
      min: 5,
      max: 120,
      step: 5,
      unit: 'minutes',
    },
    {
      key: 'minPriceGainPct',
      type: 'number',
      label: 'Minimum price gain',
      description: 'Total move across the whole run, not per window.',
      default: 5,
      min: 0.5,
      max: 500,
      step: 0.5,
      unit: '%',
    },
    {
      key: 'minVolumeGainPct',
      type: 'number',
      label: 'Minimum volume gain',
      description:
        'Growth in the hourly volume rate across the run. Rising alone is not much; this asks it to rise by a meaningful amount.',
      default: 20,
      min: 0,
      max: 1_000,
      step: 5,
      unit: '%',
    },
    {
      key: 'highPriorityPriceGainPct',
      type: 'number',
      label: 'High-priority price gain',
      description: 'At or above this the alert may ping the role below.',
      default: 25,
      min: 1,
      max: 1_000,
      step: 5,
      unit: '%',
    },
    ...monitorGateFields({
      minLiquidityUsd: 50_000,
      minPairAgeMinutes: 1_440,
      minTxns5m: 10,
      minVolume24hUsd: 50_000,
      // Momentum runs last for a while, so a short cooldown would re-post the
      // same climb every cycle for as long as it continued.
      cooldownMinutes: 180,
      maxAlertsPerHour: 8,
    }),
  ],
}
