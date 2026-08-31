import type { FeatureDescriptor } from '../types.js'
import { monitorGateFields } from './volume-spikes.js'

/**
 * Round-number market-cap crossings.
 *
 * A different question from every other monitor feature. Volume Spikes and
 * Trending ask whether something is moving unusually; Dip Hunter asks how far
 * off its high it is. This one ignores rate entirely and asks whether the token
 * just crossed a number people say out loud - $10M, $50M, $1M on the way back
 * down. A slow bleed from $31M to $19M never registers as a spike and is the
 * single most talked-about thing that can happen to a coin that size.
 *
 * The levels are a fixed 1-2-5 ladder, deliberately. A "support level" fitted to
 * where price previously turned would always find something, and calling that a
 * level is the same invention as a hand-rolled risk score - so the alert only
 * ever claims the crossing of a number chosen before the fact.
 */
export const LEVEL_BREAK: FeatureDescriptor = {
  id: 'level-break',
  name: 'Level Break',
  description:
    'Posts when a watched token crosses a round market-cap level, in either direction. $10M, $20M, $50M and so on.',
  icon: '🎯',
  kind: 'push',
  defaultEnabled: false,
  commands: [],
  help: {
    detail: [
      'Posts when a watched token crosses a round market-cap level in either direction - a 1-2-5 ladder, so $10M, $20M, $50M and the same at every order of magnitude. Every other detector asks "is this moving unusually"; this one asks whether it just crossed a number people actually talk about.',
      'The ladder is fixed before the fact, never fitted to the chart. A "support level" derived from where price previously turned will always find something, and naming that a level is invention - so a fall from $29.7M to $28.3M crosses nothing and says nothing.',
      'The crossing is measured against the most recent prior reading, because a crossing is an event between two consecutive observations. Comparing against two hours ago would re-report a level the token crossed long ago as if it had just happened.',
    ],
    seeAlso: [
      '`/watch add <token>` - put a coin on the shared watchlist this reads from',
      '`/monitor status` - data source health, watchlist size and the request budget',
    ],
    firstStep: 'Add a coin near a round number and watch for the cross.',
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
      key: 'onFall',
      type: 'boolean',
      label: 'Alert on breaks downward',
      description: 'Posts when the market cap falls through a level.',
      default: true,
    },
    {
      key: 'onRise',
      type: 'boolean',
      label: 'Alert on breaks upward',
      description: 'Posts when the market cap climbs through a level.',
      default: true,
    },
    {
      key: 'bufferPct',
      type: 'number',
      label: 'Clear the level by',
      description:
        'How far past a level the market cap has to be before the crossing counts. Without this a coin resting on $10M re-alerts every cycle as the last digit wobbles across it.',
      default: 1,
      min: 0,
      max: 20,
      step: 0.5,
      unit: '%',
    },
    {
      key: 'maxLookbackMinutes',
      type: 'number',
      label: 'Compare against a reading from',
      description:
        'A crossing is an event between two consecutive readings. Reaching further back than this reports a level the token crossed a while ago as though it had just happened.',
      default: 30,
      min: 2,
      max: 120,
      step: 1,
      unit: 'minutes',
    },
    {
      key: 'highPriorityPct',
      type: 'number',
      label: 'High-priority move',
      description:
        'A crossing that came with a move at least this large may ping the role below. Judged on how far it moved, not on how big the number was.',
      default: 15,
      min: 1,
      max: 100,
      step: 1,
      unit: '%',
    },
    ...monitorGateFields({
      // Level breaks are about size, so a token too small to have a meaningful
      // market cap has nothing to say here - hence a higher liquidity floor than
      // the spike detectors use.
      minLiquidityUsd: 30_000,
      minPairAgeMinutes: 60,
      minTxns5m: 3,
      minVolume24hUsd: 50_000,
      // Levels are far apart, so a token crossing several in an hour is genuinely
      // moving and should be allowed to say so.
      cooldownMinutes: 30,
      maxAlertsPerHour: 6,
    }),
  ],
}
