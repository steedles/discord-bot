import { config } from '../../config.js'
import { sendTelegramMessage } from '../telegram-alerts.js'
import { log } from '../../logger.js'

/**
 * Health of the Fomo feed, and the alarm that fires when it stops.
 *
 * This exists because of how this integration fails. Fomo is an undocumented
 * private API: when they rename a field, drop a topic, or expire our session, we
 * do not get an error - we get silence. A dead feed and a quiet market look
 * identical from inside the bot, and the failure is therefore invisible exactly
 * when it matters. Everything here is about making silence loud.
 *
 * Telegram rather than Discord on purpose: the thing being reported is that the
 * pipeline into Discord has stopped working, so reporting it through that same
 * pipeline would be reporting it nowhere.
 */

export type FomoHealthState =
  | 'DISABLED'
  | 'STARTING'
  | 'AUTH_REQUIRED'
  | 'CONNECTED'
  | 'DEGRADED'
  | 'DISCONNECTED'

/** States that mean the feed is not delivering and will not fix itself. */
const UNHEALTHY: ReadonlySet<FomoHealthState> = new Set(['AUTH_REQUIRED', 'DEGRADED', 'DISCONNECTED'])

/**
 * How long a fault must persist before it is worth waking someone.
 *
 * A websocket drop that reconnects is routine and self-healing; the sidecar
 * retries with backoff and nobody needs to know. What the alarm is for is the
 * fault that reconnecting does NOT fix, so it waits long enough for the normal
 * recovery path to have had its chance.
 */
const GRACE_MINUTES = 15

/** Never re-send the same unresolved alarm more often than this. */
const REPEAT_HOURS = 6

export interface FomoHealthSnapshot {
  state: FomoHealthState
  detail?: string
  since: Date
  lastEventAt?: Date
  eventsSeen: number
}

/** Where the alarm goes. Falls back to the bot-wide chat when unset. */
function alertChat(): string | undefined {
  return config.FOMO_ALERT_TELEGRAM_CHAT ?? config.TELEGRAM_CHAT_ID
}

export function fomoAlertsConfigured(): boolean {
  return Boolean(config.TELEGRAM_BOT_TOKEN && alertChat())
}

export class FomoHealth {
  private state: FomoHealthState = config.FOMO_ENABLED ? 'STARTING' : 'DISABLED'
  private detail?: string
  private since = new Date()
  private lastEventAt?: Date
  private eventsSeen = 0

  /** When the current unhealthy run began. Undefined while healthy. */
  private unhealthySince?: Date
  /** When we last told anyone. Undefined if this fault has not been alerted. */
  private alertedAt?: Date

  /**
   * Last heartbeat from the sidecar, and what it said about its socket.
   *
   * These - not trade events - are what liveness is judged on. An hour with no
   * buys is an ordinary quiet market; an hour with no heartbeat means the
   * sidecar is gone, and an open socket delivering no frames at all means Fomo
   * changed something. `trending_tokens` runs at ~1900 frames/min, so the
   * sidecar always has traffic to report even when nobody we follow is trading.
   */
  private lastHeartbeatAt?: Date
  private socketAlive = false

  snapshot(): FomoHealthSnapshot {
    return {
      state: this.state,
      detail: this.detail,
      since: this.since,
      lastEventAt: this.lastEventAt,
      eventsSeen: this.eventsSeen,
    }
  }

  /**
   * A trade or thesis arrived. Counted and timestamped for reporting, but NOT
   * used to judge health: a quiet market would otherwise read as a broken feed.
   */
  noteEvent(at: Date = new Date()): void {
    this.lastEventAt = at
    this.eventsSeen++
  }

  /** The sidecar checked in. This is the liveness signal. */
  noteHeartbeat(socketAlive: boolean, at: Date = new Date()): void {
    this.lastHeartbeatAt = at
    this.socketAlive = socketAlive
  }

