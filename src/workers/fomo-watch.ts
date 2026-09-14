import type { Client, MessageCreateOptions } from 'discord.js'
import { config } from '../config.js'
import { getCollections } from '../db/mongo.js'
import { listEnabledPushInstances } from '../db/features.js'
import { fomoThesisEmbed, fomoTradeEmbed } from '../discord/embeds.js'
import { pingFor } from '../discord/mentions.js'
import { FOMO_WATCH } from '../features/definitions/fomo-watch.js'
import { defaultSettings, readSettings } from '../features/types.js'
import { recordAlert } from '../integrations/fomo/alert-store.js'
import { fomoWebhookEnabled, mirrorToWebhook } from '../integrations/fomo/webhook-mirror.js'
import { FomoHealth } from '../integrations/fomo/health.js'
import { isStale, normaliseActivity } from '../integrations/fomo/normalise.js'
import type { FomoActivityEvent } from '../integrations/fomo/types.js'
import { log } from '../logger.js'

/** Total attempts per message, first included. Three covers a DNS blip; ten would not help. */
const FOMO_SEND_ATTEMPTS = 3
/** Base delay between attempts, multiplied by the attempt number. */
const FOMO_SEND_RETRY_MS = 1_000

/**
 * Is this failure worth another attempt?
 *
 * The distinction that matters: a Node system error carries a **string** code -
 * `EAI_AGAIN`, `ECONNRESET`, `ETIMEDOUT` - and is a network hiccup that may well
 * be gone in a second. Discord's own errors carry a numeric code and an HTTP
 * status; a 4xx there means permissions or a bad payload, which will be just as
 * broken on the next try, so retrying only adds rate-limit pressure for every
 * other channel. 5xx is Discord's problem and may pass.
 *
 * Unknown shapes are treated as permanent. Retrying something we do not
 * understand is how a single bad message becomes a loop.
 */
export function isTransientSendError(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown } | null
  if (!e || typeof e !== 'object') return false
  if (typeof e.code === 'string') return true
  if (typeof e.status === 'number') return e.status >= 500
  return false
}

/**
 * Turns raw Fomo payloads into Discord posts.
 *
 * Push, not poll: events are handed in by the ingest route as the sidecar
 * forwards them, so there is no timer driving the work. The only timer here is
 * the health check that decides whether the feed has gone quiet in a way that
 * needs a human.
 *
 * Order matters and is deliberate: **age, then dedup, then per-channel filters.**
 * Age first because a replayed hour-old trade should never reach the dedup
 * table - if it did, a later genuine re-delivery would be suppressed by a row
 * written for an event nobody ever saw.
 */
export class FomoWatchWorker {
  readonly health = new FomoHealth()
  private timer?: NodeJS.Timeout

  /** channelId -> epoch ms of posts in the last hour. */
  private readonly recentByChannel = new Map<string, number[]>()
  /** `${channelId}:${traderHandle}` -> epoch ms of that trader's last post. */
  private readonly lastByTrader = new Map<string, number>()

  constructor(private readonly client: Client) {}

