import { CHAINS } from '../../market/chains.js'
import type { FeatureDescriptor } from '../types.js'

const CHAIN_OPTIONS = Object.values(CHAINS).map((c) => ({ value: c.id, label: c.label }))

/**
 * Watch a coin's one-minute chart and say when the trend turns.
 *
 * The settings here are all about noise. A one-minute memecoin chart crosses
 * something constantly, so `confirmations`, `minMovePct` and `cooldownMinutes`
 * are the three dials that decide whether this is useful or unusable, and they
 * are per channel because a degen channel and a majors channel want different
 * answers.
 */
export const COIN_TRACKER: FeatureDescriptor = {
  id: 'coin-tracker',
  name: 'Coin Tracker',
  description:
    'Track a coin with /track and get pinged when its 1-minute trend turns - up to down, or down to up - with the indicators that called it.',
  icon: '📈',
  kind: 'command',
  // Nothing happens until somebody runs /track, so this is safe to leave on.
  defaultEnabled: true,
  commands: ['track'],
  help: {
    detail: [
      'Tracks a coin\'s 1-minute chart and pings you when the trend turns - up to down, or down to up - naming the indicators that called it. It is a trend change, not a prediction: the message says which crossings happened, and nothing about what comes next.',
      'Two refusals worth knowing. Minute candles only exist for minutes that actually traded, so a quiet pool can return 150 "1m candles" spanning most of a day; the detector measures real density and refuses rather than computing an average over gaps that describes nothing. And a chain with no candle feed - Robinhood Chain - cannot be tracked at all, which `/track add` says plainly rather than failing quietly.',
    ],
    seeAlso: [
      '`/track add <token> [chain]` - start following a coin on its 1-minute chart',
      '`/track list` - what you are tracking',
      '`/track remove <tracker>` - stop one; `/track clear` stops them all',
    ],
    firstStep: 'Try `/track add WIF`.',
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
      key: 'confirmations',
      type: 'number',
      label: 'Signals that must agree',
      description:
        'Of EMA 9/21, MACD and RSI. 1 fires on any crossover and is very noisy on a 1-minute chart; 3 is rare but strong. 2 is the useful middle.',
      default: 2,
      min: 1,
      max: 3,
      step: 1,
    },
    {
      key: 'minMovePct',
      type: 'number',
      label: 'Minimum move since the last signal',
      description:
        'Ignore a turn if the price has not moved at least this far since the last one reported. This is what silences a chart chopping across a crossover.',
      default: 1,
      min: 0,
      max: 50,
      step: 0.5,
      unit: '%',
    },
    {
      key: 'cooldownMinutes',
      type: 'number',
      label: 'Minimum gap between signals',
      description: 'No second notification for the same coin inside this window, whatever the chart does.',
      default: 15,
      min: 1,
      max: 240,
      step: 5,
      unit: 'minutes',
    },
    {
      key: 'announceToChannel',
      type: 'boolean',
      label: 'Announce in the channel',
      description:
        'On posts the turn where the tracker was created, mentioning whoever set it. Off sends it to them by DM only.',
      default: true,
    },
    {
      key: 'maxTrackersPerUser',
      type: 'number',
      label: 'Max coins per person',
      description:
        'Each tracked coin costs one candle request a minute against a shared free-tier budget, so this is a real limit rather than a policy one.',
      default: 5,
      min: 1,
      max: 25,
      step: 1,
    },
    {
      key: 'minLiquidityUsd',
      type: 'number',
      label: 'Minimum liquidity to track',
      description:
        'Technical analysis of a pool that thin is analysis of two traders. Below this, /track refuses.',
      default: 10_000,
      min: 0,
      max: 10_000_000,
      step: 1_000,
      unit: 'USD',
    },
    {
      key: 'chains',
      type: 'multiselect',
      label: 'Chains',
      description: 'Leave empty to allow every supported chain.',
      default: [],
      options: CHAIN_OPTIONS,
      emptyMeansAll: true,
    },
  ],
}
