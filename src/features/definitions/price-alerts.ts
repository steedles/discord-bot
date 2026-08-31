import { CHAINS } from '../../market/chains.js'
import type { FeatureDescriptor } from '../types.js'
import { mentionRolesField } from '../fields.js'

const CHAIN_OPTIONS = Object.values(CHAINS).map((c) => ({ value: c.id, label: c.label }))

export const PRICE_ALERTS: FeatureDescriptor = {
  id: 'price-alerts',
  name: 'Price Alerts',
  description: 'Members set price targets and get pinged in-channel when a token crosses one.',
  icon: '🔔',
  kind: 'command',
  defaultEnabled: true,
  commands: ['alert'],
  help: {
    detail: [
      'Anyone in the channel sets a target with `/alert add <token> above|below <price>` and gets pinged in the channel when the price crosses it. `repeat` keeps the alert alive after it fires; without it the alert is spent once it triggers.',
      'A crossing is measured between consecutive readings, so it fires on the crossing itself rather than every time the bot looks while the price sits past the target.',
    ],
    seeAlso: [
      '`/alert add <token> above|below <price>` - set a target',
      '`/alert list` - your own open alerts',
      '`/alert remove <alert>` - drop one; `/alert clear` drops them all',
    ],
    firstStep: 'Try `/alert add WIF above 2.50`.',
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
      key: 'maxAlertsPerUser',
      type: 'number',
      label: 'Alerts per member',
      description: 'How many active alerts one member may hold in this server.',
      default: 25,
      min: 1,
      max: 200,
      step: 1,
    },
    {
      key: 'chains',
      type: 'multiselect',
      label: 'Allowed chains',
      description: 'Leave empty to allow alerts on every supported chain.',
      default: [],
      options: CHAIN_OPTIONS,
      emptyMeansAll: true,
    },
    {
      key: 'requireVerifiedToken',
      type: 'boolean',
      label: 'Verified tokens only',
      description:
        'Rejects alerts on tokens matched by ticker guess. Members can still use a contract address, which is always exact.',
      default: false,
    },
    {
      key: 'allowRepeat',
      type: 'boolean',
      label: 'Allow repeating alerts',
      description: 'Lets members create alerts that re-arm instead of clearing after one hit.',
      default: true,
    },
    {
      key: 'minLiquidityUsd',
      type: 'number',
      label: 'Minimum liquidity to watch',
      description: 'Blocks alerts on pools too thin for the price to mean anything.',
      default: 0,
      min: 0,
      max: 10_000_000,
      step: 1_000,
      unit: 'USD',
    },
    {
      key: 'announceToChannel',
      type: 'boolean',
      label: 'Announce in channel',
      description: 'On: the alert fires publicly where it was created. Off: it is sent by DM only.',
      default: true,
    },
    mentionRolesField(),
  ],
}
