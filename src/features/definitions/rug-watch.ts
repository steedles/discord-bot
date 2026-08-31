import { CHAINS } from '../../market/chains.js'
import type { FeatureDescriptor } from '../types.js'

const CHAIN_OPTIONS = Object.values(CHAINS).map((c) => ({ value: c.id, label: c.label }))

export const RUG_WATCH: FeatureDescriptor = {
  id: 'rug-watch',
  name: 'Rug Watch',
  description:
    'Watches for token addresses posted by other bots (Rick, etc.) or members, and replies with an independent rug check.',
  icon: '🛡️',
  kind: 'listener',
  // Off until someone asks for it: this one reads messages and talks back.
  defaultEnabled: false,
  commands: [],
  settings: [
    {
      key: 'watchSources',
      type: 'multiselect',
      label: 'Whose messages to watch',
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
        'Comma-separated Discord user IDs. Leave empty to react to any bot. Narrow this to Rick once you have its ID, to avoid replying to every bot in the channel.',
      default: '',
      maxLength: 400,
      placeholder: '123456789012345678, 987654321098765432',
      showWhen: { key: 'watchSources', equals: 'bots' },
    },
    {
      key: 'chains',
      type: 'multiselect',
      label: 'Chains',
      description: 'Leave empty to check tokens on every supported chain.',
      default: [],
      options: CHAIN_OPTIONS,
      emptyMeansAll: true,
    },
    {
      key: 'minRiskToReply',
      type: 'number',
      label: 'Only reply at or above this risk',
      description:
        '0 replies to every token. Raise it so the bot only speaks up when something is actually wrong - much less noise in a busy channel.',
      default: 0,
      min: 0,
      max: 100,
      step: 5,
    },
    {
      key: 'cooldownMinutes',
      type: 'number',
      label: 'Per-token cooldown',
      description: 'Skip a token already checked in this channel within this many minutes.',
      default: 10,
      min: 0,
      max: 1440,
      step: 5,
      unit: 'minutes',
    },
    {
      key: 'maxTokensPerMessage',
      type: 'number',
      label: 'Tokens per message',
      description: 'A message listing many addresses will only get this many checked.',
      default: 2,
      min: 1,
      max: 5,
      step: 1,
    },
    {
      key: 'replyToMessage',
      type: 'boolean',
      label: 'Reply inline',
      description: 'On: replies attached to the triggering message. Off: posts as a standalone message.',
      default: true,
    },
    {
      key: 'showMarketData',
      type: 'boolean',
      label: 'Include market data',
      description: 'Adds price, liquidity and market cap alongside the risk verdict.',
      default: true,
    },
  ],
}
