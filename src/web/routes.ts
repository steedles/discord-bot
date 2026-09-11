import { ChannelType, type Client } from 'discord.js'
import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import {
  deleteInstance,
  listInstances,
  setInstanceEnabled,
  upsertInstance,
} from '../db/features.js'
import type { CustomBoardSlot } from '../db/models.js'
import { getCollections } from '../db/mongo.js'
import {
  DIP_HUNTER,
  FEATURES,
  LEVEL_BREAK,
  TRENDING,
  VOLUME_SPIKES,
  WHALE_BUYS,
  getFeature,
} from '../features/registry.js'
import { defaultSettings } from '../features/types.js'
import { log } from '../logger.js'
import { evmTokenHoldings } from '../market/blockscout.js'
import { CHAINS } from '../market/chains.js'
import { geckoNetwork } from '../market/geckoterminal.js'
import { fetchJson, mapWithConcurrency } from '../market/http.js'
import { resolveToken, TokenNotFoundError, UnsupportedChainError } from '../market/resolve.js'
import { solanaTokenHoldings } from '../market/solana-rpc.js'
import { listAll, removeToken } from '../monitor/watchlist.js'
import { getHolderProfile } from '../risk/holders.js'
import {
  buildAuthorizeUrl,
  clearSession,
  completeLogin,
  completePasswordLogin,
  getSession,
  newState,
  requireGuildAccess,
  requireSession,
  setSessionCookie,
} from './auth.js'
import { accounts, clearFailures, isLockedOut, recordFailure } from './password.js'

const STATE_COOKIE = 'dboauth'

