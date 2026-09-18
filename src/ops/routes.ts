import { timingSafeEqual } from 'node:crypto'
import { ChannelType, type Client } from 'discord.js'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { listInstances, upsertInstance } from '../db/features.js'
import type { OpsJobStep } from '../db/models.js'
import {
  countGuildCommands,
  registerGuildCommands,
  shippedCommandCount,
} from '../discord/register-commands.js'
import { getFeature } from '../features/registry.js'
import { log } from '../logger.js'
import { requireGuildAccess } from '../web/auth.js'
import { ENV_KEYS, validateEnvValues, type EnvKey } from './env-keys.js'
import {
  claimNextJob,
  completeJob,
  enqueueJob,
  failOrphanedJobs,
  getJob,
  listRecentJobs,
  runnerStatus,
} from './jobs.js'

/**
 * The Setup tab's API, and the runner's.
 *
 * Two halves that authenticate differently, the same split the Fomo routes
 * make: everything a person does needs a dashboard session with Manage Server
 * on the guild in question, and the two runner endpoints take the shared
 * secret because a systemd service has no session.
 *
 * The runner half refuses to mount without `OPS_RUNNER_SECRET`. The dashboard
 * half always mounts, so the Setup tab can still register commands and switch
 * the trial features on - the parts that need no host access - and can say
 * plainly that the parts which do are not available, rather than queueing jobs
 * nothing will ever run.
 */

/** The guide's step 04: the three features that only answer when asked. */
const TRIAL_FEATURES = ['market-lookup', 'price-alerts', 'coin-tracker'] as const

/** What "Restart bots" restarts. The runner enforces the same list. */
const RESTARTABLE = ['bot', 'fomo-sidecar'] as const

const SetupBody = z.object({
  channelId: z.string().regex(/^\d{15,22}$/).optional(),
  roleId: z.string().regex(/^\d{15,22}$/).optional(),
  env: z.record(z.string(), z.unknown()).optional(),
})

const RestartBody = z.object({
  services: z.array(z.enum(RESTARTABLE)).min(1).optional(),
})

const ResultBody = z.object({
  ok: z.boolean(),
  summary: z.string().max(1_000),
  steps: z
    .array(
      z.object({
        name: z.string().max(120),
        ok: z.boolean(),
        detail: z.string().max(2_000).optional(),
      }),
    )
    .max(50),
})

