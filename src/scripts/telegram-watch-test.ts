/**
 * Sends one real "My Alerts" chart + message through the personal-alerts
 * pipeline, against a live token and a real Telegram chat ID - unlike
 * chart-preview/alert-preview, this one actually sends. Built for verifying
 * the dashboard-to-Telegram round trip without waiting for a live market
 * trigger to fire: resolve a token, build a synthetic trigger the same shape
 * a real one would have, render its chart the same way
 * notifyPersonalWatchers() would, and send it.
 *
 *   pnpm telegram-watch-test <chainId> <tokenAddress> <telegramChatId>
 */
import { CYAN, type Rail } from '../analysis/chart.js'
import { config } from '../config.js'
import { sendTelegramPhoto, telegramMonitorText } from '../integrations/telegram-alerts.js'
import { railsFor, renderChartPng } from '../monitor/chart-card.js'
import type { Trigger } from '../monitor/detect/types.js'
import type { MarketSnapshot } from '../monitor/providers/types.js'
import { resolveToken, TokenNotFoundError, UnsupportedChainError } from '../market/resolve.js'

const [chainId, tokenAddress, telegramChatId] = process.argv.slice(2)
if (!chainId || !tokenAddress || !telegramChatId) {
  console.error('usage: telegram-watch-test <chainId> <tokenAddress> <telegramChatId>')
  process.exit(1)
}

if (!config.TELEGRAM_BOT_TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN is not set - nothing can be sent.')
  process.exit(1)
}

let result
try {
  result = await resolveToken(tokenAddress, chainId)
} catch (err) {
  if (err instanceof TokenNotFoundError || err instanceof UnsupportedChainError) {
    console.error(err.message)
    process.exit(1)
  }
  throw err
}

const pair = result.pair
const priceUsd = pair.priceUsd ? Number(pair.priceUsd) : undefined
const marketCapUsd = pair.marketCap ?? pair.fdv

// A synthetic trigger the same shape detectSpike() would build - real enough
// to exercise railsFor()'s default (no-rail) branch and the fallback below it.
const trigger: Trigger = {
  kind: 'spike',
  headline: `[test] 5m volume ${((pair.volume?.m5 ?? 0) / 1000).toFixed(1)}K`,
  value: 1,
  threshold: 1,
  priority: 'normal',
  score: 1,
  detail: ['This is a manual test send from pnpm telegram-watch-test, not a real alert.'],
}

const snapshot: MarketSnapshot = {
  chainId: pair.chainId,
  tokenAddress: pair.baseToken.address,
  pairAddress: pair.pairAddress,
  dexId: pair.dexId,
  symbol: pair.baseToken.symbol,
  name: pair.baseToken.name,
  priceUsd,
  marketCapUsd,
  volume: pair.volume ?? {},
  txns: pair.txns ?? {},
  priceChange: pair.priceChange ?? {},
  hasSocials: false,
  fetchedAt: Date.now(),
}

// Mirrors personal-alerts.ts's effectiveRails() - spike triggers get no rail
// from railsFor(), so this exercises the same "now" fallback a real personal
// alert would use.
const rails: Rail[] = railsFor(trigger, snapshot)
const effectiveRails: Rail[] =
  rails.length > 0 ? rails : priceUsd && priceUsd > 0 ? [{ value: priceUsd, colour: CYAN, label: 'now' }] : []

console.log(`${pair.baseToken.symbol} on ${pair.chainId} · pool ${pair.pairAddress}`)
console.log(`price ${priceUsd ?? 'n/a'} · mcap ${marketCapUsd ?? 'n/a'} · rails ${effectiveRails.length}`)

const png = await renderChartPng({
  symbol: pair.baseToken.symbol,
  chainId: pair.chainId,
  pairAddress: pair.pairAddress,
  rails: effectiveRails,
  subline: trigger.headline,
  priceUsd,
  marketCapUsd,
})

// A chart is mandatory for a real personal alert (see notifyPersonalWatchers)
// - no chart means no send, not a text-only fallback - so this mirrors that
// rather than papering over a genuine no-data case.
if (!png) {
  console.log('no chart could be rendered for this pool - a real personal alert would not send here either.')
  process.exit(1)
}

console.log(`chart rendered (${(png.length / 1024).toFixed(1)} KB) - sending photo`)
// Same rich caption a real trigger would carry - trigger detail lines,
// liquidity, the copyable CA and trade links - not a thin test-only summary.
const caption = telegramMonitorText(trigger, snapshot)
await sendTelegramPhoto(telegramChatId, png, caption)

console.log('sent - check the Telegram chat.')
