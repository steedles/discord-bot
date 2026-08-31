import WebSocket from 'ws'
import { config } from '../config.js'
import { log } from '../logger.js'

export interface NewPumpToken {
  mint: string
  name: string
  symbol: string
}

interface PumpPortalMessage {
  txType?: string
  mint?: string
  name?: string
  symbol?: string
  message?: string
}

/**
 * Listens to pump.fun token creations over PumpPortal's free websocket.
 *
 * Every new mint is noise on its own - hundreds per hour, most dead on arrival.
 * The scanner only cares about them later, once one shows up on a DEX with real
 * liquidity, so this class just reports mints and lets the caller decide.
 */
export class PumpPortalWatcher {
  private ws?: WebSocket
  private reconnectTimer?: NodeJS.Timeout
  private heartbeat?: NodeJS.Timeout
  private attempts = 0
  private stopped = false

  constructor(private readonly onToken: (token: NewPumpToken) => void) {}

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.ws?.close()
    this.ws = undefined
  }

  private connect(): void {
    if (this.stopped) return

    log.scanner.debug({ url: config.PUMPPORTAL_WS }, 'connecting to pumpportal')
    const ws = new WebSocket(config.PUMPPORTAL_WS)
    this.ws = ws

    ws.on('open', () => {
      this.attempts = 0
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }))
      log.scanner.info('pumpportal connected, subscribed to new tokens')

      if (this.heartbeat) clearInterval(this.heartbeat)
      this.heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping()
      }, 30_000)
    })

    ws.on('message', (raw) => {
      let payload: PumpPortalMessage
      try {
        payload = JSON.parse(raw.toString()) as PumpPortalMessage
      } catch {
        return
      }

      if (payload.message) {
        log.scanner.debug({ message: payload.message }, 'pumpportal notice')
        return
      }
      if (payload.txType !== 'create' || !payload.mint) return

      this.onToken({
        mint: payload.mint,
        name: payload.name ?? 'Unknown',
        symbol: payload.symbol ?? '???',
      })
    })

    ws.on('error', (err) => log.scanner.warn({ err: String(err) }, 'pumpportal socket error'))

    ws.on('close', () => {
      if (this.heartbeat) clearInterval(this.heartbeat)
      if (this.stopped) return

      this.attempts += 1
      const delay = Math.min(60_000, 1_000 * 2 ** Math.min(this.attempts, 6))
      log.scanner.warn({ attempt: this.attempts, delayMs: delay }, 'pumpportal disconnected, reconnecting')
      this.reconnectTimer = setTimeout(() => this.connect(), delay)
    })
  }
}
