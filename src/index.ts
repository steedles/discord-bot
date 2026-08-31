import { config } from './config.js'
import { migrateScannerConfig } from './db/migrate.js'
import { closeMongo, connectMongo } from './db/mongo.js'
import { createClient } from './discord/client.js'
import { logger } from './logger.js'
import { VolumeMonitorWorker } from './monitor/worker.js'
import { DashboardServer } from './web/server.js'
import { CoinTrackerWorker } from './workers/coin-tracker.js'
import { LaunchScannerWorker } from './workers/launch-scanner.js'
import { PriceAlertWorker } from './workers/price-alerts.js'
import { CallTrackerWorker } from './workers/call-tracker.js'
import { TokenBriefWorker } from './workers/token-brief.js'

async function main(): Promise<void> {
  await connectMongo()
  await migrateScannerConfig()

  const client = createClient()
  const priceAlerts = new PriceAlertWorker(client)
  const launchScanner = new LaunchScannerWorker(client)
  // Rug Watch is parked - see the note in src/features/registry.ts. Token Brief
  // answers the same question privately, and two bots replying to one address is
  // worse than either alone.
  const tokenBrief = new TokenBriefWorker(client)
  const coinTracker = new CoinTrackerWorker(client)
  // Reads calls out of the channel and puts them on the watchlist; the monitor
  // below does the following up, since it is already polling that watchlist.
  const callTracker = new CallTrackerWorker(client)
  const volumeMonitor = new VolumeMonitorWorker(client)
  // The dashboard also carries the Helius webhook route, so the monitor is
  // handed to it - Solana whale alerts arrive over HTTP, not over the gateway.
  const dashboard = new DashboardServer(client, { volumeMonitor })

  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true

    logger.info({ signal }, 'shutting down')
    priceAlerts.stop()
    launchScanner.stop()
    tokenBrief.stop()
    coinTracker.stop()
    callTracker.stop()
    volumeMonitor.stop()
    await dashboard.stop()
    await client.destroy()
    await closeMongo()
    process.exit(0)
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('unhandledRejection', (reason) => logger.error({ reason }, 'unhandled rejection'))

  await client.login(config.DISCORD_TOKEN)

  priceAlerts.start()
  launchScanner.start()
  tokenBrief.start()
  coinTracker.start()
  callTracker.start()
  volumeMonitor.start()

  // Started last: it reads the guild cache, which is only populated once the
  // gateway connection is up.
  await dashboard.start()
}

main().catch((err) => {
  // Mongo and Discord auth are the two things that fail on a first run, and a
  // raw driver stack trace buries what to actually do about it.
  const message = err instanceof Error ? err.message : String(err)

  if (/authentication|Authentication failed|ECONNREFUSED|ServerSelection/i.test(message)) {
    logger.error(
      `Could not reach MongoDB at ${config.MONGO_URI} - ${message}\n` +
        "Start this project's dev database with:\n" +
        '  docker compose -f docker-compose.dev.yml up -d\n' +
        'or point MONGO_URI at your own instance (include credentials if it needs auth).',
    )
    process.exit(1)
  }

  if (/disallowed intents/i.test(message)) {
    logger.error(
      `Discord refused the privileged intents - ${message}\n` +
        'Token Brief needs the Message Content intent. Enable it at:\n' +
        '  Discord portal -> your app -> Bot -> Privileged Gateway Intents -> Message Content Intent\n' +
        'or set ENABLE_MESSAGE_CONTENT=false in .env to run without Token Brief.',
    )
    process.exit(1)
  }

  if (/TokenInvalid|An invalid token/i.test(message)) {
    logger.error(`Discord rejected the login - ${message}\nCheck DISCORD_TOKEN in .env.`)
    process.exit(1)
  }

  logger.error({ err }, 'fatal startup error')
  process.exit(1)
})
