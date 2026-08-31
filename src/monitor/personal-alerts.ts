/**
 * "My Alerts" - a dashboard user's personal tracked-coin list
 * (src/db/models.ts TelegramWatch), delivered to their own Telegram chat.
 *
 * Separate from telegram-alerts.ts's bot-wide mirror in three ways that
 * matter: every trigger kind fires here, not just `priority: 'high'` (a coin
 * someone chose to track is worth knowing about regardless of grade); the
 * caption carries the same full detail `telegramMonitorText`/`telegramCallText`
 * already build for the bot-wide chat (trigger detail lines, liquidity,
 * divergence/flow, the copyable CA and trade links), not a thin summary - the
 * caller passes that text in rather than this file building its own thinner
 * one; and a chart is mandatory, not best-effort - see `effectiveRails` and
 * the no-chart branch in `notifyPersonalWatchers` for what happens when one
 * genuinely cannot be drawn.
 *
 * Called from both of worker.ts's existing Telegram hook points
 * (`postCallSpike`, `post`), fire-and-forget, same contract as
 * `sendTelegramAlert`: never awaited on the alert path, never allowed to cost
 * or delay the Discord post it accompanies.
 */
import { CYAN, type Rail } from '../analysis/chart.js'
import { getCollections } from '../db/mongo.js'
import { log } from '../logger.js'
import { sendTelegramPhoto } from '../integrations/telegram-alerts.js'
import { railsFor, renderChartPng } from './chart-card.js'
import type { AlertContext } from './detect/context.js'
import type { Trigger } from './detect/types.js'
import type { MarketSnapshot } from './providers/types.js'

/** Telegram's own `sendPhoto` caption cap. */
const CAPTION_MAX_CHARS = 1024

/**
 * `post()` in worker.ts runs once per (Discord destination, candidate) pair -
 * a token watched by three channels for the same feature fires this function
 * three times for what is, to a personal watcher, one event. Rather than
 * restructure the destination loop to find "once per real trigger" (a bigger
 * change than this feature needs), collapse repeats of the same
 * token+trigger-kind within one polling pass: `MONITOR_POLL_SECONDS` defaults
 * to 60s and destinations fan out within a single tick, so 30s is comfortably
 * inside "the same event, posted to several channels" and comfortably outside
 * "this genuinely fired again next cycle".
 */
const DEDUPE_WINDOW_MS = 30_000
const recentlyNotified = new Map<string, number>()

function alreadyNotifiedRecently(chainId: string, tokenAddress: string, kind: string): boolean {
  const key = `${chainId}:${tokenAddress}:${kind}`
  const now = Date.now()
  const last = recentlyNotified.get(key)
  recentlyNotified.set(key, now)
  if (recentlyNotified.size > 500) {
    for (const [k, at] of recentlyNotified) if (now - at > DEDUPE_WINDOW_MS) recentlyNotified.delete(k)
  }
  return last !== undefined && now - last < DEDUPE_WINDOW_MS
}

/**
 * Every other chart-worthy alert only draws when it has a rail to draw
 * (chart-card.ts's own rule - a chart beside a number nobody measured is a
 * false claim). Wayne wants a chart on every personal alert regardless, so
 * this falls back to a plain "current price" rail rather than repurposing
 * `seriesIsTheClaim` (which means something more specific elsewhere: the
 * candle shape itself being the evidence, for trend-turn alerts) or loosening
 * the Discord-facing rule for every other channel.
 *
 * What this can't override: `renderChartPng` still refuses a chain with no
 * candle feed, a failed/rate-limited candle fetch, or too few/too sparse
 * candles to plot honestly. Those are genuine "there is no picture to draw"
 * cases - per Wayne's explicit rule (2026-08-25), a personal alert with no
 * chart does not go out as text instead, it does not go out at all. See the
 * no-chart branch in `notifyPersonalWatchers`.
 */
function effectiveRails(trigger: Trigger, snapshot: MarketSnapshot): Rail[] {
  const rails = railsFor(trigger, snapshot)
  if (rails.length > 0) return rails
  if (!snapshot.priceUsd || snapshot.priceUsd <= 0) return []
  return [{ value: snapshot.priceUsd, colour: CYAN, label: 'now' }]
}

/**
 * Finds everyone tracking this token and sends each of them their own
 * chart + message. A doc with no `telegramChatId` yet (tracked, not wired to
 * a chat) is filtered out by the query itself - that is the intended state
 * for someone who has not messaged the bot yet, not an error to log.
 *
 * `text` is the caller's own already-built `telegramMonitorText(...)` or
 * `telegramCallText(...)` - the same rich text sent to the bot-wide chat -
 * rather than a thinner summary built here, so a personal alert never carries
 * less detail than the one it is standing in for.
 */
export async function notifyPersonalWatchers(
  trigger: Trigger,
  snapshot: MarketSnapshot,
  context: AlertContext | undefined,
  text: string,
): Promise<void> {
  if (alreadyNotifiedRecently(snapshot.chainId, snapshot.tokenAddress, trigger.kind)) return

  const { telegramWatches } = getCollections()

  let watchers
  try {
    watchers = await telegramWatches
      .find({
        telegramChatId: { $exists: true },
        coins: { $elemMatch: { chainId: snapshot.chainId, tokenAddress: snapshot.tokenAddress } },
      })
      .toArray()
  } catch (err) {
    log.telegram.warn({ err: String(err) }, 'personal alerts: watcher lookup failed')
    return
  }
  if (watchers.length === 0) return

  const rails = effectiveRails(trigger, snapshot)
  const png = await renderChartPng({
    symbol: snapshot.symbol,
    chainId: snapshot.chainId,
    pairAddress: snapshot.pairAddress,
    rails,
    subline: context?.divergence ?? trigger.headline,
    priceUsd: snapshot.priceUsd,
    marketCapUsd: snapshot.marketCapUsd,
  })

  // A chart is mandatory here, not best-effort - a personal alert with no
  // chart does not go out as text, it does not go out. `renderChartPng`
  // already logs its own skip reason (chain unsupported, rate-limited,
  // too few/too sparse candles), so this is a count, not a silent drop.
  if (!png) {
    log.telegram.info(
      { chain: snapshot.chainId, symbol: snapshot.symbol, watchers: watchers.length },
      'personal alert skipped - no chart available',
    )
    return
  }

  const caption = text.slice(0, CAPTION_MAX_CHARS)

  for (const watch of watchers) {
    if (!watch.telegramChatId) continue // narrows the $exists filter above for TS
    void sendTelegramPhoto(watch.telegramChatId, png, caption)
  }
}