export function registerRoutes(app: FastifyInstance, client: Client): void {
  /** Guilds the bot is in right now, which is what a local session may touch. */
  const botGuildIds = (): Set<string> => new Set(client.guilds.cache.map((g) => g.id))

  // --- legal ---------------------------------------------------------------
  // Discord asks for these URLs on the app listing, so they get clean paths
  // rather than the .html the static handler would otherwise expose.

  app.get('/privacy', async (_request, reply) => reply.sendFile('privacy.html'))
  app.get('/terms', async (_request, reply) => reply.sendFile('terms.html'))

  // The Fomo feed page, on a clean path for the same reason the legal pages
  // get one. The shell is public and empty: every byte of data on it comes
  // from /api/fomo/*, and each of those requires a session.
  app.get('/fomo', async (_request, reply) => reply.sendFile('fomo.html'))

  // --- auth ---------------------------------------------------------------

  app.get('/auth/login', async (_request, reply) => {
    const state = newState()
    reply.setCookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.DASHBOARD_URL.startsWith('https://'),
      path: '/',
      maxAge: 600,
    })
    return reply.redirect(buildAuthorizeUrl(state))
  })

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/callback',
    async (request, reply) => {
      const { code, state, error } = request.query

      if (error) return reply.redirect(`/?error=${encodeURIComponent(error)}`)
      if (!code) return reply.redirect('/?error=missing_code')

      // CSRF: the state we set must come back unchanged.
      const expected = request.cookies[STATE_COOKIE]
      reply.clearCookie(STATE_COOKIE, { path: '/' })
      if (!expected || expected !== state) return reply.redirect('/?error=bad_state')

      try {
        const sessionId = await completeLogin(code, botGuildIds())
        setSessionCookie(reply, sessionId)
        return reply.redirect('/')
      } catch (err) {
        log.bot.error({ err }, 'dashboard login failed')
        return reply.redirect('/?error=login_failed')
      }
    },
  )

  /**
   * Email + password sign-in for people who do not hold Manage Server on the
   * guild - see `password.ts`. Wrong email and wrong password give the same
   * answer, and repeated failures from one client are locked out for a while,
   * because this form sits on a public URL.
   */
  app.post<{ Body: { email?: string; password?: string } }>(
    '/auth/password',
    async (request, reply) => {
      if (accounts().length === 0) {
        return reply.code(503).send({ error: 'Password sign-in is not configured' })
      }

      const key = request.ip
      if (isLockedOut(key)) {
        return reply.code(429).send({ error: 'Too many attempts. Try again in 15 minutes.' })
      }

      const { email, password } = request.body ?? {}
      if (!email || !password) {
        return reply.code(400).send({ error: 'Email or username, and password, are required' })
      }

      const sessionId = await completePasswordLogin(email, password, botGuildIds())
      if (!sessionId) {
        recordFailure(key)
        log.bot.warn({ ip: key }, 'dashboard password login failed')
        return reply.code(401).send({ error: 'Wrong login or password' })
      }

      clearFailures(key)
      setSessionCookie(reply, sessionId)
      return reply.send({ ok: true })
    },
  )

  app.post('/auth/logout', async (request, reply) => {
    await clearSession(request, reply)
    return { ok: true }
  })

  // --- session + guilds ---------------------------------------------------

  app.get('/api/me', async (request, reply) => {
    const session = await getSession(request)
    if (!session) return reply.send({ authenticated: false })

    const visible = session.local ? [...botGuildIds()] : session.guildIds
    const guilds = visible
      .map((id) => client.guilds.cache.get(id))
      .filter((g) => g !== undefined)
      .map((g) => ({ id: g.id, name: g.name, icon: g.iconURL({ size: 64 }) ?? null }))

    return reply.send({
      authenticated: true,
      user: { id: session.userId, username: session.username, local: session.local ?? false },
      guilds,
    })
  })

  /** The settings schema. The dashboard renders its forms straight from this. */
  app.get('/api/features', async (_request, reply) => reply.send({ features: FEATURES }))

  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/channels',
    async (request, reply) => {
      const session = await requireGuildAccess(request, reply, request.params.guildId, botGuildIds())
      if (!session) return

      const guild = client.guilds.cache.get(request.params.guildId)
      if (!guild) return reply.code(404).send({ error: 'Bot is not in that server' })

      const channels = guild.channels.cache
        .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
        .map((c) => ({
          id: c.id,
          name: c.name,
          // Surfaced so the dashboard can warn before someone picks a channel
          // the bot cannot actually post in.
          sendable: c.isTextBased() && c.isSendable(),
          parent: c.parent?.name ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))

      return reply.send({ channels })
    },
  )

  app.get<{ Params: { guildId: string } }>('/api/guilds/:guildId/roles', async (request, reply) => {
    const session = await requireGuildAccess(request, reply, request.params.guildId, botGuildIds())
    if (!session) return

    const guild = client.guilds.cache.get(request.params.guildId)
    if (!guild) return reply.code(404).send({ error: 'Bot is not in that server' })

    const roles = guild.roles.cache
      .filter((r) => r.id !== guild.id && !r.managed)
      .map((r) => ({
        id: r.id,
        name: r.name,
        colour: r.hexColor === '#000000' ? null : r.hexColor,
        // Surfaced so the picker can warn before someone chooses a role the bot
        // cannot ping. Discord silently drops the mention rather than erroring,
        // which reads as the setting being ignored.
        pingable: r.mentionable || (guild.members.me?.permissions.has('MentionEveryone') ?? false),
        position: r.position,
      }))
      // Highest first, the order Discord shows them in.
      .sort((a, b) => b.position - a.position)

    return reply.send({ roles })
  })

  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/instances',
    async (request, reply) => {
      const session = await requireGuildAccess(request, reply, request.params.guildId, botGuildIds())
      if (!session) return

      const instances = await listInstances(request.params.guildId)
      return reply.send({
        instances: instances.flatMap((i) => {
          /*
           * A row can outlive its feature: Rug Watch is parked rather than
           * deleted, and its stored rows are meant to be ignored while it is
           * unlisted. Assuming the registry still has it turned one dormant row
           * into a 500 for the whole dashboard - so an unknown feature is
           * skipped here exactly as it is skipped everywhere else.
           */
          const feature = getFeature(i.featureId)
          if (!feature) return []

          return [
            {
              id: i._id!.toHexString(),
              featureId: i.featureId,
              channelId: i.channelId,
              enabled: i.enabled,
              label: i.label ?? null,
              // Defaults are merged in so the form never renders a blank field
              // for a setting added after this row was written.
              settings: { ...defaultSettings(feature), ...i.settings },
              updatedAt: i.updatedAt,
            },
          ]
        }),
      })
    },
  )

  // --- mutations ----------------------------------------------------------

  app.put<{
    Params: { guildId: string }
    Body: {
      featureId?: string
      channelId?: string | null
      enabled?: boolean
      settings?: Record<string, unknown>
      label?: string
    }
  }>('/api/guilds/:guildId/instances', async (request, reply) => {
    const { guildId } = request.params
    const session = await requireGuildAccess(request, reply, guildId, botGuildIds())
    if (!session) return

    const { featureId, channelId, enabled, settings, label } = request.body ?? {}
    if (!featureId || !getFeature(featureId)) {
      return reply.code(400).send({ error: 'Unknown or missing featureId' })
    }

    if (channelId) {
      const guild = client.guilds.cache.get(guildId)
      if (!guild?.channels.cache.has(channelId)) {
        return reply.code(400).send({ error: 'That channel is not in this server' })
      }
    }

    const result = await upsertInstance({
      guildId,
      featureId,
      channelId: channelId ?? null,
      ...(enabled !== undefined ? { enabled } : {}),
      ...(settings !== undefined ? { settings } : {}),
      ...(label !== undefined ? { label } : {}),
      updatedBy: session.userId,
    })

    if (!result.ok) return reply.code(400).send({ error: result.errors.join('\n'), errors: result.errors })

    return reply.send({
      ok: true,
      instance: {
        id: result.instance!._id!.toHexString(),
        featureId: result.instance!.featureId,
        channelId: result.instance!.channelId,
        enabled: result.instance!.enabled,
        label: result.instance!.label ?? null,
        settings: result.instance!.settings,
        updatedAt: result.instance!.updatedAt,
      },
    })
  })

  app.patch<{ Params: { guildId: string; instanceId: string }; Body: { enabled?: boolean } }>(
    '/api/guilds/:guildId/instances/:instanceId',
    async (request, reply) => {
      const { guildId, instanceId } = request.params
      const session = await requireGuildAccess(request, reply, guildId, botGuildIds())
      if (!session) return

      const enabled = request.body?.enabled
      if (typeof enabled !== 'boolean') {
        return reply.code(400).send({ error: 'Body must be { enabled: boolean }' })
      }

      const updated = await setInstanceEnabled(guildId, instanceId, enabled, session.userId)
      if (!updated) return reply.code(404).send({ error: 'No such instance' })

      return reply.send({ ok: true, enabled: updated.enabled })
    },
  )

  app.delete<{ Params: { guildId: string; instanceId: string } }>(
    '/api/guilds/:guildId/instances/:instanceId',
    async (request, reply) => {
      const { guildId, instanceId } = request.params
      const session = await requireGuildAccess(request, reply, guildId, botGuildIds())
      if (!session) return

      const deleted = await deleteInstance(guildId, instanceId)
      if (!deleted) return reply.code(404).send({ error: 'No such instance' })

      return reply.send({ ok: true })
    },
  )

  // --- stats --------------------------------------------------------------

  app.get<{ Params: { guildId: string } }>('/api/guilds/:guildId/stats', async (request, reply) => {
    const session = await requireGuildAccess(request, reply, request.params.guildId, botGuildIds())
    if (!session) return

    const { alerts, seenTokens } = getCollections()
    const guildId = request.params.guildId
    const dayAgo = new Date(Date.now() - 86_400_000)

    const [activeAlerts, alertMembers, launchesToday] = await Promise.all([
      alerts.countDocuments({ guildId, active: true }),
      alerts.distinct('userId', { guildId, active: true }),
      seenTokens.countDocuments({ guildId, postedAt: { $gte: dayAgo } }),
    ])

    return reply.send({
      activeAlerts,
      alertMembers: alertMembers.length,
      launchesToday,
    })
  })

  // --- live charts ----------------------------------------------------------
  // Powers the live-charts dashboard tab: the ten most recently alerted coins,
  // newest first. Deliberately only the five detectors that alert on a coin's
  // *own* condition (a spike, a level, a turn) - Call Tracker and price alerts
  // are about a person's call rather than the coin, so they'd crowd the board
  // with the same few watched tokens.

  const LIVE_CHART_FEATURES = [VOLUME_SPIKES.id, WHALE_BUYS.id, TRENDING.id, DIP_HUNTER.id, LEVEL_BREAK.id]
  const LIVE_CHART_LIMIT = 10

  /**
   * Rug-signature findings (docs/11-RUG-SIGNATURE.md) for a set of tokens,
   * keyed the same way `network` is resolved below. Only ever returns a
   * *flagged* row - a mint never checked, or checked and clean, has nothing
   * here, the same "absence is not safe" rule the embed follows.
   */
  async function rugFlagsFor(pairs: { chainId: string; tokenAddress: string }[]) {
    const flags = new Map<
      string,
      {
        fundingFlagged: boolean
        cohortSize: number
        funderWallet?: string
        tailMatch: boolean
        cohortSharePct?: number
        distributionFlagged: boolean
        distributionCv?: number
        distributionCohort?: number
        checkedAt: Date
      }
    >()
    // Rug checks are Solana-only - nothing else could ever match.
    const mints = pairs.filter((p) => p.chainId === 'solana').map((p) => p.tokenAddress)
    if (mints.length === 0) return flags

    const { rugChecks } = getCollections()
    const rows = await rugChecks.find({ chainId: 'solana', verdict: 'flag', mint: { $in: mints } }).toArray()

    for (const r of rows) {
      flags.set(`${r.chainId}:${r.mint}`, {
        fundingFlagged: r.fundingVerdict === 'flag',
        cohortSize: r.tightCohortSize,
        ...(r.funderWallet ? { funderWallet: r.funderWallet } : {}),
        tailMatch: r.tailMatch,
        ...(r.cohortSharePct !== undefined ? { cohortSharePct: r.cohortSharePct } : {}),
        distributionFlagged: r.distributionVerdict === 'flag',
        ...(r.distributionCv !== null ? { distributionCv: r.distributionCv } : {}),
        ...(r.distributionCohort !== null ? { distributionCohort: r.distributionCohort } : {}),
        checkedAt: r.checkedAt,
      })
    }
    return flags
  }

  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/live-charts',
    async (request, reply) => {
      const session = await requireGuildAccess(request, reply, request.params.guildId, botGuildIds())
      if (!session) return

      const { monitorAlerts, watchedTokens } = getCollections()
      const guildId = request.params.guildId

      const recent = await monitorAlerts
        .aggregate<{
          _id: { chainId: string; tokenAddress: string }
          symbol: string
          featureId: string
          postedAt: Date
        }>([
          { $match: { guildId, featureId: { $in: LIVE_CHART_FEATURES } } },
          { $sort: { postedAt: -1 } },
          {
            $group: {
              _id: { chainId: '$chainId', tokenAddress: '$tokenAddress' },
              symbol: { $first: '$symbol' },
              featureId: { $first: '$featureId' },
              postedAt: { $first: '$postedAt' },
            },
          },
          { $sort: { postedAt: -1 } },
          { $limit: LIVE_CHART_LIMIT },
        ])
        .toArray()

      if (recent.length === 0) return reply.send({ charts: [] })

      // monitor_alerts has no pair address - only the watchlist does, and only
      // for tokens still being polled. A token that has since dropped off the
      // watchlist gets no chart rather than a guessed pool.
      const pools = await watchedTokens
        .find({ $or: recent.map((r) => ({ chainId: r._id.chainId, tokenAddress: r._id.tokenAddress })) })
        .toArray()
      const poolByToken = new Map(pools.map((p) => [`${p.chainId}:${p.tokenAddress}`, p.pairAddress]))
      const rugFlags = await rugFlagsFor(
        recent.map((r) => ({ chainId: r._id.chainId, tokenAddress: r._id.tokenAddress })),
      )

      // `network` is GeckoTerminal's own network id, resolved server-side from
      // the same map the candle fetcher uses (src/market/geckoterminal.ts) so
      // the dashboard never carries a second, driftable copy of it.
      const charts = recent
        .map((r) => ({
          chainId: r._id.chainId,
          tokenAddress: r._id.tokenAddress,
          symbol: r.symbol,
          featureId: r.featureId,
          postedAt: r.postedAt,
          pairAddress: poolByToken.get(`${r._id.chainId}:${r._id.tokenAddress}`),
          network: geckoNetwork(r._id.chainId),
          rugFlag: rugFlags.get(`${r._id.chainId}:${r._id.tokenAddress}`) ?? null,
        }))
        .filter(
          (c): c is typeof c & { pairAddress: string; network: string } =>
            Boolean(c.pairAddress) && Boolean(c.network),
        )

      return reply.send({ charts })
    },
  )

  // --- coin history -----------------------------------------------------------
  // Powers the Coin History tab: pick a coin that has alerted in this guild,
  // see its price plotted against every alert - so a channel admin can judge
  // whether a detector is actually catching anything worth acting on.
  //
  // `volume_snapshots` and `monitor_alerts` both carry a 48h TTL (src/db/mongo.ts)
  // - this is a recent-history tool, not an archive, and the picker is scoped to
  // that same window on purpose so it never offers a coin with nothing left to
  // plot.

  const COIN_HISTORY_WINDOW_MS = 48 * 60 * 60_000

  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/tracked-coins',
    async (request, reply) => {
      const session = await requireGuildAccess(request, reply, request.params.guildId, botGuildIds())
      if (!session) return

      const { monitorAlerts } = getCollections()
      const guildId = request.params.guildId
      const since = new Date(Date.now() - COIN_HISTORY_WINDOW_MS)

      const coins = await monitorAlerts
        .aggregate<{ _id: { chainId: string; tokenAddress: string }; symbol: string; lastAlertAt: Date }>([
          { $match: { guildId, postedAt: { $gte: since } } },
          { $sort: { postedAt: -1 } },
          {
            $group: {
              _id: { chainId: '$chainId', tokenAddress: '$tokenAddress' },
              symbol: { $first: '$symbol' },
              lastAlertAt: { $first: '$postedAt' },
            },
          },
          { $sort: { lastAlertAt: -1 } },
        ])
        .toArray()

      return reply.send({
        coins: coins.map((c) => ({
          chainId: c._id.chainId,
          tokenAddress: c._id.tokenAddress,
          symbol: c.symbol,
          lastAlertAt: c.lastAlertAt,
        })),
      })
    },
  )

  app.get<{ Params: { guildId: string }; Querystring: { chainId?: string; tokenAddress?: string } }>(
    '/api/guilds/:guildId/coin-history',
    async (request, reply) => {
      const session = await requireGuildAccess(request, reply, request.params.guildId, botGuildIds())
      if (!session) return

      const { chainId, tokenAddress } = request.query
      if (!chainId || !tokenAddress) {
        return reply.code(400).send({ error: 'chainId and tokenAddress are required' })
      }

      const { volumeSnapshots, monitorAlerts } = getCollections()
      const guildId = request.params.guildId

      // Snapshots are not guild-scoped - one shared watchlist feeds every
      // guild's alerts - so the price series is read without a guildId filter.
      // Alerts stay scoped: a channel should only see the markers it actually
      // configured a detector to post.
      const [snapshots, alerts] = await Promise.all([
        volumeSnapshots
          .find({ chainId, tokenAddress })
          .sort({ at: 1 })
          .project<{ at: Date; priceUsd?: number; marketCapUsd?: number; liquidityUsd?: number }>({
            _id: 0,
            at: 1,
            priceUsd: 1,
            marketCapUsd: 1,
            liquidityUsd: 1,
          })
          .toArray(),
        monitorAlerts
          .find({ guildId, chainId, tokenAddress })
          .sort({ postedAt: 1 })
          .project<{ featureId: string; trigger: string; priority: string; postedAt: Date; symbol: string }>({
            _id: 0,
            featureId: 1,
            trigger: 1,
            priority: 1,
            postedAt: 1,
            symbol: 1,
          })
          .toArray(),
      ])

      return reply.send({
        symbol: alerts.at(-1)?.symbol ?? null,
        snapshots,
        alerts: alerts.map((a) => ({
          featureId: a.featureId,
          trigger: a.trigger,
          priority: a.priority,
          postedAt: a.postedAt,
        })),
      })
    },
  )

  // --- recent launches ---------------------------------------------------------
  // Powers Live Charts' separate "New Launches" column: the two most recent
  // distinct tokens the Launch Scanner posted in this guild. Older seen_tokens
  // rows (written before symbol/pairAddress existed) are skipped rather than
  // shown with a guessed pool - see SeenToken in src/db/models.ts.

  const RECENT_LAUNCH_LIMIT = 2

  app.get<{ Params: { guildId: string } }>(
    '/api/guilds/:guildId/recent-launches',
    async (request, reply) => {
      const session = await requireGuildAccess(request, reply, request.params.guildId, botGuildIds())
      if (!session) return

      const { seenTokens } = getCollections()
      const guildId = request.params.guildId

      const recent = await seenTokens
        .aggregate<{
          _id: { chainId: string; tokenAddress: string }
          symbol: string
          pairAddress: string
          postedAt: Date
        }>([
          { $match: { guildId, pairAddress: { $exists: true } } },
          { $sort: { postedAt: -1 } },
          {
            $group: {
              _id: { chainId: '$chainId', tokenAddress: '$tokenAddress' },
              symbol: { $first: '$symbol' },
              pairAddress: { $first: '$pairAddress' },
              postedAt: { $first: '$postedAt' },
            },
          },
          { $sort: { postedAt: -1 } },
          { $limit: RECENT_LAUNCH_LIMIT },
        ])
        .toArray()

      const rugFlags = await rugFlagsFor(
        recent.map((r) => ({ chainId: r._id.chainId, tokenAddress: r._id.tokenAddress })),
      )

      const launches = recent
        .map((r) => ({
          chainId: r._id.chainId,
          tokenAddress: r._id.tokenAddress,
          symbol: r.symbol,
          pairAddress: r.pairAddress,
          postedAt: r.postedAt,
          network: geckoNetwork(r._id.chainId),
          rugFlag: rugFlags.get(`${r._id.chainId}:${r._id.tokenAddress}`) ?? null,
        }))
        .filter((l): l is typeof l & { network: string } => Boolean(l.network))

      return reply.send({ launches })
    },
  )

  // --- watchlist --------------------------------------------------------------
  // Manage the shared, bot-wide watchlist (src/monitor/watchlist.ts) that feeds
  // volume-spikes, whale-buys and momentum - the dashboard's view of the same
  // list `/watch list` and `/watch remove` manage. Not guild-scoped data (one
  // watchlist for the whole bot, same as the slash command); only the auth
  // check is per-guild, matching every other dashboard route.

  /** How many holder-count lookups run at once - a live RugCheck/GoPlus call per token. */
  const WATCHLIST_HOLDER_CONCURRENCY = 5

  app.get<{ Params: { guildId: string } }>('/api/guilds/:guildId/watchlist', async (request, reply) => {
    const session = await requireGuildAccess(request, reply, request.params.guildId, botGuildIds())
    if (!session) return

    const tokens = await listAll()
    if (tokens.length === 0) return reply.send({ watchlist: [], cap: config.MONITOR_MAX_TOKENS })

    const { volumeSnapshots } = getCollections()

    // Latest snapshot per token - already collected every poll cycle, so
    // market cap and 1h volume cost one query rather than a live re-fetch.
    const snapshots = await volumeSnapshots
      .aggregate<{ _id: { chainId: string; tokenAddress: string }; marketCapUsd?: number; volH1?: number }>([
        { $match: { $or: tokens.map((t) => ({ chainId: t.chainId, tokenAddress: t.tokenAddress })) } },
        { $sort: { at: -1 } },
        {
          $group: {
            _id: { chainId: '$chainId', tokenAddress: '$tokenAddress' },
            marketCapUsd: { $first: '$marketCapUsd' },
            volH1: { $first: '$volH1' },
          },
        },
      ])
      .toArray()
    const snapshotByToken = new Map(snapshots.map((s) => [`${s._id.chainId}:${s._id.tokenAddress}`, s]))

    // Holder count is not cached anywhere on WatchedToken itself, so it is
    // fetched live - bounded concurrency so a watchlist near the 120-token
    // cap does not fire everything at RugCheck/GoPlus at once. A failed
    // lookup just means no count for that row, never a guessed one.
    const holderCounts = await mapWithConcurrency(
      tokens,
      async (t) => {
        try {
          return (await getHolderProfile(t.chainId, t.tokenAddress)).totalHolders
        } catch {
          return undefined
        }
      },
      WATCHLIST_HOLDER_CONCURRENCY,
    )

    const watchlist = tokens.map((t, i) => {
      const snap = snapshotByToken.get(`${t.chainId}:${t.tokenAddress}`)
      return {
        chainId: t.chainId,
        tokenAddress: t.tokenAddress,
        symbol: t.symbol,
        name: t.name,
        source: t.source,
        addedAt: t.addedAt,
        errorCount: t.errorCount,
        ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}),
        ...(snap?.marketCapUsd !== undefined ? { marketCapUsd: snap.marketCapUsd } : {}),
        ...(snap?.volH1 !== undefined ? { volH1: snap.volH1 } : {}),
        ...(holderCounts[i] !== undefined ? { holderCount: holderCounts[i] } : {}),
      }
    })

    return reply.send({ watchlist, cap: config.MONITOR_MAX_TOKENS })
  })

  app.delete<{ Params: { guildId: string; chainId: string; tokenAddress: string } }>(
    '/api/guilds/:guildId/watchlist/:chainId/:tokenAddress',
    async (request, reply) => {
      const session = await requireGuildAccess(request, reply, request.params.guildId, botGuildIds())
      if (!session) return

      const removed = await removeToken(request.params.chainId, request.params.tokenAddress)
      if (!removed) return reply.code(404).send({ error: 'That token is not on the watchlist.' })

      return reply.send({ ok: true })
    },
  )

  // --- tracked wallets ---------------------------------------------------------
  // Read-only leaderboard over an imported "known wallet" list (see
  // pnpm import:wallets / src/scripts/import-tracked-wallets.ts) - nothing on
  // this page writes to tracked_wallets, the import script does. Not
  // guild-scoped data (one bot-wide list); only the auth check is per-guild,
  // matching every other dashboard route.

  const TRACKED_WALLETS_LIMIT = 500

  app.get<{ Params: { guildId: string }; Querystring: { chain?: string; cohort?: string } }>(
    '/api/guilds/:guildId/tracked-wallets',
    async (request, reply) => {
      const session = await requireGuildAccess(request, reply, request.params.guildId, botGuildIds())
      if (!session) return

      const { trackedWallets } = getCollections()
      const filter: Record<string, unknown> = {}
      if (request.query.chain) filter.chainId = request.query.chain
      if (request.query.cohort) filter.cohort = request.query.cohort

      const rows = await trackedWallets.find(filter).limit(TRACKED_WALLETS_LIMIT).toArray()

      // Scored wallets rank by score; unscored (cohort-tagged, not
      // trade-scored) rows are pushed after them rather than sorted in as a
      // zero - the same unknown-is-not-low rule the /wallet embed follows.
      const scored = rows.filter((r) => r.score !== undefined).sort((a, b) => b.score! - a.score!)
      const unscored = rows.filter((r) => r.score === undefined)

      const wallets = [...scored, ...unscored].map((r) => ({
        wallet: r.wallet,
        chainId: r.chainId,
        label: r.label,
        source: r.source,
        cohort: r.cohort,
        score: r.score,
        winRate30d: r.winRate30d,
        totalTrades30d: r.totalTrades30d,
        totalPnlSol30d: r.totalPnlSol30d,
        avgHoldMin: r.avgHoldMin,
        active: r.active,
        favourited: r.favourited,
        notes: r.notes,
        lastActiveAt: r.lastActiveAt,
        importedAt: r.importedAt,
      }))

      return reply.send({ wallets })
    },
  )

  // --- my charts (personal board) --------------------------------------------
  // A freeform grid of GeckoTerminal embeds the dashboard user places and
  // sizes themselves, any chain, any coin - unlike Live Charts (driven by
  // what the monitor alerted on) or Watchlist (bot-wide), this is keyed by
  // `userId` and belongs to nobody else. Wayne and Ash each get their own,
  // regardless of which guild they're currently viewing.

  const BOARD_MAX_SLOTS = 40

  /**
   * GeckoTerminal candle widths confirmed live against its embed (its own
   * charting backend, not documented anywhere complete enough to trust) -
   * every one of these produced a distinct `resolution` value in the
   * candlestick request it made; values like `30m`, `6h` or `1w` were tried
   * and silently fell back to the default (15m) instead, which is worse than
   * an error because nothing would ever tell a user their choice did nothing.
   */
  const RESOLUTION_OPTIONS = [
    { value: '1m', label: '1m' },
    { value: '5m', label: '5m' },
    { value: '15m', label: '15m' },
    { value: '1h', label: '1h' },
    { value: '4h', label: '4h' },
    { value: '1d', label: '1d' },
  ]
  const RESOLUTION_VALUES = new Set(RESOLUTION_OPTIONS.map((r) => r.value))

  function slotIsValid(s: unknown): s is CustomBoardSlot {
    if (typeof s !== 'object' || s === null) return false
    const slot = s as Record<string, unknown>
    return (
      typeof slot.id === 'string' &&
      slot.id.length > 0 &&
      Number.isInteger(slot.x) &&
      Number.isInteger(slot.y) &&
      Number.isInteger(slot.w) &&
      Number.isInteger(slot.h) &&
      (slot.x as number) >= 0 &&
      (slot.y as number) >= 0 &&
      (slot.w as number) >= 1 &&
      (slot.h as number) >= 1 &&
      (slot.chainId === undefined || typeof slot.chainId === 'string') &&
      (slot.tokenAddress === undefined || typeof slot.tokenAddress === 'string') &&
      (slot.pairAddress === undefined || typeof slot.pairAddress === 'string') &&
      (slot.network === undefined || typeof slot.network === 'string') &&
      (slot.symbol === undefined || typeof slot.symbol === 'string') &&
      (slot.resolution === undefined || RESOLUTION_VALUES.has(slot.resolution as string))
    )
  }

  app.get<{ Params: { guildId: string } }>('/api/guilds/:guildId/custom-board', async (request, reply) => {
    const session = await requireGuildAccess(request, reply, request.params.guildId, botGuildIds())
    if (!session) return

    const { customBoards } = getCollections()
    const board = await customBoards.findOne({ userId: session.userId })

    return reply.send({
      slots: board?.slots ?? [],
      chainOptions: Object.values(CHAINS).map((c) => ({ value: c.id, label: c.label, emoji: c.emoji })),
      resolutionOptions: RESOLUTION_OPTIONS,
    })
  })

  app.put<{ Params: { guildId: string }; Body: { slots?: unknown } }>(
    '/api/guilds/:guildId/custom-board',
    async (request, reply) => {
      const session = await requireGuildAccess(request, reply, request.params.guildId, botGuildIds())
      if (!session) return

      const slots = request.body?.slots
      if (!Array.isArray(slots) || slots.length > BOARD_MAX_SLOTS) {
        return reply.code(400).send({ error: `Body must be { slots: [] }, at most ${BOARD_MAX_SLOTS} entries` })
      }
      if (!slots.every(slotIsValid)) {
        return reply.code(400).send({ error: 'One or more slots are malformed' })
      }

      const { customBoards } = getCollections()
      await customBoards.updateOne(
        { userId: session.userId },
        { $set: { userId: session.userId, slots, updatedAt: new Date() } },
        { upsert: true },
      )

      return reply.send({ ok: true })
    },
  )

  app.post<{ Params: { guildId: string }; Body: { chainId?: string; tokenAddress?: string } }>(
    '/api/guilds/:guildId/custom-board/resolve',
    async (request, reply) => {
      const session = await requireGuildAccess(request, reply, request.params.guildId, botGuildIds())
      if (!session) return

      const { chainId, tokenAddress } = request.body ?? {}
      if (!chainId || !CHAINS[chainId]) return reply.code(400).send({ error: 'Unknown network' })
      if (!tokenAddress?.trim()) return reply.code(400).send({ error: 'Paste a contract address' })

      let result
      try {
        result = await resolveToken(tokenAddress, chainId)
      } catch (err) {
        if (err instanceof TokenNotFoundError || err instanceof UnsupportedChainError) {
          return reply.code(404).send({ error: err.message })
        }
        log.bot.warn({ err: String(err), chainId, tokenAddress }, 'custom board: resolve failed')
        return reply.code(502).send({ error: 'Could not look that token up right now.' })
      }

      const network = geckoNetwork(result.pair.chainId)
      if (!network) {
        return reply.code(422).send({ error: `${result.pair.baseToken.symbol} has no chart provider for this chain.` })
      }

      return reply.send({
        chainId: result.pair.chainId,
        tokenAddress: result.pair.baseToken.address,
        pairAddress: result.pair.pairAddress,
        network,
        symbol: result.pair.baseToken.symbol,
      })
    },
  )

  // --- my alerts (personal Telegram watchlist) ------------------------------
  // A dashboard user's own tracked-coin list ("My Alerts", src/db/models.ts
  // TelegramWatch) - keyed by session.userId same as custom-board above, never
  // by guild. Any trigger that fires on a tracked coin, at any priority, gets
  // mirrored to this person's own Telegram chat with a chart attached - see
  // src/monitor/personal-alerts.ts for the delivery side. guildId in the URL
  // is only for the auth check, matching every other per-user route here.

  app.get<{ Params: { guildId: string } }>('/api/guilds/:guildId/telegram-watch', async (request, reply) => {
    const session = await requireGuildAccess(request, reply, request.params.guildId, botGuildIds())
    if (!session) return

    const { telegramWatches } = getCollections()
    const watch = await telegramWatches.findOne({ userId: session.userId })

    return reply.send({
      telegramChatId: watch?.telegramChatId ?? '',
      coins: watch?.coins ?? [],
      chainOptions: Object.values(CHAINS).map((c) => ({ value: c.id, label: c.label, emoji: c.emoji })),
    })
  })

  app.put<{ Params: { guildId: string }; Body: { telegramChatId?: string } }>(
    '/api/guilds/:guildId/telegram-watch/chat-id',
    async (request, reply) => {
      const session = await requireGuildAccess(request, reply, request.params.guildId, botGuildIds())
      if (!session) return

      const chatId = request.body?.telegramChatId?.trim() ?? ''

      const { telegramWatches } = getCollections()
      await telegramWatches.updateOne(
        { userId: session.userId },
        {
          $set: { userId: session.userId, updatedAt: new Date(), ...(chatId ? { telegramChatId: chatId } : {}) },
          ...(chatId ? {} : { $unset: { telegramChatId: '' } }),
          $setOnInsert: { coins: [] },
        },
        { upsert: true },
      )

      return reply.send({ ok: true })
    },
  )

  app.post<{ Params: { guildId: string }; Body: { chainId?: string; tokenAddress?: string } }>(
    '/api/guilds/:guildId/telegram-watch/coins',
    async (request, reply) => {
      const session = await requireGuildAccess(request, reply, request.params.guildId, botGuildIds())
      if (!session) return

      const { chainId, tokenAddress } = request.body ?? {}
      if (!chainId || !CHAINS[chainId]) return reply.code(400).send({ error: 'Unknown network' })
      if (!tokenAddress?.trim()) return reply.code(400).send({ error: 'Paste a contract address' })

      let result
      try {
        result = await resolveToken(tokenAddress, chainId)
      } catch (err) {
        if (err instanceof TokenNotFoundError || err instanceof UnsupportedChainError) {
          return reply.code(404).send({ error: err.message })
        }
        log.bot.warn({ err: String(err), chainId, tokenAddress }, 'telegram-watch: resolve failed')
        return reply.code(502).send({ error: 'Could not look that token up right now.' })
      }

      const coin = {
        chainId: result.pair.chainId,
        tokenAddress: result.pair.baseToken.address,
        pairAddress: result.pair.pairAddress,
        symbol: result.pair.baseToken.symbol,
        addedAt: new Date(),
      }

      const { telegramWatches } = getCollections()
      // Dedupe by (chainId, tokenAddress): pull any existing entry for this
      // token first, then push the fresh one, so adding a token already
      // tracked re-points it (new pairAddress/symbol) rather than duplicating.
      await telegramWatches.updateOne(
        { userId: session.userId },
        { $pull: { coins: { chainId: coin.chainId, tokenAddress: coin.tokenAddress } } },
        { upsert: true },
      )
      await telegramWatches.updateOne(
        { userId: session.userId },
        { $push: { coins: coin }, $set: { updatedAt: new Date() } },
      )

      return reply.send({ ok: true, coin })
    },
  )

  app.delete<{ Params: { guildId: string; chainId: string; tokenAddress: string } }>(
    '/api/guilds/:guildId/telegram-watch/coins/:chainId/:tokenAddress',
    async (request, reply) => {
      const session = await requireGuildAccess(request, reply, request.params.guildId, botGuildIds())
      if (!session) return

      const { chainId, tokenAddress } = request.params
      const { telegramWatches } = getCollections()
      const result = await telegramWatches.updateOne(
        { userId: session.userId },
        { $pull: { coins: { chainId, tokenAddress } }, $set: { updatedAt: new Date() } },
      )

      if (result.matchedCount === 0) return reply.code(404).send({ error: 'No alerts list for this account.' })
      return reply.send({ ok: true })
    },
  )

  // --- holdings (owner only) ------------------------------------------------
  // Charts of whatever two configured wallets currently hold - a purely
  // personal view, not a bot feature, so it is gated on Wayne's own login
  // rather than on guild membership. Wallet tracking is explicitly out of
  // scope for this bot everywhere else; this is the one deliberate exception,
  // reading two wallets someone put in config directly, never inferred and
  // never stored.

  const OWNER_EMAIL = 'wayne@steedman.co.za'
  const HOLDINGS_CONCURRENCY = 4

  interface WalletPosition {
    mint: string
    chain: string
    symbol: string | null
  }

  app.get<{ Params: { guildId: string } }>('/api/guilds/:guildId/holdings', async (request, reply) => {
    const session = await requireGuildAccess(request, reply, request.params.guildId, botGuildIds())
    if (!session) return

    // A local (email/password) session is the only kind that carries an email
    // at all - Discord OAuth never asks for one (src/web/auth.ts). So this can
    // only ever admit the one account it is meant for, never a Discord login
    // that happens to share a display name.
    if (!session.local || session.username.toLowerCase() !== OWNER_EMAIL) {
      return reply.code(403).send({ error: 'Not available for this account.' })
    }

    const positions: WalletPosition[] = []
    const errors: string[] = []

    if (config.HOLDINGS_SOLANA_WALLET) {
      try {
        const held = await solanaTokenHoldings(config.HOLDINGS_SOLANA_WALLET)
        positions.push(...held.map((h): WalletPosition => ({ mint: h.mint, chain: 'solana', symbol: null })))
      } catch (err) {
        log.bot.warn({ err: String(err) }, 'holdings: could not read the Solana wallet')
        errors.push('Could not read the Solana wallet.')
      }
    }

    if (config.HOLDINGS_EVM_WALLET) {
      // Sequential, not concurrent - each chain is its own Blockscout host
      // sharing one conservative rate bucket, and this is a handful of
      // chains on a page a human opens, not a poll.
      for (const chain of config.HOLDINGS_EVM_CHAINS) {
        try {
          const held = await evmTokenHoldings(chain, config.HOLDINGS_EVM_WALLET)
          positions.push(...held.map((h): WalletPosition => ({ mint: h.tokenAddress, chain, symbol: h.symbol })))
        } catch (err) {
          log.bot.warn({ err: String(err), chain }, 'holdings: could not read the EVM wallet')
          errors.push(`Could not read ${chain}.`)
        }
      }
    }

    // A held mint's pool and live market cap are resolved the same way every
    // other chart on this dashboard resolves them (selectPricePair via
    // resolveToken), never guessed or read from a stale figure. A wallet
    // routinely holds spam/airdropped tokens with no real pool - those fail
    // resolution and are dropped here, the same as anywhere else on this
    // dashboard a token with nothing to quote it shows nothing rather than a
    // guess.
    const resolved = await mapWithConcurrency(
      positions,
      async (p) => {
        const network = geckoNetwork(p.chain)
        if (!network) return null
        try {
          const { pair } = await resolveToken(p.mint, p.chain)
          return {
            chainId: p.chain,
            tokenAddress: p.mint,
            pairAddress: pair.pairAddress,
            symbol: p.symbol ?? pair.baseToken.symbol,
            network,
            marketCapUsd: pair.marketCap ?? pair.fdv ?? null,
          }
        } catch (err) {
          log.bot.debug({ err: String(err), mint: p.mint }, 'holdings: could not resolve a pool')
          return null
        }
      },
      HOLDINGS_CONCURRENCY,
    )

    const holdings = resolved
      .filter((h): h is NonNullable<typeof h> => h !== null)
      .sort((a, b) => (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0))

    return reply.send({ holdings, ...(errors.length > 0 ? { error: errors.join(' ') } : {}) })
  })

  // --- health -------------------------------------------------------------

  app.get('/api/health', async (_request, reply) =>
    reply.send({
      ok: true,
      discord: client.isReady(),
      guilds: client.guilds.cache.size,
    }),
  )

  app.get('/api/session-check', async (request, reply) => {
    const session = await requireSession(request, reply)
    if (!session) return
    return reply.send({ ok: true, userId: session.userId })
  })
}
