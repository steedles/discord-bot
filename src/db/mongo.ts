import { MongoClient, type Collection, type Db } from 'mongodb'
import { config } from '../config.js'
import { log } from '../logger.js'
import type {
  Alert,
  CoinTracker,
  DipState,
  TokenCall,
  FeatureInstance,
  GuildConfig,
  MonitorAlert,
  PendingMint,
  RugCheck,
  SeenToken,
  Session,
  VolumeSnapshot,
  WatchedToken,
  TrackedWallet,
  CustomBoard,
  TelegramWatch,
  FomoSeenEvent,
  FomoAlert,
  FomoAlertTrade,
  StoredCandle,
  CandlePool,
  OpsJob,
} from './models.js'

let client: MongoClient | undefined
let db: Db | undefined

export interface Collections {
  alerts: Collection<Alert>
  coinTrackers: Collection<CoinTracker>
  featureInstances: Collection<FeatureInstance>
  sessions: Collection<Session>
  seenTokens: Collection<SeenToken>
  pendingMints: Collection<PendingMint>
  volumeSnapshots: Collection<VolumeSnapshot>
  candles: Collection<StoredCandle>
  candlePools: Collection<CandlePool>
  monitorAlerts: Collection<MonitorAlert>
  dipStates: Collection<DipState>
  tokenCalls: Collection<TokenCall>
  watchedTokens: Collection<WatchedToken>
  rugChecks: Collection<RugCheck>
  trackedWallets: Collection<TrackedWallet>
  customBoards: Collection<CustomBoard>
  telegramWatches: Collection<TelegramWatch>
  fomoEvents: Collection<FomoSeenEvent>
  /** The kept record, as against the dedup ledger above. */
  fomoAlerts: Collection<FomoAlert>
  fomoAlertTrades: Collection<FomoAlertTrade>
  /** Audit of dashboard-queued host jobs. Key names and outcomes, never values. */
  opsJobs: Collection<OpsJob>
  /** @deprecated Read only by the one-time migration off the old scanner config. */
  guilds: Collection<GuildConfig>
}

let collections: Collections | undefined

export async function connectMongo(): Promise<Collections> {
  if (collections) return collections

  client = new MongoClient(config.MONGO_URI, { serverSelectionTimeoutMS: 8_000 })
  await client.connect()
  db = client.db(config.MONGO_DB)

  collections = {
    alerts: db.collection<Alert>('alerts'),
    coinTrackers: db.collection<CoinTracker>('coin_trackers'),
    featureInstances: db.collection<FeatureInstance>('feature_instances'),
    sessions: db.collection<Session>('sessions'),
    seenTokens: db.collection<SeenToken>('seen_tokens'),
    pendingMints: db.collection<PendingMint>('pending_mints'),
    volumeSnapshots: db.collection<VolumeSnapshot>('volume_snapshots'),
    candles: db.collection<StoredCandle>('candles'),
    candlePools: db.collection<CandlePool>('candle_pools'),
    monitorAlerts: db.collection<MonitorAlert>('monitor_alerts'),
    dipStates: db.collection<DipState>('dip_states'),
    tokenCalls: db.collection<TokenCall>('token_calls'),
    watchedTokens: db.collection<WatchedToken>('watched_tokens'),
    rugChecks: db.collection<RugCheck>('rug_checks'),
    trackedWallets: db.collection<TrackedWallet>('tracked_wallets'),
    customBoards: db.collection<CustomBoard>('custom_boards'),
    telegramWatches: db.collection<TelegramWatch>('telegram_watches'),
    fomoEvents: db.collection<FomoSeenEvent>('fomo_events'),
    fomoAlerts: db.collection<FomoAlert>('fomo_alerts'),
    fomoAlertTrades: db.collection<FomoAlertTrade>('fomo_alert_trades'),
    opsJobs: db.collection<OpsJob>('ops_jobs'),
    guilds: db.collection<GuildConfig>('guilds'),
  }

  await ensureIndexes(collections)
  log.db.info({ db: config.MONGO_DB }, 'mongo connected')
  return collections
}

