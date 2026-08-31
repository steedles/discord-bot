import type { ObjectId } from 'mongodb'
import type { Client } from 'discord.js'
import { DEFAULT_LOOKBACK, detectTurn, type TurnSignal } from '../analysis/trend.js'
import { config } from '../config.js'
import { resolveFeature, type ResolvedFeature } from '../db/features.js'
import type { CoinTracker } from '../db/models.js'
import { getCollections } from '../db/mongo.js'
import { noticeEmbed, trendTurnEmbed } from '../discord/embeds.js'
import { ATTACHMENT_URL, renderCard } from '../monitor/chart-card.js'
import { VIOLET } from '../analysis/chart.js'
import { COIN_TRACKER } from '../features/registry.js'
import { log } from '../logger.js'
import { getPairsForToken, selectPricePair } from '../market/dexscreener.js'
import { CandleRateLimitError, getMinuteCandles, type Candle } from '../market/geckoterminal.js'

/** Consecutive candle-fetch failures before a tracker is retired as dead. */
const MAX_ERRORS = 20

/**
 * Pools to read per tick.
 *
 * The candle feed allows roughly 30 requests a minute for the whole bot, and
 * this worker is not its only user. Trackers are swept least-recently-checked
 * first, so exceeding this delays a coin by a tick rather than starving it.
 */
const MAX_POOLS_PER_TICK = 15

/** Candle requests in flight at once. Politeness, not throughput. */
const FETCH_CONCURRENCY = 2

/**
 * Watches tracked coins on the one-minute chart and reports trend turns.
 *
 * Three rules keep this from becoming a spam machine, and all three are about
 * the same thing - a crossover is not an event, a *change* is:
 *
 *   1. A turn only fires in the opposite direction to the last one reported.
 *   2. Not within the cooldown, whatever the chart does.
 *   3. Not unless price has moved a set percentage since the last signal.
 *
 * Settings are read when a signal fires rather than when the tracker was made,
 * so an admin retuning the channel affects coins already being watched.
 */
export class CoinTrackerWorker {
  private timer?: NodeJS.Timeout
  private running = false
  private stopped = false

  constructor(private readonly client: Client) {}

  start(): void {
    const intervalMs = config.TRACK_POLL_SECONDS * 1_000
    log.tracker.info({ everySeconds: config.TRACK_POLL_SECONDS }, 'coin tracker worker started')

    this.timer = setInterval(() => void this.tick(), intervalMs)
    // Give Discord a moment to finish connecting before the first pass.
    setTimeout(() => void this.tick(), 8_000)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
  }

  /** Exposed for manual runs and tests. Skips if a previous tick is still going. */
  async tick(): Promise<void> {
    if (this.running || this.stopped) return
    this.running = true

    try {
      await this.sweep()
    } catch (err) {
      log.tracker.error({ err }, 'coin tracker tick failed')
    } finally {
      this.running = false
    }
  }

