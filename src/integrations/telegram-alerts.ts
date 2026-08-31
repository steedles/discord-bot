import { config } from '../config.js'
import { log } from '../logger.js'
import { getChain } from '../market/chains.js'
import { formatCompactUsd, formatUsdPrice } from '../market/format.js'
import { tradeLinks } from '../market/trade-links.js'
import type { AlertContext } from '../monitor/detect/context.js'
import type { Trigger } from '../monitor/detect/types.js'
import type { MarketSnapshot } from '../monitor/providers/types.js'
import type { TokenCall } from '../db/models.js'

/**
 * Mirrors every high-priority alert to one Telegram chat, bot-wide.
 *
 * Follows the same rule signal-intake.ts does for its own side-channel: it
 * can never cost or delay the Discord post it accompanies, so callers fire it
 * without awaiting and every failure here is caught and logged rather than
 * thrown. Off unless both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set.
 */

const TIMEOUT_MS = 5_000

export function telegramAlertsEnabled(): boolean {
  return Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID)
}

/**
 * Posts one message to one chat. Resolves either way - callers do not check,
 * and must not await it on the alert path. The low-level primitive both
 * `sendTelegramAlert` (the fixed bot-wide chat) and personal-alerts.ts (a
 * per-user chat ID) send through, so the fetch/timeout/error-logging shape
 * lives in exactly one place.
 *
 * Sent as plain text, deliberately with no `parse_mode`: a token's symbol or
 * name is upstream data, not something this codebase controls, and can carry
 * Markdown/HTML-special characters - escaping it correctly is more risk than
 * the formatting is worth. Telegram auto-links a bare URL in plain text
 * anyway, so the link at the end of the message is still tappable.
 */
export async function sendTelegramMessage(chatId: string, text: string): Promise<void> {
  const token = config.TELEGRAM_BOT_TOKEN
  if (!token) return

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      log.telegram.warn({ status: res.status, detail }, 'telegram alert refused')
    }
  } catch (err) {
    log.telegram.warn({ err: String(err) }, 'telegram alert unreachable')
  } finally {
    clearTimeout(timer)
  }
}

/** The bot-wide mirror every high-priority monitor/call alert already sends to. */
export async function sendTelegramAlert(text: string): Promise<void> {
  const chatId = config.TELEGRAM_CHAT_ID
  if (!chatId) return
  await sendTelegramMessage(chatId, text)
}

/**
 * One chart, to one chat. Same fire-and-forget contract as `sendTelegramAlert`
 * - resolves either way, never throws, callers must not await it on the alert
 * path. Uses `sendPhoto`, not `sendMessage`: Telegram wants the image as
 * multipart form data, not a JSON body. `caption` is capped at Telegram's
 * 1024 UTF-8 chars - callers pass a short summary, not the full multi-line
 * text `telegramMonitorText`/`telegramCallText` build for the bot-wide chat.
 */
export async function sendTelegramPhoto(chatId: string, photo: Buffer, caption: string): Promise<void> {
  const token = config.TELEGRAM_BOT_TOKEN
  if (!token) return

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const form = new FormData()
    form.append('chat_id', chatId)
    form.append('caption', caption)
    form.append('photo', new Blob([photo], { type: 'image/png' }), 'chart.png')

    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      signal: controller.signal,
      body: form,
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      log.telegram.warn({ status: res.status, detail }, 'telegram photo refused')
    }
  } catch (err) {
    log.telegram.warn({ err: String(err) }, 'telegram photo unreachable')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The contract address on its own line, plus FOMO and Axiom - the two venues
 * the group actually trades from a phone. No `[label](url)` markdown: this
 * whole file sends plain text with no `parse_mode` (see `sendTelegramAlert`),
 * so Discord-style link markup would show up as literal brackets. The address
 * alone on its own line is what makes it copyable without formatting -
 * Telegram's tap-to-select treats it as one word since it has no spaces, the
 * same reason a bare URL earlier in the message is still tappable.
 *
 * FOMO/Axiom only, not the full `tradeLinks()` set (GMGN, Jupiter) - a phone
 * notification is answering "do I need to look at this right now", not
 * listing every venue the Discord card already does.
 */
function copyableLines(snapshot: MarketSnapshot): string[] {
  const links = tradeLinks(snapshot.chainId, snapshot.tokenAddress, {
    dexId: snapshot.dexId,
    pairAddress: snapshot.pairAddress,
  }).filter((l) => l.label === 'FOMO' || l.label === 'Axiom')

  return [snapshot.tokenAddress, ...links.map((l) => `${l.label}: ${l.url}`)]
}

/**
 * Plain-text rendering of a monitor alert - the same headline and figures as
 * `monitorAlertEmbed` (src/discord/embeds.ts), stripped of Discord markup.
 * Kept in this file rather than shared with the embed builder: the two are
 * allowed to drift, since a phone notification and a Discord card answer
 * different questions ("do I need to look at this right now" vs "here is
 * everything measured").
 */
export function telegramMonitorText(
  trigger: Trigger,
  snapshot: MarketSnapshot,
  context?: AlertContext,
): string {
  const chain = getChain(snapshot.chainId)

  return [
    `\u{1F6A8} ${snapshot.symbol} — ${trigger.headline}`,
    `${chain?.label ?? snapshot.chainId} · ${snapshot.name}`,
    ...trigger.detail,
    '',
    `Price ${formatUsdPrice(snapshot.priceUsd)}`,
    `MCap ${formatCompactUsd(snapshot.marketCapUsd)}`,
    `Liquidity ${formatCompactUsd(snapshot.liquidityUsd)}`,
    ...(context?.divergence ? [context.divergence] : []),
    ...(context?.flow ? [context.flow] : []),
    '',
    ...copyableLines(snapshot),
    ...(snapshot.url ? ['', snapshot.url] : []),
  ].join('\n')
}

/** Plain-text rendering of a Call Tracker follow-up - always high priority. */
export function telegramCallText(call: TokenCall, snapshot: MarketSnapshot, trigger: Trigger): string {
  const chain = getChain(snapshot.chainId)

  return [
    `\u{1F3AF} ${call.symbol} — ${trigger.headline}`,
    `${chain?.label ?? snapshot.chainId} · called at ${formatUsdPrice(call.priceAtCall)}`,
    `Price ${formatUsdPrice(snapshot.priceUsd)}`,
    `MCap ${formatCompactUsd(snapshot.marketCapUsd)}`,
    '',
    ...copyableLines(snapshot),
    ...(snapshot.url ? ['', snapshot.url] : []),
  ].join('\n')
}
