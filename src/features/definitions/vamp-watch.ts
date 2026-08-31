import type { FeatureDescriptor } from '../types.js'
import { monitorGateFields } from './volume-spikes.js'

export const VAMP_WATCH: FeatureDescriptor = {
  id: 'vamp-watch',
  name: 'Vamp Watch',
  description:
    'Posts when a newer token under the same ticker as a watched one is out-trading it, with the depth and trade count to mean it.',
  icon: '🧛',
  kind: 'push',
  defaultEnabled: false,
  commands: [],
  help: {
    detail: [
      'Posts when a newer token under the same ticker as a watched one is out-trading it. **Which side to hear about** picks the half you want: your own coin being drained, or the copy that is running - they are different trades, so it is a setting rather than a rule.',
      'Copy tickers are minted constantly and nearly all of them are an empty pool and a hopeful name, so existence is never the alert. The newer mint has to clear its own floors first - liquidity, trades in the hour, hourly volume, and young enough that a shared ticker still means something - and only then is the ratio against the original computed. Those four gate the *copy*, which the ordinary quality gates do not: those apply to whichever token is on the watchlist.',
      'It will not name a copy without both pool creation times (which one came second is the whole claim), across chains, or against an original that traded nothing. Tickers of two characters or fewer are ignored as collisions. Whether the *names* match as well as the tickers is stated either way, because tickers collide honestly and you need to judge the pairing yourself.',
      'This is the one alert that costs requests beyond the poll, so ticker searches are capped at four a minute, oldest first, and only while a channel has it on. On a long watchlist a given ticker is re-checked about every half hour rather than every cycle - `/monitor status` shows the coverage.',
    ],
    seeAlso: [
      '`/watch add <token>` - put a coin on the shared watchlist this reads from',
      '`/monitor status` - data source health, watchlist size and the request budget',
    ],
    firstStep: 'Enable it, then check `/monitor status` for ticker coverage.',
  },
  settings: [
    {
      key: 'target',
      type: 'select',
      label: 'Which side to hear about',
      description:
        'The two are different trades. A channel holding bags wants to know something is draining its coin; a channel trading the trenches wants the copy, because the copy is often the one that runs. Either way the alert is about the token on the watchlist - the other one is named in the message with its contract.',
      default: 'both',
      options: [
        { value: 'both', label: 'Both sides' },
        { value: 'original', label: 'Only when a watched token is being drained' },
        { value: 'copycat', label: 'Only when a watched token is the one out-trading' },
      ],
    },
    /*
     * The four settings below are the feature. Copy tickers are minted
     * constantly - a running coin collects a dozen namesakes in an afternoon,
     * nearly all of them an empty pool - so alerting on the existence of one is
     * a noise feed. These say what makes a copy a threat rather than a mint,
     * and they gate the *copy*, which the standard quality gates below do not:
     * those apply to whichever token is on the watchlist.
     */
    {
      key: 'minVolumeRatio',
      type: 'number',
      label: 'Volume ratio to fire',
      description:
        'How many times the older token\'s hourly volume the newer one must be doing. 1x is "level with it"; 1.5x means the flow has visibly moved. Below 1 the copy is still behind and there is nothing to report.',
      default: 1.5,
      min: 0.2,
      max: 100,
      step: 0.1,
      unit: 'x',
    },
    {
      key: 'minCopycatVolume1hUsd',
      type: 'number',
      label: 'Minimum volume on the copy',
      description:
        'The newer token must be doing this much in an hour on its own account. Without it, a dead original makes every clone look like it is winning.',
      default: 50_000,
      min: 0,
      max: 10_000_000,
      step: 5_000,
      unit: 'USD',
    },
    {
      key: 'minCopycatLiquidityUsd',
      type: 'number',
      label: 'Minimum liquidity on the copy',
      description:
        'Depth behind the newer token. A pool nobody can trade out of is not taking anyone\'s flow, whatever its volume prints. A copy whose liquidity nobody will report fails this rather than skipping it.',
      default: 25_000,
      min: 0,
      max: 100_000_000,
      step: 5_000,
      unit: 'USD',
    },
    {
      key: 'minCopycatTrades1h',
      type: 'number',
      label: 'Minimum trades on the copy',
      description:
        'Buys plus sells in the newer token\'s last hour. Volume from four wallets is a wash trade wearing a ticker, and this is the cheapest way to tell the two apart.',
      default: 100,
      min: 0,
      max: 100_000,
      step: 25,
    },
    {
      key: 'maxCopycatAgeMinutes',
      type: 'number',
      label: 'Maximum age of the copy',
      description:
        'Past this, a shared ticker is two coexisting tokens rather than one vamping the other. 1440 is 24 hours.',
      default: 1_440,
      min: 5,
      max: 43_200,
      step: 60,
      unit: 'minutes',
    },
    {
      key: 'highPriorityRatio',
      type: 'number',
      label: 'High-priority ratio',
      description: 'At or above this the alert may ping the role below.',
      default: 3,
      min: 1,
      max: 500,
      step: 0.5,
      unit: 'x',
    },
    /*
     * No minimum pool age: when the watched token is the copy, being new is the
     * event. The age filter that matters here is the one on the copy above.
     * The cooldown is long because a vamp is one story rather than a stream -
     * the ratio moves every cycle and would re-post all afternoon.
     */
    ...monitorGateFields({
      minLiquidityUsd: 15_000,
      minPairAgeMinutes: 0,
      minTxns5m: 5,
      minVolume24hUsd: 25_000,
      cooldownMinutes: 360,
      maxAlertsPerHour: 4,
    }),
  ],
}