  private async sweep(): Promise<void> {
    const { coinTrackers } = getCollections()

    // Oldest-checked first: with more trackers than the budget allows, every
    // coin still gets its turn instead of the same few always winning.
    const due = await coinTrackers
      .find({ active: true })
      .sort({ lastCheckedAt: 1 })
      .limit(MAX_POOLS_PER_TICK * 4)
      .toArray()

    if (due.length === 0) return

    const byPool = new Map<string, CoinTracker[]>()
    for (const tracker of due) {
      const key = `${tracker.chainId}:${tracker.pairAddress.toLowerCase()}`
      const list = byPool.get(key)
      if (list) list.push(tracker)
      else byPool.set(key, [tracker])
    }

    const pools = [...byPool.values()]
    const selected = pools.slice(0, MAX_POOLS_PER_TICK)

    if (pools.length > selected.length) {
      // Never let a cap be invisible - a quiet coin and a skipped coin look
      // identical from the outside.
      log.tracker.warn(
        { pools: pools.length, checked: selected.length },
        'more tracked pools than one tick allows; the rest are next tick',
      )
    }

    // One resolveFeature per channel per tick rather than per tracker.
    const settings = new Map<string, ResolvedFeature | undefined>()

    let rateLimited = 0

    await mapWithConcurrency(selected, FETCH_CONCURRENCY, async (trackers) => {
      const first = trackers[0]!

      let candles: Candle[]
      try {
        candles = await getMinuteCandles(first.chainId, first.pairAddress)
      } catch (err) {
        if (err instanceof CandleRateLimitError) {
          // Deliberately no error count and no lastCheckedAt: the pool did
          // nothing wrong, and leaving it stale puts it first next tick.
          rateLimited += 1
          return
        }
        throw err
      }

      if (candles.length === 0) {
        await this.recordFailure(trackers.map((t) => t._id!))
        return
      }

      for (const tracker of trackers) {
        try {
          await this.evaluate(tracker, candles, settings)
        } catch (err) {
          log.tracker.warn({ err: String(err), symbol: tracker.symbol }, 'tracker evaluation failed')
        }
      }
    })

    if (rateLimited > 0) {
      log.tracker.warn(
        { pools: rateLimited, of: selected.length },
        'candle feed rate limited; those pools are re-read next tick',
      )
    }

    await this.retireDeadTrackers()
  }

  private async evaluate(
    tracker: CoinTracker,
    candles: Candle[],
    settings: Map<string, ResolvedFeature | undefined>,
  ): Promise<void> {
    const { coinTrackers } = getCollections()
    const now = new Date()

    const key = `${tracker.guildId}:${tracker.channelId}`
    if (!settings.has(key)) {
      settings.set(key, await resolveFeature(COIN_TRACKER.id, tracker.guildId, tracker.channelId))
    }
    const resolved = settings.get(key)

    await coinTrackers.updateOne(
      { _id: tracker._id! },
      { $set: { lastCheckedAt: now, errorCount: 0 } },
    )

    // Switched off after the tracker was created: stay quiet, stay alive. The
    // tracker resumes if the feature comes back on.
    if (resolved && !resolved.enabled) return

    const confirmations = resolved?.read.num('confirmations', 2) ?? 2
    const signal = detectTurn(candles, { confirmations, lookback: DEFAULT_LOOKBACK })
    if (!signal) return

    if (!this.isNews(tracker, signal, resolved, now)) return

    await coinTrackers.updateOne(
      { _id: tracker._id! },
      {
        $set: {
          lastDirection: signal.direction,
          lastSignalAt: now,
          lastSignalPrice: signal.price,
        },
        $inc: { signalCount: 1 },
      },
    )

    await this.announce(tracker, signal, resolved, candles)
  }

  /**
   * Whether this turn is worth a message, as opposed to the chart fidgeting.
   *
   * The same direction twice is never news: the trend did not turn, it
   * continued. That check comes first because it is the one that matters - the
   * cooldown and the move threshold only filter *how often* the story changes.
   */
  private isNews(
    tracker: CoinTracker,
    signal: TurnSignal,
    resolved: ResolvedFeature | undefined,
    now: Date,
  ): boolean {
    if (tracker.lastDirection === signal.direction) return false

    const cooldownMinutes = resolved?.read.num('cooldownMinutes', 15) ?? 15
    if (tracker.lastSignalAt) {
      const minutes = (now.getTime() - tracker.lastSignalAt.getTime()) / 60_000
      if (minutes < cooldownMinutes) return false
    }

    const minMovePct = resolved?.read.num('minMovePct', 1) ?? 1
    if (minMovePct > 0 && tracker.lastSignalPrice && tracker.lastSignalPrice > 0) {
      const movePct =
        (Math.abs(signal.price - tracker.lastSignalPrice) / tracker.lastSignalPrice) * 100
      if (movePct < minMovePct) return false
    }

    return true
  }

