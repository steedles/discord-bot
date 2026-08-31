import { beforeEach, describe, expect, it, vi } from 'vitest'

const sent: { chatId: string; text: string }[] = []

vi.mock('../../telegram-alerts.js', () => ({
  sendTelegramMessage: vi.fn(async (chatId: string, text: string) => {
    sent.push({ chatId, text })
  }),
}))

vi.mock('../../../config.js', () => ({
  config: {
    FOMO_ENABLED: true,
    FOMO_STALE_MIN: 60,
    FOMO_ALERT_TELEGRAM_CHAT: '@SteedlesCrypto',
    TELEGRAM_CHAT_ID: '12345',
    TELEGRAM_BOT_TOKEN: 'token',
  },
}))

vi.mock('../../../logger.js', () => ({
  log: { fomo: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
}))

const { FomoHealth } = await import('../health.js')

const T0 = new Date('2026-08-31T12:00:00.000Z')
const plus = (min: number) => new Date(T0.getTime() + min * 60_000)

describe('FomoHealth alarm', () => {
  beforeEach(() => {
    sent.length = 0
  })

  /**
   * A dropped socket that reconnects is routine. Waking someone for it would
   * train them to ignore the alarm, which is the only failure mode worse than
   * not having one.
   */
  it('stays quiet for a brief disconnect inside the grace window', async () => {
    const h = new FomoHealth()
    h.set('CONNECTED', undefined, T0)
    h.set('DISCONNECTED', 'socket closed', T0)
    await h.check(plus(5))
    expect(sent).toHaveLength(0)
  })

  it('alarms once reconnecting has clearly not worked', async () => {
    const h = new FomoHealth()
    h.set('CONNECTED', undefined, T0)
    h.noteEvent(T0)
    h.set('DISCONNECTED', 'socket closed', T0)
    await h.check(plus(20))

    expect(sent).toHaveLength(1)
    expect(sent[0].chatId).toBe('@SteedlesCrypto')
    expect(sent[0].text).toContain('Fomo feed is down')
    expect(sent[0].text).toContain('DISCONNECTED')
  })

  it('does not repeat the same unresolved alarm every check', async () => {
    const h = new FomoHealth()
    h.set('DISCONNECTED', 'socket closed', T0)
    await h.check(plus(20))
    await h.check(plus(25))
    await h.check(plus(60))
    expect(sent).toHaveLength(1)
  })

  it('repeats only after the repeat window has passed', async () => {
    const h = new FomoHealth()
    h.set('DISCONNECTED', 'socket closed', T0)
    await h.check(plus(20))
    await h.check(plus(20 + 6 * 60 + 1))
    expect(sent).toHaveLength(2)
  })

  it('says explicitly when the session needs a human, because that is a different fix', async () => {
    const h = new FomoHealth()
    h.set('AUTH_REQUIRED', 'privy session expired', T0)
    await h.check(plus(20))
    expect(sent[0].text).toContain('manual login')
  })

  it('reports recovery, so an open alarm gets closed', async () => {
    const h = new FomoHealth()
    h.set('DISCONNECTED', undefined, T0)
    await h.check(plus(20))
    h.set('CONNECTED', undefined, plus(21))
    await Promise.resolve()
    expect(sent).toHaveLength(2)
    expect(sent[1].text).toContain('recovered')
  })

  it('does not announce a recovery nobody was told about', async () => {
    const h = new FomoHealth()
    h.set('DISCONNECTED', undefined, T0)
    h.set('CONNECTED', undefined, plus(1))
    await Promise.resolve()
    expect(sent).toHaveLength(0)
  })

  /**
   * The failure this module exists for: the sidecar dies, or its socket closes,
   * and from the bot's side that looks exactly like a quiet market.
   */
  it('treats a dead sidecar as broken', async () => {
    const h = new FomoHealth()
    h.set('CONNECTED', undefined, T0)
    h.noteHeartbeat(true, T0)
    await h.check(plus(61))
    expect(h.snapshot().state).toBe('DEGRADED')

    await h.check(plus(61 + 20))
    expect(sent).toHaveLength(1)
    expect(sent[0].text).toContain('no heartbeat')
  })

  it('treats a live sidecar with a closed socket as broken', async () => {
    const h = new FomoHealth()
    h.set('CONNECTED', undefined, T0)
    h.noteHeartbeat(false, T0)
    await h.check(plus(1))
    expect(h.snapshot().state).toBe('DEGRADED')
  })

  /**
   * The false alarm this design exists to avoid.
   *
   * Health was originally judged on trade events, which meant four quiet hours
   * fired the alarm. Followed traders not trading is an ordinary market, and an
   * alarm that cries wolf is one nobody reads. Liveness is the sidecar checking
   * in - it always has `trending_tokens` traffic to report.
   */
  it('stays healthy through a quiet market while the sidecar reports in', async () => {
    const h = new FomoHealth()
    h.set('CONNECTED', undefined, T0)
    h.noteEvent(T0)
    for (let m = 10; m <= 240; m += 10) h.noteHeartbeat(true, plus(m))
    await h.check(plus(245))
    expect(h.snapshot().state).toBe('CONNECTED')
    expect(sent).toHaveLength(0)
  })

  it('counts events so the alarm can say how much it had seen', async () => {
    const h = new FomoHealth()
    h.noteEvent(T0)
    h.noteEvent(plus(1))
    expect(h.snapshot().eventsSeen).toBe(2)
  })
})
