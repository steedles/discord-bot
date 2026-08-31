import { mentionRolesField } from '../fields.js'
import type { FeatureDescriptor } from '../types.js'

/**
 * Buys, sells and theses from the traders the Fomo account follows.
 *
 * Fed by the `fomo-sidecar` container, which drives a real browser against
 * fomo.family and forwards the `trading_activity` websocket topic. All three
 * event types arrive on that one topic - theses included - so there is no
 * separate polling path and no second failure mode.
 *
 * **Routing to separate channels is what the per-channel settings are for.**
 * Enable this feature in each channel and switch off what that channel does not
 * want: a trades channel turns Theses off, a thesis channel turns Buys and
 * Sells off. That is the ordinary channel-row-replaces-server-row resolution
 * every other feature uses - no per-feature routing code exists, or should.
 *
 * The upstream is not ours to filter: `trading_activity` carries exactly the
 * accounts the Fomo account follows. Adding a trader means following them in
 * Fomo's UI; there is no setting here that can do it.
 */
export const FOMO_WATCH: FeatureDescriptor = {
  id: 'fomo-watch',
  name: 'Fomo Watch',
  description: 'Posts buys, sells and theses from the traders your Fomo account follows.',
  icon: '👀',
  kind: 'push',
  defaultEnabled: false,
  commands: [],
  help: {
    detail: [
      'Real-time activity from fomo.family: every buy, sell and thesis posted by a trader the linked Fomo account follows, forwarded as it happens.',
      'To split them across channels, enable this feature in each one and turn off what it should not carry - a `#fomo-trades` channel with Theses off, a `#fomo-thesis` channel with Buys and Sells off. Settings are per channel, so the two do not interfere.',
      'A buy and its thesis are **separate events**, typically about a minute apart, and are posted separately rather than merged. Folding them together would mean holding every buy back for a minute on the chance a thesis follows, which would make the fastest signal here the slowest.',
      'Who appears is decided in Fomo, not here: the feed carries the accounts your Fomo account follows and nothing else. Follow someone there and they show up; there is no list in this dashboard that can add them.',
      'Fomo publishes no transaction hash and no token amount, so alerts report USD value, price and market cap. Nothing is estimated to fill those gaps.',
    ],
    seeAlso: [
      '`/monitor status` - whether the Fomo feed is connected and when it last delivered',
      '`/feature fomo-watch` - the settings for this channel',
    ],
    firstStep: 'Turn on only the event types this channel should carry, then set a minimum trade size.',
  },
  settings: [
    {
      key: 'postBuys',
      type: 'boolean',
      label: 'Post buys',
      description: 'Turn off in a channel meant only for theses.',
      default: true,
    },
    {
      key: 'postSells',
      type: 'boolean',
      label: 'Post sells',
      description: 'Sells are as informative as buys, and are on by default for that reason.',
      default: true,
    },
    {
      key: 'postTheses',
      type: 'boolean',
      label: 'Post theses',
      description:
        'The written reasoning attached to a trade. Turn off in a channel meant only for trades.',
      default: true,
    },
    {
      key: 'minUsd',
      type: 'number',
      label: 'Minimum trade size',
      description:
        'USD value of the trade as Fomo reports it. Applies to buys and sells only - a thesis is worth reading whatever the position behind it was.',
      default: 0,
      min: 0,
      max: 10_000_000,
      step: 50,
      unit: 'USD',
    },
    {
      key: 'traders',
      type: 'multiselect',
      label: 'Only these traders',
      description:
        'Leave empty for everyone your Fomo account follows. This narrows that list; it cannot widen it.',
      default: [],
      options: [],
      emptyMeansAll: true,
    },
    {
      key: 'cooldownMinutes',
      type: 'number',
      label: 'Quiet period per trader',
      description:
        'How long one trader stays quiet in this channel after posting. Deduplication stops the same event twice; this stops one busy trader burying everything else.',
      default: 0,
      min: 0,
      max: 240,
      step: 1,
      unit: 'minutes',
    },
    {
      key: 'maxAlertsPerHour',
      type: 'number',
      label: 'Most alerts per hour',
      description: 'Ceiling on what this channel hears in a rolling hour, across all traders.',
      default: 30,
      min: 1,
      max: 200,
      step: 1,
    },
    mentionRolesField(),
  ],
}