  private async announce(
    tracker: CoinTracker,
    signal: TurnSignal,
    resolved: ResolvedFeature | undefined,
    candles: Candle[],
  ): Promise<void> {
    // Market context is fetched only when something is actually being said.
    const pairs = await getPairsForToken(tracker.tokenAddress)
    const pair = selectPricePair(pairs, tracker.chainId)

    const minutesSinceLast = tracker.lastSignalAt
      ? (Date.now() - tracker.lastSignalAt.getTime()) / 60_000
      : undefined

    const embed = trendTurnEmbed(tracker, signal, pair, minutesSinceLast)
    const announce = resolved?.read.bool('announceToChannel', true) ?? true

    /*
     * The candles are already in hand - they are what the turn was detected
     * from - so this chart costs nothing against the candle budget. It is also
     * the one alert where the picture *is* the claim: "the trend turned" is a
     * statement about the shape of this series, and a reader can check it.
     */
    const wantsChart = resolved?.read.bool('includeChart', true) ?? true
    const card = wantsChart
      ? await renderCard({
          symbol: tracker.symbol,
          chainId: tracker.chainId,
          pairAddress: tracker.pairAddress,
          candles,
          seriesIsTheClaim: true,
          subline: `trend turned ${signal.direction}`,
          priceUsd: pair?.priceUsd ? Number(pair.priceUsd) : undefined,
          marketCapUsd: pair?.marketCap ?? pair?.fdv,
          rails:
            tracker.priceAtCreate > 0
              ? [{ value: tracker.priceAtCreate, colour: VIOLET, label: 'tracked from' }]
              : [],
        })
      : undefined

    if (card) embed.setImage(ATTACHMENT_URL)

    if (announce) {
      try {
        const channel = await this.client.channels.fetch(tracker.channelId)
        if (channel?.isSendable()) {
          await channel.send({
            content: `<@${tracker.userId}>`,
            embeds: [embed],
            ...(card ? { files: [card.attachment] } : {}),
          })
          log.tracker.info(
            {
              symbol: tracker.symbol,
              direction: signal.direction,
              signals: signal.agreeing.length,
              price: signal.price,
            },
            'trend turn announced',
          )
          return
        }
      } catch (err) {
        log.tracker.warn({ err, channelId: tracker.channelId }, 'could not post to tracker channel')
      }
    }

    // DM-only by config, or the channel is gone and we lost access.
    try {
      const user = await this.client.users.fetch(tracker.userId)
      await user.send({ embeds: [embed] })
      log.tracker.info({ symbol: tracker.symbol }, 'trend turn delivered by DM')
    } catch (err) {
      log.tracker.warn({ err, userId: tracker.userId }, 'trend turn could not be delivered')
    }
  }

  private async recordFailure(ids: ObjectId[]): Promise<void> {
    const { coinTrackers } = getCollections()
    await coinTrackers.updateMany(
      { _id: { $in: ids } },
      { $set: { lastCheckedAt: new Date() }, $inc: { errorCount: 1 } },
    )
  }

  private async retireDeadTrackers(): Promise<void> {
    const { coinTrackers } = getCollections()
    const dead = await coinTrackers.find({ active: true, errorCount: { $gte: MAX_ERRORS } }).toArray()
    if (dead.length === 0) return

    await coinTrackers.updateMany({ _id: { $in: dead.map((t) => t._id!) } }, { $set: { active: false } })
    log.tracker.warn({ count: dead.length }, 'retired trackers with no chart data')

    for (const tracker of dead) {
      try {
        const user = await this.client.users.fetch(tracker.userId)
        await user.send({
          embeds: [
            noticeEmbed(
              `Stopped tracking **${tracker.symbol}** - its pool has returned no chart data for a while. Re-add it with \`/track add\` if it comes back.`,
            ),
          ],
        })
      } catch {
        // DMs closed; the tracker is still retired.
      }
    }
  }
}

/** Runs `fn` over `items` with at most `limit` in flight. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++
        await fn(items[index]!)
      }
    }),
  )
}
