import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import type { Client } from 'discord.js'
import Fastify, { type FastifyInstance } from 'fastify'
import { config, dashboardReadiness } from '../config.js'
import { log } from '../logger.js'
import { registerWebhookRoutes } from '../monitor/webhook.js'
import type { VolumeMonitorWorker } from '../monitor/worker.js'
import type { FomoWatchWorker } from '../workers/fomo-watch.js'
import { setSessionCookie } from './auth.js'
import { registerRoutes } from './routes.js'
import { registerFomoRoutes } from '../integrations/fomo/routes.js'
import { registerOpsRoutes } from '../ops/routes.js'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * The dashboard's static files live beside the compiled server in `dist/web`,
 * and beside the source in `src/web` when running under tsx. Resolving relative
 * to this module covers both without a build step to copy them.
 */
function publicDir(): string {
  return join(here, 'public')
}

export interface DashboardOptions {
  /**
   * The volume monitor, so its Helius webhook can be mounted here.
   *
   * The bot has one public origin, so the webhook shares the dashboard's
   * listener. It is authenticated by its own shared secret rather than by a
   * dashboard session - Helius has no session - and mounting it does not
   * weaken the dashboard's own auth in any way.
   */
  volumeMonitor?: VolumeMonitorWorker
  /**
   * Mounts the Fomo sidecar's ingest endpoints, on the same reasoning as the
   * Helius webhook above: the bot has one origin, and the sidecar has no
   * dashboard session to authenticate with.
   */
  fomoWatch?: FomoWatchWorker
  /**
   * Development only. Registers a `/dev-login` route that hands out the given
   * pre-created session, so the dashboard can be viewed without a Discord app.
   *
   * This is not an auth bypass: the session must already exist in the database
   * and the cookie is signed the same way a real login signs it. The route is
   * refused outright when NODE_ENV is production, and the normal
   * `new DashboardServer(client)` path can never enable it.
   */
  devLoginSessionId?: string
}

export class DashboardServer {
  private app?: FastifyInstance

  constructor(
    private readonly client: Client,
    private readonly options: DashboardOptions = {},
  ) {}

  /** Returns false when the dashboard is disabled or not configured. */
  async start(): Promise<boolean> {
    if (!config.DASHBOARD_ENABLED) {
      log.bot.info('dashboard disabled by config')
      return false
    }

    const { ready, missing } = dashboardReadiness()
    if (!ready) {
      // Fail closed. An open config panel is worse than none at all.
      log.bot.warn(
        { missing },
        'dashboard NOT started - missing required settings. Set them to enable it.',
      )
      return false
    }

    const app = Fastify({ logger: false, trustProxy: true })
    this.app = app

    await app.register(cookie, { secret: config.SESSION_SECRET })
    await app.register(fastifyStatic, { root: publicDir(), prefix: '/' })

    // Fastify rejects an empty body when the content type says JSON. DELETE
    // requests legitimately have none, so treat empty as {} instead of 400.
    app.addContentTypeParser(
      'application/json',
      { parseAs: 'string' },
      (_request, body, done) => {
        const text = typeof body === 'string' ? body.trim() : ''
        if (text === '') return done(null, {})
        try {
          done(null, JSON.parse(text) as unknown)
        } catch {
          done(new Error('Invalid JSON body'), undefined)
        }
      },
    )

    registerRoutes(app, this.client)
    // The Setup tab and the homelab runner's job queue. Same listener, same
    // reasoning as the two below: one origin, and the runner has no session.
    registerOpsRoutes(app, this.client)

    if (this.options.volumeMonitor) {
      registerWebhookRoutes(app, this.options.volumeMonitor)
    }

    if (this.options.fomoWatch) {
      registerFomoRoutes(app, this.options.fomoWatch, this.client)
    }

    const devSession = this.options.devLoginSessionId
    if (devSession) {
      if (config.NODE_ENV === 'production') {
        throw new Error('devLoginSessionId must never be used in production')
      }
      app.get('/dev-login', async (_request, reply) => {
        setSessionCookie(reply, devSession)
        return reply.redirect('/')
      })
      log.bot.warn('DEV LOGIN ENABLED at /dev-login - preview mode only')
    }

    app.setErrorHandler((err, _request, reply) => {
      log.bot.error({ err }, 'dashboard request failed')
      void reply.code(500).send({ error: 'Internal error' })
    })

    // Unknown non-API paths fall through to the SPA shell. Machine-facing
    // prefixes must not: a webhook that answers 200 with a page of HTML tells
    // its sender the delivery worked, so a missing secret would look like a
    // working integration that silently discards everything.
    app.setNotFoundHandler((request, reply) => {
      if (
        request.url.startsWith('/api/') ||
        request.url.startsWith('/auth/') ||
        request.url.startsWith('/webhooks/')
      ) {
        void reply.code(404).send({ error: 'Not found' })
        return
      }
      void reply.sendFile('index.html')
    })

    await app.listen({ port: config.DASHBOARD_PORT, host: config.DASHBOARD_HOST })

    log.bot.info(
      { port: config.DASHBOARD_PORT, url: config.DASHBOARD_URL },
      'dashboard listening',
    )
    log.bot.info(
      `OAuth redirect must be registered in the Discord app: ${config.DASHBOARD_URL}/auth/callback`,
    )

    return true
  }

  async stop(): Promise<void> {
    await this.app?.close()
    this.app = undefined
  }
}
