import { config } from './config.js'
import { log } from './log.js'

/**
 * Ships raw Fomo payloads to the bot.
 *
 * Raw, deliberately: normalisation lives in the bot
 * (`src/integrations/fomo/normalise.ts`) so there is exactly one place that
 * knows Fomo's field names. The sidecar's job is transport and nothing else.
 *
 * Events are queued and flushed on a short timer so a burst of trades costs one
 * request rather than ten. A failed flush puts the batch back at the FRONT of
 * the queue: these are ordered activity events, and re-appending would deliver
 * them out of order after a blip.
 */

interface Queued {
  payload: unknown
  receivedAt: string
}

export class Forwarder {
  private queue: Queued[] = []
  private timer?: NodeJS.Timeout
  private flushing = false
  private consecutiveFailures = 0

  enqueue(payload: unknown): void {
    this.queue.push({ payload, receivedAt: new Date().toISOString() })
    // Cap the queue. If the bot has been unreachable for a long time, the right
    // outcome is losing the OLDEST events - by the time it comes back, an hour
    // old trade is not news, and the bot would discard it as stale anyway.
    if (this.queue.length > 500) this.queue.splice(0, this.queue.length - 500)
    this.schedule()
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, config.batchMs)
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return
    this.flushing = true
    const batch = this.queue.splice(0, config.maxBatch)

    try {
      if (config.dryRun) {
        for (const e of batch) logEvent(e.payload)
      } else {
        await this.post(batch)
        this.consecutiveFailures = 0
      }
    } catch (err) {
      this.consecutiveFailures++
      // Front, not back: activity events are ordered.
      this.queue.unshift(...batch)
      log.warn('forward failed', {
        error: String(err),
        queued: this.queue.length,
        consecutiveFailures: this.consecutiveFailures,
      })
    } finally {
      this.flushing = false
      if (this.queue.length > 0) this.schedule()
    }
  }

  private async post(batch: Queued[]): Promise<void> {
    const res = await fetch(new URL('/api/fomo/events', config.botUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.ingestSecret ? { authorization: `Bearer ${config.ingestSecret}` } : {}),
      },
      body: JSON.stringify({ events: batch }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`bot responded ${res.status}`)
  }

  /**
   * Tells the bot the sidecar is alive and what it is seeing.
   *
   * This is how a dead sidecar becomes visible: the bot infers DEGRADED from
   * heartbeats stopping. Without it, a crashed sidecar and a quiet market are
   * indistinguishable from the bot's side - which is the exact failure mode this
   * integration is most likely to have.
   */
  async heartbeat(state: string, detail: Record<string, unknown>): Promise<void> {
    if (config.dryRun) {
      log.info('heartbeat', { state, ...detail })
      return
    }
    try {
      await fetch(new URL('/api/fomo/heartbeat', config.botUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(config.ingestSecret ? { authorization: `Bearer ${config.ingestSecret}` } : {}),
        },
        body: JSON.stringify({ state, ...detail }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (err) {
      log.warn('heartbeat failed', { error: String(err) })
    }
  }

  get pending(): number {
    return this.queue.length
  }
}

/** Human-readable one-liner for dry-run, so a real trade is obvious in the logs. */
function logEvent(payload: unknown): void {
  const p = payload as Record<string, unknown>
  const kind = String(p.type ?? 'unknown')
  const who = String(p.userHandle ?? '?')
  const ticker = String(p.ticker ?? '?')
  const extra =
    kind === 'thesis'
      ? JSON.stringify((p.comment as Record<string, unknown> | undefined)?.comment ?? '')
      : `$${Number(p.usdAmount ?? 0).toFixed(2)}`
  log.info(`EVENT ${kind.padEnd(10)} ${who} ${ticker} ${extra}`)
}
