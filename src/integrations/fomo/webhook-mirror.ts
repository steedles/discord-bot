import type { EmbedBuilder } from 'discord.js'
import { config } from '../../config.js'
import { log } from '../../logger.js'

/**
 * Mirrors Fomo alerts to a Discord **webhook**, bot-wide.
 *
 * ## Why a webhook and not a channel
 *
 * A bot can only post to a guild it has been invited to - there is no API call
 * for anything else and no permission that can be granted remotely. A webhook
 * inverts that: an admin in the destination server creates it and hands over a
 * URL, and whatever holds the URL can post. So this is the only way to reach a
 * server we are not a member of, short of automating a user account, which is a
 * ToS violation.
 *
 * ## The rule it inherits
 *
 * Exactly the one `telegram-alerts.ts` and `signal-intake.ts` follow: a side
 * channel must never cost or delay the alert it accompanies. Callers fire this
 * without awaiting, every failure is caught and logged rather than thrown, and
 * the timeout is short. A dead webhook is a quiet log line, not a missing
 * Discord post.
 *
 * ## The URL is a credential
 *
 * Anyone holding it can post to that channel under any name and avatar. It
 * belongs in `.env.homelab` beside `FOMO_INGEST_SECRET`, is never committed, and
 * is never logged - `describeTarget` below exists so a log line can identify
 * which webhook failed without printing the token that authenticates it.
 */

const TIMEOUT_MS = 5_000

/** Discord rejects a payload with more than ten embeds outright. */
const MAX_EMBEDS = 10

export function fomoWebhookEnabled(): boolean {
  return Boolean(config.FOMO_WEBHOOK_URL)
}

/**
 * The webhook's id without its token, safe to log.
 *
 * A webhook URL is `.../webhooks/<id>/<token>`; the id identifies which one
 * failed and the token is the credential. Splitting them means an operator can
 * tell two webhooks apart in the logs without the logs becoming a way to post.
 */
function describeTarget(url: string): string {
  const m = /\/webhooks\/(\d+)\//.exec(url)
  return m ? `webhook ${m[1]}` : 'webhook'
}

/**
 * Post embeds to the configured webhook. Resolves either way.
 *
 * **Never await this on the alert path.** It is a mirror; the Discord post and
 * the stored record are the things that matter, and both have already happened
 * by the time this runs.
 */
export async function mirrorToWebhook(embeds: EmbedBuilder[]): Promise<void> {
  const url = config.FOMO_WEBHOOK_URL
  if (!url || embeds.length === 0) return

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // The destination server sees whatever name the webhook was created
        // with unless this overrides it. Naming it explicitly means the alerts
        // are identifiable in a channel that may carry other traffic.
        username: config.FOMO_WEBHOOK_NAME,
        embeds: embeds.slice(0, MAX_EMBEDS).map((e) => e.toJSON()),
      }),
      // A redirect here is a refusal, not a destination - the same reasoning
      // signal-intake.ts documents. A 3xx from a webhook URL means the URL is
      // wrong, and following it could POST an alert somewhere unintended.
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (res.status >= 300 && res.status < 400) {
      log.fomo.warn(
        { target: describeTarget(url), status: res.status },
        'fomo webhook mirror refused - the URL redirects, which means it is wrong',
      )
      return
    }

    if (!res.ok) {
      // 401/404 means the webhook was deleted or the URL is wrong; both need a
      // human, and neither is fixed by trying again.
      log.fomo.warn(
        { target: describeTarget(url), status: res.status },
        res.status === 401 || res.status === 404
          ? 'fomo webhook mirror rejected - the webhook was probably deleted'
          : 'fomo webhook mirror failed',
      )
    }
  } catch (err) {
    // Timeouts and DNS live here. Deliberately not retried: this is a mirror of
    // something that already posted, and a retry loop on a side channel is how
    // a dead endpoint starts costing the primary path.
    log.fomo.warn({ err, target: describeTarget(url) }, 'fomo webhook mirror failed')
  }
}
