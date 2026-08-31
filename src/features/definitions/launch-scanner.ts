import { CHAINS } from '../../market/chains.js'
import type { FeatureDescriptor } from '../types.js'
import { mentionRolesField } from '../fields.js'

const CHAIN_OPTIONS = Object.values(CHAINS).map((c) => ({ value: c.id, label: c.label }))

export const LAUNCH_SCANNER: FeatureDescriptor = {
  id: 'launch-scanner',
  name: 'Launch Scanner',
  description: 'Posts newly listed tokens that clear your liquidity, volume and risk filters.',
  icon: '🚀',
  kind: 'push',
  defaultEnabled: false,
  commands: [],
  help: {
    detail: [
      'Posts newly listed tokens that clear your filters: liquidity, 24h volume, maximum pool age, a vendor risk score and optionally having a website or socials. Two sources - DexScreener\'s new-listing feed across every chain, and pump.fun mints once they reach a real DEX pool, which makes it a graduation feed rather than a raw-launch one.',
      'The risk ceiling uses the same vendor scores as `/scan`, so a token nobody will score does not slip through as safe - it fails the filter.',
    ],
    firstStep: 'Enable it in a quiet channel first: a loose filter is a lot of posts.',
  },
  settings: [
    {
      key: 'sources',
      type: 'multiselect',
      label: 'Discovery sources',
      description:
        'DexScreener catches new listings across every chain. pump.fun only posts a mint once it reaches a real DEX pool, so it finds Solana graduations rather than raw launches.',
      default: ['dexscreener', 'pumpfun'],
      options: [
        { value: 'dexscreener', label: 'DexScreener new listings' },
        { value: 'pumpfun', label: 'pump.fun graduations (Solana)' },
      ],
    },
    {
      key: 'chains',
      type: 'multiselect',
      label: 'Chains',
      description: 'Leave empty to watch every supported chain.',
      default: [],
      options: CHAIN_OPTIONS,
      emptyMeansAll: true,
    },
    {
      key: 'minLiquidityUsd',
      type: 'number',
      label: 'Minimum liquidity',
      description: 'Below roughly $10k a pool cannot absorb a real position.',
      default: 15_000,
      min: 0,
      max: 100_000_000,
      step: 1_000,
      unit: 'USD',
    },
    {
      key: 'minVolume24hUsd',
      type: 'number',
      label: 'Minimum 24h volume',
      description: 'Filters out tokens with liquidity parked in them but nobody trading.',
      default: 25_000,
      min: 0,
      max: 100_000_000,
      step: 1_000,
      unit: 'USD',
    },
    {
      key: 'maxAgeMinutes',
      type: 'number',
      label: 'Maximum pair age',
      description: 'Only post pairs younger than this. 720 is twelve hours.',
      default: 720,
      min: 5,
      max: 20_160,
      step: 15,
      unit: 'minutes',
    },
    {
      key: 'maxRiskScore',
      type: 'number',
      label: 'Maximum risk score',
      description: 'Drops anything scoring above this. 0 is safest, 100 is riskiest.',
      default: 45,
      min: 0,
      max: 100,
      step: 5,
    },
    {
      key: 'requireSocials',
      type: 'boolean',
      label: 'Require a website or socials',
      description: 'Cuts most low-effort launches, at the cost of missing early stealth ones.',
      default: true,
    },
    {
      key: 'maxPostsPerCycle',
      type: 'number',
      label: 'Post limit per cycle',
      description: 'Caps how many launches land at once so a burst cannot flood the channel.',
      default: 5,
      min: 1,
      max: 25,
      step: 1,
    },
    mentionRolesField(),
  ],
}
