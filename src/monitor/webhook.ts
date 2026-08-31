import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { log } from '../logger.js'
import type { VolumeMonitorWorker } from './worker.js'

/**
 * The Helius delivery endpoint.
 *
 * Mounted on the dashboard's Fastify instance rather than on a server of its
 * own: the bot already has exactly one public HTTPS origin (the Cloudflare
 * tunnel), and a second listener would need a second tunnel to be reachable at
 * all. The consequence is worth stating plainly - **Solana whale alerts need the
 * dashboard running**, because that is what is listening. Spike and momentum
 * alerts are unaffected; they poll.
 *
 * The route refuses to mount without `HELIUS_WEBHOOK_SECRET`. An unauthenticated
 * endpoint here is not a small problem: anyone who found the URL could post a
 * fabricated $2M whale buy into a trading channel.
 */
export function registerWebhookRoutes(app: FastifyInstance, monitor: VolumeMonitorWorker): void {
  const secret = config.HELIUS_WEBHOOK_SECRET
  if (!secret) {
    log.monitor.info('helius webhook route not mounted - HELIUS_WEBHOOK_SECRET is not set')
    return
  }

  app.post('/webhooks/helius', async (request, reply) => {
    // Helius sends the configured value verbatim as the Authorization header.
    if (request.headers.authorization !== secret) {
      log.monitor.warn({ ip: request.ip }, 'rejected helius webhook with bad auth')
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const queued = monitor.ingestHeliusPayload(request.body)

    // Always 200 on a well-formed authenticated call, even when nothing was
    // usable. Helius retries non-2xx, and retrying a payload we understood but
    // did not want is just the same payload again.
    return reply.code(200).send({ ok: true, queued })
  })

  log.monitor.info('helius webhook mounted at /webhooks/helius')
}