  start(): void {
    if (!config.FOMO_ENABLED) {
      log.fomo.info('fomo watch disabled')
      return
    }
    log.fomo.info(
      { staleMin: config.FOMO_STALE_MIN, maxAgeMin: config.FOMO_MAX_EVENT_AGE_MIN },
      'fomo watch worker started',
    )
    // The alarm's own clock. Everything else here is driven by arriving events,
    // which is exactly why silence needs something that ticks on its own.
    this.timer = setInterval(() => void this.health.check(), 60_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  /** The sidecar checked in. Liveness, and never the market being busy. */
  noteHeartbeat(state: string, socketAlive: boolean): void {
    this.health.noteHeartbeat(socketAlive)
    if (state === 'AUTH_REQUIRED') this.health.set('AUTH_REQUIRED', 'the fomo session has expired')
    else if (state === 'CONNECTED') this.health.set('CONNECTED')
    else if (state === 'DISCONNECTED') this.health.set('DISCONNECTED', 'sidecar reports its socket is closed')
  }

  /**
   * Handle a batch of raw payloads from the sidecar.
   *
   * Returns counts rather than throwing: the sidecar must not retry a batch
   * because one payload in it was malformed, or a single bad event would jam
   * the queue behind it forever.
   */
  async ingest(payloads: unknown[]): Promise<{ accepted: number; duplicate: number; stale: number; rejected: number }> {
    let accepted = 0
    let duplicate = 0
    let stale = 0
    let rejected = 0

    for (const payload of payloads) {
      const result = normaliseActivity(payload)
      if (!result.ok) {
        rejected++
        // Keep the raw payload: this is an undocumented API, and an unparseable
        // event is the first sign Fomo changed something.
        log.fomo.warn({ reason: result.reason, raw: result.raw }, 'unparseable fomo payload')
        continue
      }

      const event = result.event
      this.health.noteEvent(event.receivedAt)

      if (isStale(event, config.FOMO_MAX_EVENT_AGE_MIN)) {
        stale++
        continue
      }

      if (!(await this.claim(event))) {
        duplicate++
        continue
      }

      accepted++

      // The record, written before the post. Discord is the copy that scrolls
      // away; this is the one the dashboard reads, and it must not depend on a
      // Discord send having worked. `recordAlert` swallows its own failures for
      // the same reason the dedup write does - a sick database is a reason to
      // post anyway, not a reason to stop.
      await recordAlert(event)

      // Not awaited as part of the loop's critical path - a slow Discord send
      // must not hold up the rest of the batch or the sidecar's request.
      void this.post(event).catch((err) => log.fomo.error({ err, eventId: event.eventId }, 'fomo post failed'))
    }

    if (rejected || stale || duplicate) {
      log.fomo.debug({ accepted, duplicate, stale, rejected }, 'fomo batch')
    }
    return { accepted, duplicate, stale, rejected }
  }

  /**
   * Claim an event, or discover somebody already did.
   *
   * The unique index on `eventId` IS the dedup: a duplicate-key error is the
   * answer, and it cannot race the way a find-then-insert could when the same
   * event arrives twice in quick succession after a reconnect.
   */
  private async claim(event: FomoActivityEvent): Promise<boolean> {
    try {
      await getCollections().fomoEvents.insertOne({
        eventId: event.eventId,
        tradeId: event.tradeId,
        kind: event.kind,
        traderHandle: event.traderHandle,
        ticker: event.ticker,
        createdAt: event.createdAt,
        seenAt: new Date(),
      })
      return true
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return false
      // A database problem is not a duplicate. Posting twice is a smaller
      // failure than silently dropping everything while Mongo is unwell.
      log.fomo.error({ err, eventId: event.eventId }, 'fomo dedup write failed - posting anyway')
      return true
    }
  }

  private async post(event: FomoActivityEvent): Promise<void> {
    const instances = await listEnabledPushInstances(FOMO_WATCH.id)

    // The webhook mirror is independent of the channel loop below, and
    // deliberately so: it reaches a server the bot is not in, so it must not
    // depend on this bot having a channel configured anywhere. It applies the
    // bot-wide size floor only - per-channel settings belong to channels.
    if (fomoWebhookEnabled() && this.wantedByMirror(event)) {
      const embed = event.kind === 'THESIS' ? fomoThesisEmbed(event) : fomoTradeEmbed(event)
      // Not awaited, like every other side channel here. A slow or dead webhook
      // must not delay the Discord posts that follow.
      void mirrorToWebhook([embed])
    }

    if (instances.length === 0) return

    for (const instance of instances) {
      if (!instance.channelId) continue
      const read = readSettings({ ...defaultSettings(FOMO_WATCH), ...instance.settings })

      // What this channel asked for. Turning buys and sells off in one channel
      // and theses off in another is how #fomo-trades and #fomo-thesis are
      // separated - there is no routing table anywhere, by design.
      const wanted =
        event.kind === 'BUY'
          ? read.bool('postBuys', true)
          : event.kind === 'SELL'
            ? read.bool('postSells', true)
            : event.kind === 'THESIS'
              ? read.bool('postTheses', true)
              : false
      if (!wanted) continue

      // Size gate applies to trades only - a thesis is worth reading whatever
      // the position behind it was.
      if (event.kind !== 'THESIS') {
        const minUsd = Math.max(read.num('minUsd', 0), config.FOMO_MIN_USD)
        if (minUsd > 0 && (event.usdAmount ?? 0) < minUsd) continue
      }

      const traders = read.list('traders')
      if (traders.length > 0 && event.traderHandle && !traders.includes(event.traderHandle)) continue

      if (!this.allowedNow(instance.channelId, event, read)) continue

      const channel = await this.client.channels.fetch(instance.channelId).catch(() => null)
      if (!channel?.isTextBased() || !('send' in channel)) continue

      const embed = event.kind === 'THESIS' ? fomoThesisEmbed(event) : fomoTradeEmbed(event)
      const ping = pingFor(read)
      const channelId = instance.channelId

      // Mentions are always listed explicitly, never left to Discord's parser -
      // the message can then only ping exactly who the settings name.
      const sent = await this.sendWithRetry(channel, channelId, {
        content: ping?.content || undefined,
        allowedMentions: ping?.allowed ?? { users: [], roles: [] },
        embeds: [embed],
      })
      if (sent) this.record(channelId, event)
    }
  }

  /**
   * Does the mirror want this event?
   *
   * Only the bot-wide `FOMO_MIN_USD` floor, and only on trades - a thesis is
   * worth reading whatever the position behind it was, which is the same call
   * the per-channel filter makes. Per-channel settings are deliberately NOT
   * consulted: they belong to specific channels in guilds this bot is in, and
   * the mirror's destination is neither.
   */
  private wantedByMirror(event: FomoActivityEvent): boolean {
    if (event.kind === 'UNKNOWN') return false
    if (event.kind === 'THESIS') return true
    return config.FOMO_MIN_USD <= 0 || (event.usdAmount ?? 0) >= config.FOMO_MIN_USD
  }

  /**
   * Send, and try again if the failure was the kind that passes.
   *
   * Measured: three alerts were lost outright between 2026-09-11 and 09-14 to
   * `getaddrinfo EAI_AGAIN discord.com` - a DNS blip on the host, lasting
   * seconds. There was no retry, so each one cost a message permanently. The
   * alert itself survived in `fomo_alerts` (the record is written before this
   * runs, deliberately), but the channel never saw it.
   *
   * **Only transient failures are retried.** A permission error is not going to
   * resolve itself in two seconds, and hammering Discord over one would turn a
   * misconfigured channel into rate-limit pressure on every other channel.
   */
  private async sendWithRetry(
    channel: { send: (payload: MessageCreateOptions) => Promise<unknown> },
    channelId: string,
    payload: MessageCreateOptions,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= FOMO_SEND_ATTEMPTS; attempt++) {
      try {
        await channel.send(payload)
        if (attempt > 1) log.fomo.info({ channelId, attempt }, 'fomo send succeeded on retry')
        return true
      } catch (err) {
        const last = attempt === FOMO_SEND_ATTEMPTS
        if (!isTransientSendError(err) || last) {
          log.fomo.warn({ err, channelId, attempt }, 'fomo send failed')
          return false
        }
        // Linear rather than exponential: the failures this covers last seconds,
        // and an alert that arrives a minute late has already lost its point.
        await new Promise((r) => setTimeout(r, FOMO_SEND_RETRY_MS * attempt))
      }
    }
    return false
  }

  /**
   * Flood control, which is a different job from deduplication.
   *
   * Dedup stops the same event twice; this stops one busy trader burying
   * everything else in a channel. Kept in memory rather than in Mongo on
   * purpose: the windows are minutes, and a restart clearing them is harmless
   * because the age guard already prevents a restart from replaying a backlog.
   *
   * Deliberately NOT `monitor/detect/dedupe.ts` - that limiter is keyed on
   * token per poll cycle, and this one is keyed on trader per push. Forcing the
   * shared helper to cover both would make it worse at both.
   */
  private allowedNow(
    channelId: string,
    event: FomoActivityEvent,
    read: ReturnType<typeof readSettings>,
  ): boolean {
    const now = Date.now()

    const recent = (this.recentByChannel.get(channelId) ?? []).filter((t) => now - t < 3_600_000)
    this.recentByChannel.set(channelId, recent)
    if (recent.length >= read.num('maxAlertsPerHour', 30)) return false

    const cooldownMin = read.num('cooldownMinutes', 0)
    if (cooldownMin > 0 && event.traderHandle) {
      const key = `${channelId}:${event.traderHandle}`
      const last = this.lastByTrader.get(key)
      if (last !== undefined && now - last < cooldownMin * 60_000) return false
    }
    return true
  }

  private record(channelId: string, event: FomoActivityEvent): void {
    const recent = this.recentByChannel.get(channelId) ?? []
    recent.push(Date.now())
    this.recentByChannel.set(channelId, recent)
    if (event.traderHandle) this.lastByTrader.set(`${channelId}:${event.traderHandle}`, Date.now())
  }
}
