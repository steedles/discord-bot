import { CHAINS } from '../../market/chains.js'
import type { FeatureDescriptor } from '../types.js'
import { mentionRolesField } from '../fields.js'

const CHAIN_OPTIONS = Object.values(CHAINS).map((c) => ({ value: c.id, label: c.label }))

/**
 * Following up on calls made in the channel.
 *
 * When a coin gets called - by Rick, or by somebody pasting an address - it goes
 * on the watchlist automatically, is followed for a few minutes, and gets
 * dropped again if it does nothing. If it runs, the channel that called it hears
 * about it, with whoever called it tagged.
 *
 * The multiple is measured from the price at the moment of the call, which makes
 * this a different question from Volume Spikes: not "is this busy" but "did that
 * call work". The retirement rules exist because the watchlist is a fixed budget
 * of requests - a call that goes nowhere is holding a slot a live one could use.
 */
export const CALL_TRACKER: FeatureDescriptor = {
  id: 'call-tracker',
  name: 'Call Tracker',
  description:
    'Auto-watches coins called in the channel, drops the ones going nowhere, and reports back - tagging the caller - when one runs.',
  icon: '🎯',
  kind: 'listener',
  // It adds to a shared watchlist and posts unprompted. Both want asking for.
  defaultEnabled: false,
  commands: [],
  help: {
    detail: [
      'When a coin is called in the channel - by Rick, or by someone pasting a contract - it goes on the watchlist automatically, is followed for a few minutes, and is dropped again if it does nothing. If it runs, the channel hears about it with the caller tagged.',
      'Every multiple is measured from the price at the call, not from a baseline, because the question is "would following that call have made money". Only upward multiples fire: nobody wants tagging in their own bad call.',
      'Attribution follows the same honesty rule as everything else. A bot\'s call is credited to whoever it replied to, and to nobody at all when that cannot be worked out - guessing at a name is worse than leaving it out.',
    ],
    seeAlso: [
      '`/watch list` - called coins share the monitor\'s watchlist',
    ],
    firstStep: 'Enable it where calls actually get posted.',
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
      key: 'watchSources',
      type: 'multiselect',
      label: 'Whose calls to follow',
      description:
        'Bots covers Rick and similar token-info bots. Members catches people pasting a contract address straight into chat.',
      default: ['bots'],
      options: [
        { value: 'bots', label: 'Other bots' },
        { value: 'humans', label: 'Members' },
      ],
    },
    {
      key: 'botAllowlist',
      type: 'string',
      label: 'Only these bot IDs',
      description:
        'Comma-separated Discord user IDs. Leave empty to follow any bot. Narrow it to Rick so every bot that speaks does not fill the watchlist.',
      default: '',
      maxLength: 400,
      placeholder: '123456789012345678',
      showWhen: { key: 'watchSources', equals: 'bots' },
    },
    {
      key: 'alertMultiples',
      type: 'multiselect',
      label: 'Report at',
      description:
        'Which multiples of the call price are worth a message. Each fires once, and only upward - a call that went down is not something anyone wants tagging in.',
      default: ['1.5', '2', '5'],
      options: [
        { value: '1.25', label: '1.25x' },
        { value: '1.5', label: '1.5x' },
        { value: '2', label: '2x' },
        { value: '3', label: '3x' },
        { value: '5', label: '5x' },
        { value: '10', label: '10x' },
      ],
    },
    {
      key: 'tagCaller',
      type: 'boolean',
      label: 'Tag whoever called it',
      description:
        'Off still posts in the channel, without the mention. When a bot made the call the tag goes to whoever it was replying to, and to nobody if that cannot be worked out.',
      default: true,
    },
    {
      key: 'watchMinutes',
      type: 'number',
      label: 'Follow a call for',
      description:
        'How long a call is watched before it is dropped regardless. A call that has already run keeps its slot for this long from the call, not from the run.',
      default: 10,
      min: 2,
      max: 120,
      step: 1,
      unit: 'minutes',
    },
    {
      key: 'stuckMinutes',
      type: 'number',
      label: 'Judge it after',
      description:
        'Nothing is dropped before this. A coin called at launch has no volume and no market cap for the first minute by nature, and dropping it for that would lose the ones worth having.',
      default: 5,
      min: 1,
      max: 60,
      step: 1,
      unit: 'minutes',
    },
    {
      key: 'minMarketCapUsd',
      type: 'number',
      label: 'Drop it under',
      description: 'Still below this market cap once the judging window passes, and it goes.',
      default: 20_000,
      min: 0,
      max: 10_000_000,
      step: 5_000,
      unit: 'USD',
    },
    {
      key: 'volumeFloors',
      type: 'bands',
      label: 'Counts as no volume',
      description:
        'What "nothing happening" means depends on size: $1k of five-minute volume is alive for a $30k coin and dead for a $5m one, so the floor is set per market-cap band. The top band answers for everything above the last edge. Set a band to 0 to judge that size on market cap alone.',
      edgeLabel: 'Market cap up to',
      valueLabel: 'Minimum 5m volume',
      edgeUnit: 'USD',
      valueUnit: 'USD',
      min: 0,
      max: 10_000_000,
      maxRows: 6,
      default: [
        { upTo: 50_000, value: 500 },
        { upTo: 250_000, value: 2_000 },
        { upTo: 1_000_000, value: 5_000 },
        { upTo: null, value: 10_000 },
      ],
    },
    {
      key: 'minLiquidityUsd',
      type: 'number',
      label: 'Ignore calls under',
      description:
        'Refuses to follow a call on a pool this thin, before it takes a watchlist slot at all.',
      default: 5_000,
      min: 0,
      max: 10_000_000,
      step: 1_000,
      unit: 'USD',
    },
    {
      key: 'maxCallsPerHour',
      type: 'number',
      label: 'Calls followed per hour',
      description:
        'A ceiling per channel, because the watchlist is a shared budget of requests. Calls beyond it are ignored rather than queued.',
      default: 12,
      min: 1,
      max: 60,
      step: 1,
    },
    {
      key: 'chains',
      type: 'multiselect',
      label: 'Chains',
      description: 'Leave empty to follow calls on every supported chain.',
      default: [],
      options: CHAIN_OPTIONS,
      emptyMeansAll: true,
    },
    mentionRolesField(),
  ],
}
