import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright-core'
import { TRADING_ACTIVITY, WS_HOST, config } from './config.js'
import { Forwarder } from './forward.js'
import { log } from './log.js'

/**
 * Fomo activity sidecar.
 *
 * Drives a real browser against fomo.family, watches the websocket the page
 * opens, and forwards `trading_activity` payloads to the bot.
 *
 * Why a browser at all: Fomo authenticates with Privy, whose JWT expires in
 * about 30 minutes and refreshes only while a real session is active. Holding a
 * browser open is what keeps the credential alive - a headless websocket client
 * would have to reimplement Privy's refresh flow, which is a second integration
 * rather than an optimisation.
 *
 * Why a separate container: the bot image is node:alpine and Playwright's
 * browsers are not built for musl. Across a process boundary a browser crash
 * also cannot take the bot down with it, which is a stated requirement.
 */

type State = 'STARTING' | 'CONNECTED' | 'AUTH_REQUIRED' | 'DISCONNECTED'

class Sidecar {
  private ctx?: BrowserContext
  private page?: Page
  private readonly forwarder = new Forwarder()

  private state: State = 'STARTING'
  /** Any frame at all. Proves the socket works even when nobody is trading. */
  private lastFrameAt?: Date
  /** trading_activity only. Quiet here is normal; quiet above is not. */
  private lastEventAt?: Date
  private wsOpen = false
  private eventsSeen = 0
  private backoffMs = config.reconnectMinMs
  private stopping = false

