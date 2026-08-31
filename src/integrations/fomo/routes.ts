import type { FastifyInstance } from 'fastify'
import { config } from '../../config.js'
import { log } from '../../logger.js'
import type { FomoWatchWorker } from '../../workers/fomo-watch.js'

/**
 * Ingest endpoints for the `fomo-sidecar` container.
 *
 * Mounted on the dashboard's listener for the same reason the Helius webhook
 * is: the bot has one origin. Authenticated by its own shared secret rather
 * than by a dashboard session - the sidecar has no session - and mounting it
 * weakens the dashboard's own auth in no way.
 *
 * Refuses to mount without a secret. An open endpoint here would let anyone
 * post fabricated trades into a channel people act on, which is the same
 * reasoning that guards the Helius route.
 */
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

  /** Health for `/monitor status` and for anyone asking why it is quiet. */
  app.get('/api/fomo/health', async (_request, reply) => reply.send(worker.health.snapshot()))

  log.fomo.info('fomo ingest mounted at /api/fomo/events')
}
