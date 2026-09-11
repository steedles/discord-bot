/**
 * Runs the dashboard on its own, with a stand-in Discord server and demo data.
 *
 *   pnpm dashboard:preview
 *
 * For looking at and working on the UI without needing a Discord application, a
 * bot token, or the bot to be in a server. Everything below the HTTP layer is
 * the real thing - the same routes, the same validation, the same database code
 * - so toggles and settings genuinely save.
 *
 * Safety: writes to a separate `_preview` database, binds to localhost only,
 * and refuses to run with NODE_ENV=production.
 */
import 'dotenv/config'

if (process.env.NODE_ENV === 'production') {
  console.error('dashboard:preview must not be run in production')
  process.exit(1)
}

// Overridden before config.ts is loaded, so the preview cannot touch the real
// database or listen on anything but loopback. Dynamic imports below keep these
// assignments ahead of the module graph.
process.env.MONGO_DB = `${process.env.MONGO_DB || 'discord_bot'}_preview`
process.env.DASHBOARD_HOST = '127.0.0.1'
process.env.DASHBOARD_ENABLED = 'true'
process.env.DASHBOARD_PORT ||= '4300'
// Respect a tunnel URL from .env (ngrok, Cloudflare) so the preview can be
// reached from off-machine; fall back to loopback.
process.env.DASHBOARD_URL ||= `http://localhost:${process.env.DASHBOARD_PORT}`
// OAuth is never exercised in preview, but the server refuses to start without
// these set - which is the behaviour we want everywhere else.
process.env.DISCORD_CLIENT_SECRET ||= 'preview-not-a-real-secret'
process.env.DISCORD_CLIENT_ID ||= '000000000000000000'
process.env.DISCORD_TOKEN ||= 'preview-not-a-real-token'
process.env.SESSION_SECRET ||= 'preview-session-secret-not-for-production'
// The Fomo routes only mount when the feature is on and a secret is set, so
// the preview turns both on for itself. Nothing here reaches the real sidecar:
// the worker is constructed for its routes, never started, and the database is
// still the _preview one set above.
process.env.FOMO_ENABLED ||= 'true'
process.env.FOMO_INGEST_SECRET ||= 'preview-not-a-real-secret'

const { Collection } = await import('discord.js')
const { config } = await import('../config.js')
const { upsertInstance } = await import('../db/features.js')
const { closeMongo, connectMongo, getCollections } = await import('../db/mongo.js')
const { logger } = await import('../logger.js')
const { DashboardServer } = await import('../web/server.js')
const { FomoWatchWorker } = await import('../workers/fomo-watch.js')

type AnyClient = ConstructorParameters<typeof DashboardServer>[0]

const GUILD_ID = '000000000000000001'
const CHANNELS = [
  { id: '000000000000000010', name: 'alpha-calls' },
  { id: '000000000000000011', name: 'degen-plays' },
  { id: '000000000000000012', name: 'price-chat' },
  { id: '000000000000000013', name: 'general' },
]

/** Enough of a Client for the dashboard routes - they only read caches. */
function stubClient(): AnyClient {
  const channels = new Collection<string, unknown>()
  for (const c of CHANNELS) {
    channels.set(c.id, {
      id: c.id,
      name: c.name,
      type: 0,
      parent: null,
      isTextBased: () => true,
      isSendable: () => true,
    })
  }

  // A couple of roles so the "Roles to ping" picker (GET .../roles) has
  // something to show - that route reads guild.roles.cache directly.
  const roles = new Collection<string, unknown>([
    [GUILD_ID, { id: GUILD_ID, name: '@everyone', hexColor: '#000000', mentionable: false, position: 0, managed: false }],
    [
      '000000000000000020',
      { id: '000000000000000020', name: 'Alerts', hexColor: '#e74c3c', mentionable: true, position: 1, managed: false },
    ],
  ])

  const guild = {
    id: GUILD_ID,
    name: 'Preview Server',
    iconURL: () => null,
    channels: { cache: channels },
    roles: { cache: roles },
    members: { me: null },
  }

  const guilds = new Collection<string, unknown>([[GUILD_ID, guild]])
  return { isReady: () => true, guilds: { cache: guilds } } as unknown as AnyClient
}