async function ensureIndexes(c: Collections): Promise<void> {
  await Promise.all([
    c.alerts.createIndex({ active: 1, chainId: 1 }),
    c.alerts.createIndex({ guildId: 1, userId: 1 }),
    c.alerts.createIndex({ tokenAddress: 1, chainId: 1 }),

    // The worker sweeps active trackers oldest-checked first, so the API
    // budget is spread evenly instead of always favouring the same rows.
    c.coinTrackers.createIndex({ active: 1, lastCheckedAt: 1 }),
    c.coinTrackers.createIndex({ guildId: 1, userId: 1 }),
    // One tracker per person per pool - asking twice is a no-op, not a double ping.
    c.coinTrackers.createIndex(
      { guildId: 1, userId: 1, chainId: 1, pairAddress: 1 },
      { unique: true },
    ),

    // One row per feature per place. channelId null is the guild-wide row.
    c.featureInstances.createIndex({ guildId: 1, featureId: 1, channelId: 1 }, { unique: true }),
    c.featureInstances.createIndex({ featureId: 1, enabled: 1 }),

    c.sessions.createIndex({ sessionId: 1 }, { unique: true }),
    c.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),

    // THE dedup mechanism for Fomo activity. Unique on Fomo's own event id, so a
    // duplicate insert throws rather than needing a read-then-write that two
    // delivery paths could race. Never on tradeId: a thesis shares the tradeId
    // of the trade it comments on, so that key would swallow theses.
    c.fomoEvents.createIndex({ eventId: 1 }, { unique: true }),
    // A week is far longer than any window in which an event could recur; past
    // that these rows only cost disk.
    c.fomoEvents.createIndex({ seenAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 }),

    // The kept alerts. Same unique key as the dedup ledger above and for the
    // same reason, but a far longer life - this one exists to be read.
    c.fomoAlerts.createIndex({ eventId: 1 }, { unique: true }),
    // Ninety days, not seven: long enough to judge a trader over a run of
    // calls, bounded because the disk under this box is the real constraint.
    c.fomoAlerts.createIndex({ receivedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 }),
    // The three ways the dashboard slices: newest first, by kind, by trader.
    c.fomoAlerts.createIndex({ receivedAt: -1 }),
    c.fomoAlerts.createIndex({ kind: 1, receivedAt: -1 }),
    c.fomoAlerts.createIndex({ traderHandle: 1, receivedAt: -1 }),

    // Trades carry no TTL. An alert is news and ages out; a trade is a record
    // of money and does not.
    c.fomoAlertTrades.createIndex({ tradeRef: 1 }, { unique: true }),
    c.fomoAlertTrades.createIndex({ eventId: 1 }),
    c.fomoAlertTrades.createIndex({ openedAt: -1 }),
    c.fomoAlertTrades.createIndex({ status: 1, openedAt: -1 }),

    c.guilds.createIndex({ guildId: 1 }, { unique: true }),

    c.opsJobs.createIndex({ jobId: 1 }, { unique: true }),
    c.opsJobs.createIndex({ status: 1, createdAt: 1 }),
    // An audit trail, so it is kept for a while - but it is only ever read
    // from the Setup tab, and a year-old restart tells nobody anything.
    c.opsJobs.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 }),

    c.seenTokens.createIndex(
      { guildId: 1, channelId: 1, chainId: 1, tokenAddress: 1 },
      { unique: true },
    ),
    // Forget a token after 14 days so a genuine relaunch can be posted again.
    c.seenTokens.createIndex({ postedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 14 }),
    // Live-charts dashboard: most recent launches for one guild.
    c.seenTokens.createIndex({ guildId: 1, postedAt: -1 }),

    c.pendingMints.createIndex({ mint: 1 }, { unique: true }),

    // One row per pool per minute. The unique key is what makes re-storing an
    // overlapping fetch an upsert rather than a duplicate.
    c.candles.createIndex({ chainId: 1, poolAddress: 1, t: 1 }, { unique: true }),
    c.candles.createIndex({ chainId: 1, poolAddress: 1, t: -1 }),
    // Same 48h horizon as the snapshot history - past that nothing reads them.
    c.candles.createIndex({ at: 1 }, { expireAfterSeconds: 60 * 60 * 48 }),
    c.candlePools.createIndex({ chainId: 1, poolAddress: 1 }, { unique: true }),
    c.candlePools.createIndex({ fetchedAt: 1 }, { expireAfterSeconds: 60 * 60 * 48 }),
    c.pendingMints.createIndex({ checkedAt: 1 }),
    // A pump.fun mint that has not graduated within 48h never will.
    c.pendingMints.createIndex({ firstSeenAt: 1 }, { expireAfterSeconds: 60 * 60 * 48 }),

    // Baselines read the newest N readings for one pool, so sort order is part
    // of the index rather than something Mongo works out per query.
    c.volumeSnapshots.createIndex({ chainId: 1, tokenAddress: 1, at: -1 }),
    // 48h is well past the longest baseline window; older readings only cost disk.
    c.volumeSnapshots.createIndex({ at: 1 }, { expireAfterSeconds: 60 * 60 * 48 }),

    // One armed dip per token per channel; arming twice is an update, not a
    // second follow-up.
    c.dipStates.createIndex({ channelId: 1, chainId: 1, tokenAddress: 1 }, { unique: true }),
    // A dip that never recovers stops being tracked on its own.
    c.dipStates.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),

    // The follow-up sweep reads every call still being followed, every cycle.
    c.tokenCalls.createIndex({ closedAt: 1, chainId: 1, tokenAddress: 1 }),
    // One call per message per token: the same message seen twice is one call.
    c.tokenCalls.createIndex({ messageId: 1, chainId: 1, tokenAddress: 1 }, { unique: true }),
    c.tokenCalls.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),

    // Cooldown lookup: has this token alerted in this channel for this feature?
    c.monitorAlerts.createIndex({ channelId: 1, featureId: 1, chainId: 1, tokenAddress: 1, postedAt: -1 }),
    // Hourly cap: how many alerts has this channel had?
    c.monitorAlerts.createIndex({ channelId: 1, postedAt: -1 }),
    // Live-charts dashboard: most recently alerted tokens for one guild.
    c.monitorAlerts.createIndex({ guildId: 1, featureId: 1, postedAt: -1 }),
    // Longer than any cooldown a schema allows (24h), so history outlives its use.
    c.monitorAlerts.createIndex({ postedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 }),

    // One row per token. Adding a token twice re-points it, never duplicates it.
    c.watchedTokens.createIndex({ chainId: 1, tokenAddress: 1 }, { unique: true }),
    // The poll sweeps least-recently-checked first, so a big watchlist degrades
    // into slower coverage rather than into starving half the list.
    c.watchedTokens.createIndex({ lastPolledAt: 1 }),
    // Auto-discovered tokens carry expiresAt and drop out on their own. Manual
    // ones have no such field, and a TTL index ignores documents that lack it.
    c.watchedTokens.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),

    // One verdict per mint, forever - no TTL. The funding graph a rug check
    // reads is permanent on-chain history, so the answer never goes stale.
    c.rugChecks.createIndex({ chainId: 1, mint: 1 }, { unique: true }),

    // Tracked Wallets - one row per (chain, wallet), looked up by address from
    // both the /wallet command and the dashboard leaderboard. Imported, never
    // written by this bot - no TTL, the same as any other externally-sourced
    // reference data (rugChecks above).
    c.trackedWallets.createIndex({ chainId: 1, wallet: 1 }, { unique: true }),
    // Dashboard leaderboard default sort: best-scored wallets first.
    c.trackedWallets.createIndex({ chainId: 1, active: 1, score: -1 }),
    c.trackedWallets.createIndex({ favourited: 1, score: -1 }),
    c.trackedWallets.createIndex({ cohort: 1, active: 1, score: -1 }),

    // One board per person, forever - no TTL, same reasoning as feature config.
    c.customBoards.createIndex({ userId: 1 }, { unique: true }),

    // One watchlist per person, forever - same reasoning as customBoards above.
    c.telegramWatches.createIndex({ userId: 1 }, { unique: true }),
    // The alert-firing lookup: "does anyone have this token tracked", read on
    // every trigger post - this is the index that query depends on.
    c.telegramWatches.createIndex({ 'coins.chainId': 1, 'coins.tokenAddress': 1 }),
  ])
}

/** Throws if called before connectMongo(). */
export function getCollections(): Collections {
  if (!collections) throw new Error('MongoDB not connected - call connectMongo() first')
  return collections
}

export async function closeMongo(): Promise<void> {
  await client?.close()
  client = undefined
  db = undefined
  collections = undefined
}
