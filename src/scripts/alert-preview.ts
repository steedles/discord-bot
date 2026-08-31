/**
 * Renders monitor alerts as terminal text.
 *
 * An embed is the product here - the numbers are only half of it - and the only
 * way to know a layout reads well is to look at one. This builds alerts from
 * fixtures so the shape can be checked without waiting for a token to actually
 * move.
 *
 *   pnpm alert-preview
 */
import { monitorAlertEmbed } from '../discord/embeds.js'
import { buildAlertContext } from '../monitor/detect/context.js'
import { detectChurn } from '../monitor/detect/churn.js'
import { detectLevelBreak } from '../monitor/detect/level.js'
import { detectVamp } from '../monitor/detect/vamp.js'
import type { MarketSnapshot, WhaleSwap } from '../monitor/providers/types.js'
import type { Reading, Trigger } from '../monitor/detect/types.js'

const NOW = Date.now()
const minutesAgo = (n: number) => NOW - n * 60_000

const snapshot: MarketSnapshot = {
  chainId: 'bsc',
  tokenAddress: '0xBEEA1111111111111111111111111111117777',
  pairAddress: '0xpool',
  symbol: '$牛来',
  name: 'Niu Lai',
  priceUsd: 0.02831,
  liquidityUsd: 1_880_000,
  marketCapUsd: 19_500_000,
  volume: { m5: 41_200, h1: 512_000, h24: 8_400_000 },
  txns: { m5: { buys: 84, sells: 141 }, h24: { buys: 9_100, sells: 8_800 } },
  priceChange: { m5: -2.1, h1: -8.4, h24: -38.5 },
  pairCreatedAt: minutesAgo(60 * 51),
  url: 'https://dexscreener.com/bsc/0xpool',
  imageUrl: 'https://dd.dexscreener.com/ds-data/tokens/bsc/0xbeea.png',
  hasSocials: true,
  fetchedAt: NOW,
}

const history: Reading[] = [
  { at: minutesAgo(1), priceUsd: 0.0291, liquidityUsd: 1_884_000, marketCapUsd: 21_000_000 },
  { at: minutesAgo(45), priceUsd: 0.0294, liquidityUsd: 1_900_000, marketCapUsd: 20_400_000 },
  { at: minutesAgo(110), priceUsd: 0.0297, liquidityUsd: 1_920_000, marketCapUsd: 29_710_000 },
]

const swaps: WhaleSwap[] = [
  { chainId: 'bsc', tokenAddress: snapshot.tokenAddress, pairAddress: '0xpool', symbol: '$牛来', side: 'sell', amountUsd: 200_000, txHash: '0xa', wallet: '0x8f2a0000000000000000000000000000c41d', at: minutesAgo(2) },
  { chainId: 'bsc', tokenAddress: snapshot.tokenAddress, pairAddress: '0xpool', symbol: '$牛来', side: 'sell', amountUsd: 150_000, txHash: '0xb', wallet: '0x8f2a0000000000000000000000000000c41d', at: minutesAgo(3) },
  { chainId: 'bsc', tokenAddress: snapshot.tokenAddress, pairAddress: '0xpool', symbol: '$牛来', side: 'sell', amountUsd: 62_000, txHash: '0xc', wallet: '0x8f2a0000000000000000000000000000c41d', at: minutesAgo(4) },
]

function render(
  label: string,
  trigger: Trigger,
  swaps: WhaleSwap[] = [],
  // Two of these alerts describe a different kind of token entirely - a $19.5m
  // coin does not turn its cap over six times an hour - so they bring their own.
  subject: MarketSnapshot = snapshot,
  readings: Reading[] = history,
): void {
  const context = buildAlertContext(subject, readings, swaps, NOW)
  const data = monitorAlertEmbed(trigger, subject, context, swaps[0]).toJSON()

  console.log(`\n${'─'.repeat(64)}\n${label}\n${'─'.repeat(64)}`)
  console.log(data.title)
  console.log()
  console.log(data.description)
  for (const field of data.fields ?? []) console.log(`\n${field.name}\n${field.value}`)
  console.log(`\n[footer] ${data.footer?.text}`)
  console.log(`[thumbnail] ${data.thumbnail?.url ?? 'none'}`)
}

const levelTrigger = detectLevelBreak(
  snapshot,
  history,
  { bufferPct: 1, onFall: true, onRise: true, highPriorityPct: 15, maxLookbackMinutes: 30 },
  NOW,
)

