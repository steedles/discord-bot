import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { config } from '../../config.js'
import { log } from '../../logger.js'
import { requireSession } from '../../web/auth.js'
import type { FomoWatchWorker } from '../../workers/fomo-watch.js'
import { listAlerts, listTrades, recordTrade, tradeSummary } from './alert-store.js'
import { fomoStream, type FomoStreamEvent } from './stream.js'

/**
 * Ingest endpoints for the `fomo-sidecar` container, and the read side the
 * dashboard's Fomo page runs on.
 *
 * Mounted on the dashboard's listener for the same reason the Helius webhook
 * is: the bot has one origin. The two halves authenticate differently and
 * deliberately so - the sidecar and any trade reporter carry a shared secret
 * because they have no session, and everything a human reads requires one.
 *
 * Refuses to mount the write half without a secret. An open endpoint here would
 * let anyone post fabricated trades into a channel people act on, which is the
 * same reasoning that guards the Helius route.
 */

/**
 * A trade report from whatever ends up executing on these alerts.
 *
 * Validated rather than trusted even though the caller holds the secret: this
 * writes the only record of money we will have, and a malformed number in it is
 * a wrong total on the dashboard forever. `tradeRef` makes a retry idempotent.
 */
const TradeReport = z.object({
  tradeRef: z.string().min(1).max(200),
  eventId: z.string().min(1).max(200),
  source: z.string().min(1).max(60),
  side: z.enum(['BUY', 'SELL']),
  mode: z.enum(['dry_run', 'paper', 'live']),
  status: z.enum(['intent', 'open', 'closed', 'failed']),
  chainId: z.string().max(40).optional(),
  tokenAddress: z.string().max(120).optional(),
  ticker: z.string().max(40).optional(),
  usdAmount: z.number().finite().optional(),
  price: z.number().finite().optional(),
  quantity: z.number().finite().optional(),
  pnlUsd: z.number().finite().optional(),
  pnlPct: z.number().finite().optional(),
  txHash: z.string().max(200).optional(),
  note: z.string().max(500).optional(),
})