  /**
   * `now` is injectable because the fault timer and the alarm check must agree
   * on what time it is. When `set` read the wall clock and `check` took a clock
   * argument, the two disagreed and the alarm silently never fired.
   */
  set(state: FomoHealthState, detail?: string, now: Date = new Date()): void {
    if (state === this.state && detail === this.detail) return
    log.fomo.info({ from: this.state, to: state, detail }, 'fomo health changed')
    this.state = state
    this.detail = detail
    this.since = now

    if (UNHEALTHY.has(state)) {
      this.unhealthySince ??= now
    } else {
      // Recovered. Tell whoever we worried, then forget the fault entirely.
      if (this.alertedAt) void this.sendRecovered(state)
      this.unhealthySince = undefined
      this.alertedAt = undefined
    }
  }

  /**
   * Called on a timer. Decides whether the current fault has gone on long
   * enough to be worth an alarm, and whether an old alarm should repeat.
   *
   * Also promotes a silent-but-connected feed to DEGRADED: a websocket can sit
   * open and healthy-looking while delivering nothing, which is the exact
   * failure this whole module exists for.
   */
  async check(now: Date = new Date()): Promise<void> {
    if (!config.FOMO_ENABLED) return

    // Liveness is the sidecar checking in, never the market being busy. An hour
    // with no buys is a normal Tuesday; an hour with no heartbeat is a dead
    // sidecar, and a heartbeat reporting a closed socket is a dead feed.
    if (this.state === 'CONNECTED' && this.lastHeartbeatAt) {
      const silentMin = (now.getTime() - this.lastHeartbeatAt.getTime()) / 60_000
      if (silentMin > config.FOMO_STALE_MIN) {
        this.set('DEGRADED', `no heartbeat from the sidecar for ${Math.round(silentMin)} min`, now)
      } else if (!this.socketAlive) {
        this.set('DEGRADED', 'sidecar is up but its websocket is closed', now)
      }
    }

    if (!this.unhealthySince) return

    const faultMin = (now.getTime() - this.unhealthySince.getTime()) / 60_000
    if (faultMin < GRACE_MINUTES) return

    if (this.alertedAt) {
      const sinceAlertH = (now.getTime() - this.alertedAt.getTime()) / 3_600_000
      if (sinceAlertH < REPEAT_HOURS) return
    }

    await this.sendAlarm(Math.round(faultMin))
    this.alertedAt = now
  }

  private async sendAlarm(faultMin: number): Promise<void> {
    const chat = alertChat()
    if (!chat || !config.TELEGRAM_BOT_TOKEN) {
      log.fomo.warn({ state: this.state }, 'fomo feed is down and no telegram chat is configured to say so')
      return
    }
    const last = this.lastEventAt ? this.lastEventAt.toISOString() : 'never'
    const text = [
      '⚠️ Fomo feed is down',
      '',
      `State: ${this.state}`,
      this.detail ? `Detail: ${this.detail}` : undefined,
      `Down for: ${faultMin} min (reconnecting has not fixed it)`,
      `Last event: ${last}`,
      `Events seen this run: ${this.eventsSeen}`,
      '',
      this.state === 'AUTH_REQUIRED'
        ? 'The Fomo session has expired - it needs a manual login in the sidecar browser profile.'
        : 'Worth checking whether Fomo changed their protocol.',
    ]
      .filter(Boolean)
      .join('\n')

    try {
      await sendTelegramMessage(chat, text)
      log.fomo.warn({ state: this.state, faultMin }, 'fomo down alarm sent to telegram')
    } catch (err) {
      // The alarm failing must not take the bot with it - this is the error
      // path of the error path.
      log.fomo.error({ err }, 'could not send fomo down alarm')
    }
  }

  private async sendRecovered(state: FomoHealthState): Promise<void> {
    const chat = alertChat()
    if (!chat || !config.TELEGRAM_BOT_TOKEN) return
    try {
      await sendTelegramMessage(chat, `✅ Fomo feed recovered (${state})`)
    } catch (err) {
      log.fomo.error({ err }, 'could not send fomo recovery notice')
    }
  }
}
