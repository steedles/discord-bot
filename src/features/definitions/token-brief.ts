import { CHAINS } from '../../market/chains.js'
import type { FeatureDescriptor } from '../types.js'

const CHAIN_OPTIONS = Object.values(CHAINS).map((c) => ({ value: c.id, label: c.label }))

/**
 * A read on whatever the channel is talking about.
 *
 * Rick and friends post a wall of numbers; this answers "so what?" in sentences.
 *
 * Note what `delivery` cannot offer: a message visible only to one person in the
 * channel. Discord allows a hidden message solely as the reply to an
 * interaction, and somebody else's post is not one - so the private option is a
 * DM, not an ephemeral reply.
 */
export const TOKEN_BRIEF: FeatureDescriptor = {
  id: 'token-brief',
  name: 'Token Brief',
  description:
    'When Rick (or anyone) posts a token, replies with a plain-English breakdown of it - price, liquidity, who holds it and what to watch out for.',
  icon: '📋',
  kind: 'listener',
  // It reads messages and talks back unprompted. Both want asking for.
  defaultEnabled: false,
  commands: [],
  help: {
    detail: [
      'Watches the channel for contract addresses - posted by a person, or inside another bot\'s message - and replies with a plain-English breakdown: what the token is, how deep the pool is, who holds it, and what to watch out for.',
      'It never parses another bot\'s layout. It sweeps the text for address-shaped strings and chain-bearing links and lets DexScreener confirm them, because an undocumented embed format changes and a layout parser would rot.',
      'Everything in a brief is something a number supports. Where a provider did not answer, the fact goes under *Nobody checked* rather than being estimated - and the vendor\'s findings and ours stay in separate lists, so you can see when they disagree.',
    ],
    seeAlso: [
      '`/scan <token>` - the same risk data on demand',
    ],
    firstStep: 'Paste a contract address in the channel and watch it reply.',
  },
  settings: [
    {
      key: 'delivery',
      type: 'select',
      label: 'Where the brief goes',
      description:
        'A channel reply is visible to everyone there. Discord cannot show a message to just one person in a channel, so the private option is a DM.',
      default: 'channel',
      options: [
        { value: 'channel', label: 'Reply in the channel' },
        { value: 'dm', label: 'Direct message' },
      ],
    },
    {
      key: 'replyToMessage',
      type: 'boolean',
      label: 'Reply inline',
      description:
        'Attaches the brief to the message that triggered it. Off posts it as a new message, which reads better when several land at once.',
      default: true,
      showWhen: { key: 'delivery', equals: 'channel' },
    },
    {
      key: 'recipients',
      type: 'string',
      label: 'Who gets the DM',
      description:
        'Comma-separated Discord user IDs. Leave empty and it goes to whoever last saved this feature. With no valid recipient nothing is sent at all.',
      default: '',
      maxLength: 400,
      placeholder: '123456789012345678, 987654321098765432',
      showWhen: { key: 'delivery', equals: 'dm' },
    },
    {
      key: 'watchSources',
      type: 'multiselect',
      label: 'Whose messages to read',
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
        'Comma-separated Discord user IDs. Leave empty to read any bot. Narrow this to Rick once you have its ID, so the channel does not get a brief for every bot that speaks.',
      default: '',
      maxLength: 400,
      placeholder: '123456789012345678',
      showWhen: { key: 'watchSources', equals: 'bots' },
    },
    {
      key: 'chains',
      type: 'multiselect',
      label: 'Chains',
      description: 'Leave empty to brief tokens on every supported chain.',
      default: [],
      options: CHAIN_OPTIONS,
      emptyMeansAll: true,
    },
    {
      key: 'detail',
      type: 'select',
      label: 'How much detail',
      description:
        'Full is the whole breakdown. Quick keeps the verdict, the headline numbers and the warnings - much less wall-of-text in a busy channel.',
      default: 'full',
      options: [
        { value: 'full', label: 'Full breakdown' },
        { value: 'short', label: 'Quick summary' },
      ],
    },
    {
      key: 'minLiquidityUsd',
      type: 'number',
      label: 'Ignore pools under',
      description:
        'Skips tokens with less liquidity than this. 0 briefs everything, including dead pools - which is sometimes exactly what you want to know.',
      default: 0,
      min: 0,
      max: 1_000_000,
      step: 1_000,
      unit: 'USD',
    },
    {
      key: 'cooldownMinutes',
      type: 'number',
      label: 'Per-token cooldown',
      description: 'Skip a token already briefed from this channel within this many minutes.',
      default: 30,
      min: 0,
      max: 1440,
      step: 5,
      unit: 'minutes',
    },
    {
      key: 'maxTokensPerMessage',
      type: 'number',
      label: 'Tokens per message',
      description: 'A message listing several addresses only produces this many briefs.',
      default: 1,
      min: 1,
      max: 5,
      step: 1,
    },
  ],
}