const AlertQuery = z.object({
  kind: z.enum(['BUY', 'SELL', 'THESIS', 'UNKNOWN']).optional(),
  trader: z.string().max(80).optional(),
  ticker: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

const TradeQuery = z.object({
  eventId: z.string().max(200).optional(),
  status: z.enum(['intent', 'open', 'closed', 'failed']).optional(),
  mode: z.enum(['dry_run', 'paper', 'live']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

/** How often to write an SSE comment so idle connections are not reaped. */
const KEEPALIVE_MS = 25_000

export function registerFomoRoutes(app: FastifyInstance, worker: FomoWatchWorker): void {
  if (!config.FOMO_ENABLED) {
    log.fomo.info('fomo ingest not mounted - FOMO_ENABLED is false')
    return
  }

  const secret = config.FOMO_INGEST_SECRET
  if (!secret) {
    log.fomo.warn('fomo ingest NOT mounted - FOMO_INGEST_SECRET is not set')
    return
  }

  const authed = (header: string | undefined): boolean =>
    header === `Bearer ${secret}` || header === secret

  // --- write half: the sidecar and any trade reporter ----------------------

  app.post<{ Body: { events?: { payload?: unknown }[] } }>('/api/fomo/events', async (request, reply) => {
    if (!authed(request.headers.authorization)) {
      log.fomo.warn({ ip: request.ip }, 'rejected fomo ingest with bad auth')
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const events = Array.isArray(request.body?.events) ? request.body.events : []
    if (events.length === 0) return reply.code(200).send({ ok: true, accepted: 0 })

    const counts = await worker.ingest(events.map((e) => e.payload))

    // Always 200 on a well-formed authenticated call, even when every event was
    // a duplicate or too old. The sidecar retries non-2xx, and retrying a batch
    // we understood and deliberately dropped would just deliver it again -
    // worse, it would block the ordered queue behind it.
    return reply.code(200).send({ ok: true, ...counts })
  })

  app.post<{ Body: { state?: string; wsOpen?: boolean } }>('/api/fomo/heartbeat', async (request, reply) => {
    if (!authed(request.headers.authorization)) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
    worker.noteHeartbeat(String(request.body?.state ?? 'UNKNOWN'), request.body?.wsOpen === true)
    return reply.code(200).send({ ok: true })
  })

  /**
   * Report a trade taken on an alert.
   *
   * Nothing calls this yet - T6 has no executor and this bot does not trade -
   * so it exists to be called rather than because something is calling it. The
   * shape is the contract whatever executes first will write against.
   */
  app.post('/api/fomo/trades', async (request, reply) => {
    if (!authed(request.headers.authorization)) {
      log.fomo.warn({ ip: request.ip }, 'rejected fomo trade report with bad auth')
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const parsed = TradeReport.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid trade report', detail: parsed.error.issues })
    }

    const trade = await recordTrade(parsed.data)
    if (!trade) return reply.code(500).send({ error: 'Could not record the trade' })

    log.fomo.info(
      { tradeRef: trade.tradeRef, status: trade.status, mode: trade.mode },
      'fomo trade reported',
    )
    return reply.code(200).send({ ok: true, trade })
  })

  // --- read half: the dashboard, session-authenticated ---------------------

  /** Health for `/monitor status` and for anyone asking why it is quiet. */
  app.get('/api/fomo/health', async (_request, reply) => reply.send(worker.health.snapshot()))

  app.get('/api/fomo/alerts', async (request, reply) => {
    if (!(await requireSession(request, reply))) return

    const parsed = AlertQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid query' })

    const alerts = await listAlerts({
      kind: parsed.data.kind,
      traderHandle: parsed.data.trader,
      ticker: parsed.data.ticker,
      limit: parsed.data.limit,
    })
    return reply.send({ alerts })
  })

  app.get('/api/fomo/trades', async (request, reply) => {
    if (!(await requireSession(request, reply))) return

    const parsed = TradeQuery.safeParse(request.query)
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid query' })

    const [trades, summary] = await Promise.all([listTrades(parsed.data), tradeSummary()])
    return reply.send({ trades, summary })
  })

  /**
   * The live half of the page, as Server-Sent Events.
   *
   * SSE rather than a websocket because the traffic is one-directional and
   * rare - a handful of events an hour - and EventSource reconnects on its own,
   * which a raw websocket does not. The page backfills over `/api/fomo/alerts`
   * on every (re)connect, so a missed event during a drop is not a hole.
   */
  app.get('/api/fomo/stream', async (request, reply) => {
    if (!(await requireSession(request, reply))) return

    // From here the response is ours: Fastify must not try to serialise or end it.
    reply.hijack()

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Without this a proxy that buffers - nginx, and the Cloudflare tunnel
      // this bot sits behind - holds the whole stream until it closes, which
      // looks exactly like a feed that never delivers anything.
      'X-Accel-Buffering': 'no',
    })

    const write = (event: FomoStreamEvent): void => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
    }

    const unsubscribe = fomoStream.subscribe(write)
    if (!unsubscribe) {
      reply.raw.write('event: overloaded\ndata: {"error":"too many subscribers"}\n\n')
      reply.raw.end()
      return
    }

    // Tell the page it is attached, so "connecting" can become "live" without
    // waiting for the first real event - which may be an hour away.
    reply.raw.write('event: ready\ndata: {"ok":true}\n\n')

    const keepalive = setInterval(() => {
      // A comment line. Costs nothing, and stops an idle connection being
      // reaped by a proxy that has decided it is dead.
      reply.raw.write(': keepalive\n\n')
    }, KEEPALIVE_MS)

    const close = (): void => {
      clearInterval(keepalive)
      unsubscribe()
    }
    request.raw.on('close', close)
    request.raw.on('error', close)
  })

  log.fomo.info('fomo ingest mounted at /api/fomo/events, dashboard feed at /api/fomo/stream')
}