if (levelTrigger) render('Level break — with flow, no image', levelTrigger, swaps)

render('Volume spike — no swap source on this chain', {
  kind: 'spike',
  headline: '5m volume 8.2x its baseline',
  value: 8.2,
  threshold: 5,
  priority: 'high',
  score: 1.64,
  detail: ['5m volume $41.2K against a $5.0K baseline'],
})

/** A coin being passed around: the whole cap traded six times over in an hour. */
const pvp: MarketSnapshot = {
  ...snapshot,
  chainId: 'solana',
  tokenAddress: 'PvP111111111111111111111111111111111111111',
  symbol: 'ARENA',
  name: 'Arena',
  priceUsd: 0.00021,
  liquidityUsd: 42_000,
  marketCapUsd: 210_000,
  volume: { m5: 96_000, h1: 1_260_000, h24: 4_100_000 },
  txns: { m5: { buys: 220, sells: 214 }, h1: { buys: 2_140, sells: 2_090 }, h24: { buys: 9_000, sells: 8_900 } },
  priceChange: { m5: -1.4, h1: -14.2, h24: -61.0 },
  pairCreatedAt: minutesAgo(390),
  url: 'https://dexscreener.com/solana/arena',
}

const pvpHistory: Reading[] = [
  { at: minutesAgo(2), priceUsd: 0.000213, liquidityUsd: 43_000, marketCapUsd: 213_000 },
  { at: minutesAgo(40), priceUsd: 0.000244, liquidityUsd: 44_500, marketCapUsd: 244_000 },
  { at: minutesAgo(105), priceUsd: 0.000251, liquidityUsd: 45_000, marketCapUsd: 251_000 },
]

const churnTrigger = detectChurn(pvp, {
  minTurnover: 3,
  maxImbalancePct: 15,
  maxPriceChangePct: 5,
  minVolume1hUsd: 50_000,
  highPriorityTurnover: 8,
})

if (churnTrigger) {
  render('PvP coin — turnover with nothing to show for it', churnTrigger, [], pvp, pvpHistory)
}

/** The established coin, and the three-hour-old copy taking its flow. */
const runner: MarketSnapshot = {
  ...snapshot,
  chainId: 'solana',
  tokenAddress: 'RUNNER11111111111111111111111111111111111111',
  symbol: 'PENGU',
  name: 'Pudgy Penguins',
  liquidityUsd: 640_000,
  marketCapUsd: 24_000_000,
  volume: { m5: 18_000, h1: 190_000, h24: 3_100_000 },
  txns: { m5: { buys: 40, sells: 44 }, h1: { buys: 520, sells: 495 } },
  priceChange: { m5: -0.8, h1: -6.2, h24: -11.0 },
  pairCreatedAt: minutesAgo(60 * 24 * 40),
  url: 'https://dexscreener.com/solana/runner',
}

const runnerHistory: Reading[] = [
  { at: minutesAgo(2), priceUsd: 0.0284, liquidityUsd: 648_000, marketCapUsd: 24_100_000 },
  { at: minutesAgo(50), priceUsd: 0.0298, liquidityUsd: 690_000, marketCapUsd: 25_300_000 },
  { at: minutesAgo(115), priceUsd: 0.0301, liquidityUsd: 712_000, marketCapUsd: 25_600_000 },
]

const clone: MarketSnapshot = {
  ...runner,
  tokenAddress: 'CLONE111111111111111111111111111111111111111',
  symbol: '$pengu',
  name: 'PENGU',
  liquidityUsd: 96_000,
  marketCapUsd: 1_900_000,
  volume: { m5: 82_000, h1: 810_000, h24: 810_000 },
  txns: { m5: { buys: 310, sells: 240 }, h1: { buys: 2_600, sells: 2_100 } },
  pairCreatedAt: minutesAgo(185),
  url: 'https://dexscreener.com/solana/clone',
}

const vampTrigger = detectVamp(
  runner,
  [clone],
  {
    target: 'both',
    minVolumeRatio: 1.5,
    minCopycatVolume1hUsd: 50_000,
    minCopycatLiquidityUsd: 25_000,
    minCopycatTrades1h: 100,
    maxCopycatAgeMinutes: 1_440,
    highPriorityRatio: 3,
  },
  NOW,
)

if (vampTrigger) {
  render('Ticker vamp — a watched coin being drained', vampTrigger, [], runner, runnerHistory)
}