  async start(): Promise<void> {
    log.info('fomo sidecar starting', {
      appUrl: config.appUrl,
      headless: config.headless,
      dryRun: config.dryRun,
      channel: config.browserChannel ?? 'bundled',
    })

    await this.open()

    setInterval(() => void this.supervise(), 30_000)
    setInterval(() => void this.sendHeartbeat(), config.heartbeatSec * 1000)

    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.on(sig, () => void this.shutdown(sig))
    }
  }

  /**
   * Clear the profile lock left by whoever held it last.
   *
   * Chromium writes SingletonLock as a symlink naming the HOSTNAME that owns
   * the profile. Containers get a new hostname on every recreate, and the login
   * container is a different container again - so the lock always looks foreign
   * and Chromium refuses to start with rc=21. It cost 44 silent retries in the
   * login container before anyone looked at an exit code.
   *
   * Safe because the sidecar and the login desktop are never meant to run at
   * once (see fomo-login/README.md) - and if they did, the lock would not save
   * us anyway, two browsers on one profile corrupt it regardless.
   */
  private clearProfileLock(): void {
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      try {
        rmSync(join(config.profilePath, name), { force: true })
      } catch {
        /* nothing to clear is the normal case */
      }
    }
  }

  private async open(): Promise<void> {
    this.clearProfileLock()
    this.ctx = await chromium.launchPersistentContext(config.profilePath, {
      channel: config.browserChannel,
      headless: config.headless,
      viewport: { width: 1280, height: 900 },
      // Chrome's own sandbox is redundant inside a container that already
      // confines the process, and unavailable without extra capabilities.
      args: config.browserChannel ? [] : ['--no-sandbox', '--disable-dev-shm-usage'],
    })

    this.page = this.ctx.pages()[0] ?? (await this.ctx.newPage())
    this.attach(this.page)

    // A crashed page is recoverable; a crashed context is not, so let the
    // container restart policy handle that rather than pretending otherwise.
    this.page.on('crash', () => {
      log.error('page crashed')
      this.setState('DISCONNECTED')
      void this.reload('page crash')
    })

    await this.navigate()
  }

  private attach(page: Page): void {
    page.on('websocket', (ws) => {
      if (!ws.url().includes(WS_HOST)) return
      this.wsOpen = true
      this.setState('CONNECTED')
      this.backoffMs = config.reconnectMinMs
      log.info('websocket open', { url: ws.url() })

      ws.on('framereceived', ({ payload }) => {
        this.lastFrameAt = new Date()
        const text = typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8')
        this.onFrame(text)
      })

      ws.on('close', () => {
        this.wsOpen = false
        log.warn('websocket closed', { eventsSeen: this.eventsSeen })
        this.setState('DISCONNECTED')
      })

      ws.on('socketerror', (err) => log.warn('websocket error', { error: String(err) }))
    })
  }

  /**
   * One frame.
   *
   * `trending_tokens` and `prices` run at roughly 2000 frames a minute and are
   * dropped here rather than forwarded - but they are not useless: they are the
   * proof that the socket is alive during the hours when nobody we follow is
   * trading. Liveness comes from any frame; events come from this one topic.
   */
  private onFrame(text: string): void {
    if (!text.includes(TRADING_ACTIVITY)) return

    let msg: { type?: string; topicType?: string; payload?: unknown }
    try {
      msg = JSON.parse(text) as typeof msg
    } catch {
      log.warn('unparseable frame', { bytes: text.length })
      return
    }

    // `subscribed` acknowledgements share the topic and carry no payload.
    if (msg.type !== 'data' || msg.topicType !== TRADING_ACTIVITY || !msg.payload) return

    this.lastEventAt = new Date()
    this.eventsSeen++
    this.forwarder.enqueue(msg.payload)
  }

  private async navigate(): Promise<void> {
    if (!this.page) return
    try {
      await this.page.goto(config.appUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await this.checkAuth()
    } catch (err) {
      log.warn('navigation failed', { error: String(err) })
      this.setState('DISCONNECTED')
    }
  }

  /**
   * Is there still a session?
   *
   * Reads localStorage KEY NAMES only. The values are the Privy token and its
   * refresh token; the sidecar has no reason to read them and every reason not
   * to put them anywhere they might be logged.
   */
  private async checkAuth(): Promise<void> {
    if (!this.page) return
    const keys = await this.page
      .evaluate(() => {
        const names: string[] = []
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i)
            if (k) names.push(k)
          }
        } catch {
          /* storage can be unavailable mid-navigation */
        }
        return names
      })
      .catch(() => [] as string[])

    const hasSession = keys.some((k) => k.startsWith('privy:token') || k === 'privy:refresh_token')
    if (!hasSession) {
      log.error('no fomo session in the browser profile - a human must log in again')
      this.setState('AUTH_REQUIRED')
    }
  }

  /** Reload with backoff. Cheaper than relaunching and fixes most socket drops. */
  private async reload(reason: string): Promise<void> {
    if (this.stopping) return
    const wait = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, config.reconnectMaxMs)
    log.info('reloading', { reason, waitMs: wait })
    await new Promise((r) => setTimeout(r, wait))
    if (this.stopping) return
    await this.navigate()
  }

  /**
   * Runs on a timer and decides whether the page needs a kick.
   *
   * The idle check is on `lastFrameAt`, not on events: the followed traders not
   * trading for an hour is an ordinary quiet market, while the firehose falling
   * silent means the socket has died without telling us.
   */
  private async supervise(): Promise<void> {
    if (this.stopping) return

    if (this.state === 'AUTH_REQUIRED') {
      // Reloading cannot fix an expired session, and hammering the page would
      // just look like a bot. Re-check occasionally in case someone logged in.
      await this.checkAuth()
      return
    }

    const quietMin = this.lastFrameAt ? (Date.now() - this.lastFrameAt.getTime()) / 60_000 : Infinity

    if (!this.wsOpen) {
      await this.reload('socket closed')
      return
    }

    if (quietMin > config.idleReloadMin) {
      log.warn('socket open but silent', { quietMin: Math.round(quietMin) })
      await this.reload('no frames')
    }
  }

  private setState(next: State): void {
    if (next === this.state) return
    log.info('state', { from: this.state, to: next })
    this.state = next
  }

  private async sendHeartbeat(): Promise<void> {
    await this.forwarder.heartbeat(this.state, {
      wsOpen: this.wsOpen,
      eventsSeen: this.eventsSeen,
      lastFrameAt: this.lastFrameAt?.toISOString(),
      lastEventAt: this.lastEventAt?.toISOString(),
      pendingForward: this.forwarder.pending,
    })
  }

  private async shutdown(signal: string): Promise<void> {
    this.stopping = true
    log.info('shutting down', { signal, eventsSeen: this.eventsSeen })
    await this.forwarder.flush().catch(() => {})
    await this.ctx?.close().catch(() => {})
    process.exit(0)
  }
}

await new Sidecar().start()