export function registerOpsRoutes(app: FastifyInstance, client: Client): void {
  const botGuildIds = (): Set<string> => new Set(client.guilds.cache.map((g) => g.id))
  const runnerConfigured = Boolean(config.OPS_RUNNER_SECRET)

  void failOrphanedJobs().catch((err) => log.ops.warn({ err }, 'could not sweep orphaned jobs'))

  // --- dashboard half -------------------------------------------------------

  app.get<{ Params: { guildId: string } }>('/api/guilds/:guildId/setup', async (request, reply) => {
    const session = await requireGuildAccess(request, reply, request.params.guildId, botGuildIds())
    if (!session) return

    const guild = client.guilds.cache.get(request.params.guildId)
    if (!guild) return reply.code(404).send({ error: 'Bot is not in that server' })

    const [registered, rows, jobs] = await Promise.all([
      countGuildCommands(client, guild.id),
      listInstances(guild.id),
      listRecentJobs(10),
    ])

    const trialRows = rows
      .filter((r) => (TRIAL_FEATURES as readonly string[]).includes(r.featureId) && r.channelId)
      .map((r) => ({
        featureId: r.featureId,
        name: getFeature(r.featureId)?.name ?? r.featureId,
        channelId: r.channelId,
        channelName: guild.channels.cache.get(r.channelId!)?.name ?? null,
        enabled: r.enabled,
      }))

    // Presence only. The values are in this process's config and stay there.
    const env = Object.fromEntries(ENV_KEYS.map((s) => [s.key, Boolean(config[s.key])])) as Record<
      EnvKey,
      boolean
    >

    return reply.send({
      guild: {
        id: guild.id,
        name: guild.name,
        memberCount: guild.memberCount,
        joinedAt: guild.joinedAt,
      },
      commands: { registered: registered ?? null, shipped: shippedCommandCount() },
      trialFeatures: TRIAL_FEATURES.map((id) => ({ id, name: getFeature(id)?.name ?? id })),
      trialRows,
      envKeys: ENV_KEYS.map(({ key, label, group, placeholder }) => ({ key, label, group, placeholder })),
      env,
      runner: runnerConfigured ? runnerStatus() : { configured: false, online: false, lastSeenAt: null },
      restartable: RESTARTABLE,
      jobs,
    })
  })

  /**
   * "Connect this server". Each step reports on its own, and a failed step does
   * not stop the next - registering commands can fail on a bad invite while the
   * feature rows are still worth writing, and vice versa.
   */
  app.post<{ Params: { guildId: string }; Body: unknown }>(
    '/api/guilds/:guildId/setup',
    async (request, reply) => {
      const session = await requireGuildAccess(request, reply, request.params.guildId, botGuildIds())
      if (!session) return

      const guild = client.guilds.cache.get(request.params.guildId)
      if (!guild) return reply.code(404).send({ error: 'Bot is not in that server' })

      const parsed = SetupBody.safeParse(request.body ?? {})
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid request', errors: parsed.error.issues.map((i) => i.message) })
      const body = parsed.data

      // Everything that will be refused is refused before anything is written.
      let envValues: Partial<Record<EnvKey, string>> | undefined
      if (body.env && Object.keys(body.env).length > 0) {
        const validation = validateEnvValues(body.env)
        if (!validation.ok) return reply.code(400).send({ error: 'Check the streaming keys', errors: validation.errors })
        if (Object.keys(validation.values).length > 0) envValues = validation.values
      }

      const channel = body.channelId ? guild.channels.cache.get(body.channelId) : undefined
      if (body.channelId && (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement))) {
        return reply.code(400).send({ error: 'That channel is not a text channel in this server.' })
      }
      if (channel && !(channel.isTextBased() && channel.isSendable())) {
        return reply.code(400).send({ error: `The bot cannot post in #${channel.name}. Give it View Channel and Send Messages there first.` })
      }
      if (body.roleId && !channel) {
        return reply.code(400).send({ error: 'A ping role needs a trial channel to apply to.' })
      }
      if (body.roleId && !guild.roles.cache.has(body.roleId)) {
        return reply.code(400).send({ error: 'That role is not in this server.' })
      }
      if (envValues && !runnerConfigured) {
        return reply.code(400).send({
          error: 'Streaming keys need the homelab runner, which is not configured (OPS_RUNNER_SECRET). Send the keys to Wayne instead.',
        })
      }

      const steps: OpsJobStep[] = []
      const updatedBy = session.userId

      // 1. Slash commands, always - it is idempotent and it is the step the
      //    guide promises "same day".
      const registration = await registerGuildCommands(guild.id)
      steps.push({ name: 'Slash commands', ok: registration.ok, detail: registration.detail })

      // 2. The trial channel's three features, and the ping role where a
      //    feature has somewhere to put it.
      if (channel) {
        const roleFor = (featureId: string): Record<string, unknown> => {
          if (!body.roleId) return {}
          const feature = getFeature(featureId)
          return feature?.settings.some((s) => s.key === 'mentionRoles') ? { mentionRoles: [body.roleId] } : {}
        }

        for (const featureId of TRIAL_FEATURES) {
          const result = await upsertInstance({
            guildId: guild.id,
            featureId,
            channelId: channel.id,
            enabled: true,
            settings: roleFor(featureId),
            updatedBy,
          })
          steps.push({
            name: `${getFeature(featureId)?.name ?? featureId} in #${channel.name}`,
            ok: result.ok,
            detail: result.ok ? 'on' : result.errors.join(' '),
          })
        }

        // Any push feature already on in that channel gets the role too - the
        // guide's step 05 is "when you turn on an alert feature", and one that
        // is already on is the case that would otherwise be missed.
        if (body.roleId) {
          const rows = (await listInstances(guild.id)).filter(
            (r) => r.channelId === channel.id && r.enabled && !(TRIAL_FEATURES as readonly string[]).includes(r.featureId),
          )
          for (const row of rows) {
            const settings = roleFor(row.featureId)
            if (Object.keys(settings).length === 0) continue
            const result = await upsertInstance({ guildId: guild.id, featureId: row.featureId, channelId: channel.id, settings, updatedBy })
            steps.push({
              name: `Ping role on ${getFeature(row.featureId)?.name ?? row.featureId}`,
              ok: result.ok,
              detail: result.ok ? 'set' : result.errors.join(' '),
            })
          }
        }
      }

      // 3. Keys go to the runner. Queued, not done - the response carries the
      //    job id and the page polls it, through the restart it causes.
      let jobId: string | undefined
      if (envValues) {
        const job = await enqueueJob({
          type: 'apply-env',
          env: envValues,
          requestedBy: session.userId,
          requestedByName: session.username,
          guildId: guild.id,
        })
        jobId = job.jobId
        steps.push({
          name: 'Streaming keys',
          ok: true,
          detail: `Queued for the homelab: ${Object.keys(envValues).join(', ')}. The bot restarts to pick them up.`,
        })
      }

      log.ops.info(
        { guildId: guild.id, by: session.userId, channelId: channel?.id, roleId: body.roleId, envKeys: envValues ? Object.keys(envValues) : [], jobId },
        'server setup run',
      )

      return reply.send({ ok: steps.every((s) => s.ok), steps, ...(jobId ? { jobId } : {}) })
    },
  )

  app.post<{ Params: { guildId: string }; Body: unknown }>(
    '/api/guilds/:guildId/ops/restart',
    async (request, reply) => {
      const session = await requireGuildAccess(request, reply, request.params.guildId, botGuildIds())
      if (!session) return

      if (!runnerConfigured) {
        return reply.code(400).send({ error: 'The homelab runner is not configured (OPS_RUNNER_SECRET), so nothing here can restart containers.' })
      }

      const parsed = RestartBody.safeParse(request.body ?? {})
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' })

      const services = parsed.data.services ?? [...RESTARTABLE]
      const job = await enqueueJob({
        type: 'restart',
        services,
        requestedBy: session.userId,
        requestedByName: session.username,
        guildId: request.params.guildId,
      })
      return reply.send({ jobId: job.jobId })
    },
  )

  app.get<{ Params: { guildId: string; jobId: string } }>(
    '/api/guilds/:guildId/ops/jobs/:jobId',
    async (request, reply) => {
      const session = await requireGuildAccess(request, reply, request.params.guildId, botGuildIds())
      if (!session) return

      if (!/^[a-f0-9]{24}$/.test(request.params.jobId)) return reply.code(404).send({ error: 'No such job' })
      const job = await getJob(request.params.jobId)
      if (!job) return reply.code(404).send({ error: 'No such job' })
      return reply.send({ job, runner: runnerConfigured ? runnerStatus() : { configured: false, online: false, lastSeenAt: null } })
    },
  )

  // --- runner half ------------------------------------------------------------

  if (!runnerConfigured) {
    log.ops.info('ops runner endpoints not mounted - OPS_RUNNER_SECRET is not set')
    return
  }
  const secret = config.OPS_RUNNER_SECRET!

  const authed = (request: FastifyRequest): boolean => {
    const header = request.headers.authorization
    if (typeof header !== 'string') return false
    const presented = header.startsWith('Bearer ') ? header.slice(7) : header
    const a = Buffer.from(presented)
    const b = Buffer.from(secret)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  app.get('/api/ops/runner/next', async (request, reply) => {
    if (!authed(request)) return reply.code(401).send({ error: 'Unauthorized' })
    const job = await claimNextJob()
    return reply.send({ job: job ?? null })
  })

  app.post<{ Params: { jobId: string }; Body: unknown }>('/api/ops/runner/jobs/:jobId/result', async (request, reply) => {
    if (!authed(request)) return reply.code(401).send({ error: 'Unauthorized' })

    const parsed = ResultBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid result' })

    const accepted = await completeJob(request.params.jobId, parsed.data)
    return reply.send({ ok: accepted })
  })

  log.ops.info('ops runner endpoints mounted')
}