/** Real, live pairs so the Live Charts tab's DexScreener embeds actually render something. */
const DEMO_TOKENS = [
  {
    chainId: 'solana',
    tokenAddress: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    pairAddress: 'D6NdKrKNQPmRZCCnG1GqXtF7MMoHB7qR6GU5TkG59Qz1',
    symbol: 'WIF',
    featureId: 'volume-spikes',
  },
  {
    chainId: 'solana',
    tokenAddress: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    pairAddress: '5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9',
    symbol: 'BONK',
    featureId: 'dip-hunter',
  },
  {
    chainId: 'base',
    tokenAddress: '0x4200000000000000000000000000000000000006',
    pairAddress: '0x72AB388E2E2F6FaceF59E3C3FA2C4E29011c2D38',
    symbol: 'WETH',
    featureId: 'whale-buys',
  },
]

async function seed(): Promise<void> {
  const { featureInstances, alerts, monitorAlerts, watchedTokens } = getCollections()

  // Seed once only, so edits made in the UI survive a restart.
  if ((await featureInstances.countDocuments({ guildId: GUILD_ID })) > 0) return
  logger.info('seeding preview data')

  // The headline case: one feature, two channels, very different filters.
  await upsertInstance({
    guildId: GUILD_ID,
    featureId: 'launch-scanner',
    channelId: CHANNELS[0]!.id,
    enabled: true,
    label: 'Blue chips only',
    settings: {
      minLiquidityUsd: 250_000,
      minVolume24hUsd: 100_000,
      maxRiskScore: 15,
      requireSocials: true,
      chains: ['solana', 'base'],
    },
  })
  await upsertInstance({
    guildId: GUILD_ID,
    featureId: 'launch-scanner',
    channelId: CHANNELS[1]!.id,
    enabled: true,
    label: 'High risk, early',
    settings: {
      minLiquidityUsd: 5_000,
      minVolume24hUsd: 2_000,
      maxRiskScore: 75,
      requireSocials: false,
      maxAgeMinutes: 120,
      sources: ['pumpfun'],
    },
  })

  await upsertInstance({ guildId: GUILD_ID, featureId: 'market-lookup', channelId: null, enabled: true })
  await upsertInstance({
    guildId: GUILD_ID,
    featureId: 'market-lookup',
    channelId: CHANNELS[3]!.id,
    enabled: true,
    settings: { ephemeral: true },
  })
  await upsertInstance({ guildId: GUILD_ID, featureId: 'price-alerts', channelId: null, enabled: true })

  // A few alerts so the stat strip is not all zeroes.
  for (let i = 0; i < 6; i++) {
    await alerts.insertOne({
      guildId: GUILD_ID,
      userId: `preview-user-${i % 3}`,
      channelId: CHANNELS[2]!.id,
      chainId: 'solana',
      tokenAddress: `PreviewToken${i}`,
      pairAddress: `PreviewPair${i}`,
      symbol: ['WIF', 'BONK', 'JUP'][i % 3]!,
      direction: i % 2 === 0 ? 'above' : 'below',
      target: 1,
      priceAtCreate: 0.5,
      repeat: false,
      active: true,
      armed: true,
      createdAt: new Date(),
      triggerCount: 0,
      errorCount: 0,
    })
  }

  // So the Fomo page has a feed to render. Shapes match what the normaliser
  // produces from a real payload - a buy, a sell, and a thesis carrying the
  // author's position - plus one trade so the attribution panel is not empty.
  const { fomoAlerts, fomoAlertTrades } = getCollections()
  const FOMO_DEMO = [
    { eventId: 'preview-1', kind: 'BUY' as const, traderHandle: 'frankdegods', ticker: 'TENDIES',
      usdAmount: 2400, price: 0.00042, marketCap: 1_850_000, minutesAgo: 2 },
    { eventId: 'preview-2', kind: 'THESIS' as const, traderHandle: 'unipcs', ticker: 'TENDIES',
      thesis: 'Bought the retrace into the 1.8M band. Thin book above here and the dev wallet has not moved since launch, so this is a liquidity bet rather than a conviction one. Out if it loses 1.4M.',
      minutesAgo: 6 },
    { eventId: 'preview-3', kind: 'SELL' as const, traderHandle: 'orangie', ticker: 'WIF',
      usdAmount: 8100, price: 1.87, marketCap: 1_870_000_000, minutesAgo: 21 },
  ]
  for (const demo of FOMO_DEMO) {
    const at = new Date(Date.now() - demo.minutesAgo * 60_000)
    await fomoAlerts.insertOne({
      eventId: demo.eventId,
      kind: demo.kind,
      traderHandle: demo.traderHandle,
      traderVerified: true,
      chainId: 'solana',
      ticker: demo.ticker,
      usdAmount: demo.usdAmount,
      price: demo.price,
      marketCap: demo.marketCap,
      thesis: demo.thesis,
      position: demo.kind === 'THESIS' ? { usdValue: 12_400, percentageUnrealizedPnl: 18.3 } : undefined,
      createdAt: at,
      receivedAt: at,
    })
  }
  await fomoAlertTrades.insertOne({
    tradeRef: 'preview-trade-1',
    eventId: 'preview-1',
    source: 'preview',
    side: 'BUY',
    mode: 'paper',
    status: 'closed',
    chainId: 'solana',
    ticker: 'TENDIES',
    usdAmount: 50,
    pnlUsd: 12.4,
    pnlPct: 24.8,
    openedAt: new Date(Date.now() - 2 * 60_000),
    closedAt: new Date(),
    updatedAt: new Date(),
  })

  // So the Live Charts tab has something recent to show.
  for (const [i, token] of DEMO_TOKENS.entries()) {
    await watchedTokens.insertOne({
      chainId: token.chainId,
      tokenAddress: token.tokenAddress,
      pairAddress: token.pairAddress,
      symbol: token.symbol,
      name: token.symbol,
      source: 'manual',
      addedAt: new Date(),
      errorCount: 0,
    })
    await monitorAlerts.insertOne({
      guildId: GUILD_ID,
      channelId: CHANNELS[0]!.id,
      featureId: token.featureId,
      chainId: token.chainId,
      tokenAddress: token.tokenAddress,
      symbol: token.symbol,
      trigger: 'preview demo alert',
      priority: 'normal',
      postedAt: new Date(Date.now() - i * 60_000),
    })
  }
}

await connectMongo()
await seed()

const { sessions } = getCollections()
const sessionId = 'preview-session'

await sessions.deleteOne({ sessionId })
await sessions.insertOne({
  sessionId,
  userId: 'preview',
  username: 'preview-admin',
  guildIds: [GUILD_ID],
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 86_400_000),
})

// Constructed, deliberately not started: `start()` only arms the health timer,
// and the routes are what the preview needs.
const fomoWatch = new FomoWatchWorker(stubClient())
const server = new DashboardServer(stubClient(), { devLoginSessionId: sessionId, fomoWatch })

if (!(await server.start())) {
  logger.error('dashboard did not start - check the DASHBOARD_* settings')
  process.exit(1)
}

logger.info(
  `\n\n  PREVIEW READY - open this link to sign in:\n\n` +
    `    ${config.DASHBOARD_URL}/dev-login\n\n` +
    `  Database: ${config.MONGO_DB} (separate from the real bot)\n`,
)

const shutdown = async (): Promise<void> => {
  await server.stop()
  await closeMongo()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
