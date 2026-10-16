import type { Client } from 'discord.js'
import { config } from '../config.js'
import { MAX_BATCH } from '../market/dexscreener.js'
import { DEX_PAIRS_PER_MINUTE } from '../market/limiter.js'
import { closeCall, markCallAlerted, openCalls, openCallsFor } from '../db/calls.js'
import { listEnabledPushInstances, resolveFeature } from '../db/features.js'
import type { TokenCall } from '../db/models.js'
import { monitorAlertEmbed } from '../discord/embeds.js'
import {
  CALL_TRACKER,
  DIP_HUNTER,
  LEVEL_BREAK,
  MONITOR_FEATURES,
  PVP_COINS,
  TRENDING,
  VAMP_WATCH,
  VOLUME_SPIKES,
  WHALE_BUYS,
} from '../features/registry.js'
import { defaultSettings, readSettings, type FeatureDescriptor } from '../features/types.js'
import { pingFor } from '../discord/mentions.js'
import { sendTelegramAlert, telegramCallText, telegramMonitorText } from '../integrations/telegram-alerts.js'
import { log } from '../logger.js'
import { getHolderProfile } from '../risk/holders.js'
import { recentAlerts, recordAlert } from './cooldown.js'
import { armDip, disarmDip, loadArmedDips, noteDipLow } from './dips.js'
import { selectAlerts, tokenKey, type Candidate } from './detect/dedupe.js'
import type { Priority } from './detect/types.js'
import { passesGates, passesHolderGate, type QualityGates } from './detect/gates.js'
import {
  detectDrawdown,
  detectRecovery,
  type ArmedDip,
  type DipConfig,
} from './detect/drawdown.js'
import { buildAlertContext, type AlertContext } from './detect/context.js'
import { chartCardFor, ATTACHMENT_URL } from './chart-card.js'
import { notifyPersonalWatchers } from './personal-alerts.js'
import { callRetirement, detectCallSpike, type CallConfig } from './detect/call.js'
import { detectChurn, type ChurnConfig } from './detect/churn.js'
import { detectLevelBreak, type LevelConfig } from './detect/level.js'
import { detectMomentum, type MomentumConfig } from './detect/momentum.js'
import { detectSpike, type SpikeConfig } from './detect/spike.js'
import { detectVamp, type VampConfig } from './detect/vamp.js'
import { detectWhale, type WhaleConfig } from './detect/whale.js'
import type { Reading, Trigger } from './detect/types.js'
import { historyKey, loadHistories, recordSnapshots } from './history.js'
import { EvmStream, evmStreamChains } from './providers/evm-stream.js'
import { ProviderRegistry } from './providers/registry.js'
import { SolanaStream } from './providers/solana-stream.js'
import { TickerSearch } from './providers/ticker-search.js'
import { applyStreamedPrice, baseIsUsable, type StreamedPrice } from './providers/streamed-snapshot.js'
import type { MarketSnapshot, TokenRef, WhaleSwap } from './providers/types.js'
import { StatusReporter } from './status.js'
import {
  markPolled,
  pollBatch,
  removeCalledToken,
  retireDead,
  runDiscovery,
  toTokenRef,
} from './watchlist.js'

/** Ticks between auto-discovery sweeps. Discovery costs requests; alerts matter more. */
const DISCOVERY_EVERY_TICKS = 10

/**
 * Floor between detector runs for one token on the streamed path.
 *
 * The first swap after this window is judged immediately, so the alert is still
 * sub-second; what the floor prevents is the twentieth swap in the same second
 * paying for its own database round trip to reach the same verdict.
 */
const STREAM_EVAL_MIN_MS = 1_000

/** How far the price must move for a streamed reading to be worth storing. */
const STREAM_RECORD_MOVE = 0.02
/** Store at least this often anyway, so a flat stretch still leaves a trail. */
const STREAM_RECORD_MAX_GAP_MS = 30_000
/** Never write more often than this for one token, whatever it is doing. */
const STREAM_RECORD_FLOOR_MS = 3_000

/**
 * The running monitor, so `/monitor status` can report on it.
 *
 * Slash commands are registered as a static list with no access to the objects
 * `main()` builds, and threading a worker through the command table to reach one
 * read-only status command would be a lot of plumbing for one caller. Set in the
 * constructor rather than in `start()`, so a monitor disabled by config can
 * still say so instead of looking like it crashed.
 */
let active: VolumeMonitorWorker | undefined

export function activeMonitor(): VolumeMonitorWorker | undefined {
  return active
}

/** One configured destination: a channel, a feature, and that channel's settings. */
interface Destination {
  feature: FeatureDescriptor
  guildId: string
  channelId: string
  read: ReturnType<typeof readSettings>
}

interface MonitorCandidate extends Candidate {
  snapshot: MarketSnapshot
  /** Dip recovery replies to the drawdown message when we still have its id. */
  replyToMessageId?: string
  /** Present for whale alerts - the transaction the alert is about. */
  swap?: WhaleSwap
  /**
   * What the figures were, and what the pool did. Built once per token per
   * cycle rather than per destination: it is a fact about the token, and three
   * channels watching the same coin would otherwise rebuild it three times.
   */
  context?: AlertContext
}

/**
 * The volume monitor.
 *
 * One worker for every feature in `MONITOR_FEATURES`, deliberately. They share a
 * watchlist, a poll and a snapshot write, and running a worker each would
 * multiply the request cost to learn identical facts - against a rate limit that
 * is the binding constraint on how many tokens can be watched at all.
 *
 * Settings are read at the top of every cycle rather than cached, so an admin
 * changing a threshold affects the next alert rather than the next restart.
 */
export class VolumeMonitorWorker {
  private timer?: NodeJS.Timeout
  private running = false
  private stopped = false
  private ticks = 0
  private lastWhaleSweepAt = Date.now()

  /** Latest USD price per token, backing the providers' price lookup. */
  private readonly prices = new Map<string, number>()

  /**
   * The live half of the monitor.
   *
   * A streamed price is only half a snapshot - a swap event says nothing about
   * 24h volume or how old the pool is - so the last polled reading is kept per
   * token and the streamed price is laid over it. The poll therefore does not
   * become redundant when streaming arrives; it becomes the source of everything
   * a swap event cannot say.
   */
  private readonly streams = new Map<string, EvmStream>()
  private solanaStream?: SolanaStream
  private readonly lastSnapshots = new Map<string, MarketSnapshot>()
  private readonly lastStreamEvalAt = new Map<string, number>()
  private readonly lastRecordedAt = new Map<string, { at: number; priceUsd: number }>()

  /**
   * Tokens on the watchlist because something put them there rather than
   * somebody - a call, or discovery. Their baseline is measured differently:
   * both arrive *because* the token is moving, so the ordinary baseline is taken
   * mid-move and the token has to beat its own pump to register.
   */
  private autoAdded = new Set<string>()

  /**
   * Destinations from the last cycle, so a streamed update does not re-query
   * Mongo on every swap. Settings are still no more than one cycle stale, which
   * is the same guarantee the polled path gives.
   */
  private destinations: Destination[] = []

  private readonly registry: ProviderRegistry
  private readonly status: StatusReporter

  /**
   * Other tokens trading under the watchlist's tickers.
   *
   * The one part of the monitor that costs requests beyond the poll, so it is
   * filled only while a channel is running Vamp Watch, on a budget, and read
   * from cache everywhere else - including the streamed path, which must never
   * fan out to the network on a swap event.
   */
  private readonly tickers = new TickerSearch()

  constructor(private readonly client: Client) {
    this.registry = new ProviderRegistry((chainId, tokenAddress) =>
      this.prices.get(historyKey(chainId, tokenAddress)),
    )
    this.status = new StatusReporter(client)
    active = this
  }

  /** Cycles completed since startup, shown by `/monitor status`. */
  get cycles(): number {
    return this.ticks
  }

  start(): void {
    if (!config.MONITOR_ENABLED) {
      log.monitor.info('volume monitor disabled by config')
      return
    }

    log.monitor.info(
      {
        everySeconds: config.MONITOR_POLL_SECONDS,
        maxTokens: config.MONITOR_MAX_TOKENS,
        sustainableTokens: sustainableTokens(),
        whaleChains: this.registry.whaleCapableChains(),
      },
      'volume monitor started',
    )

    for (const chainId of evmStreamChains()) {
      this.streams.set(
        chainId,
        new EvmStream(chainId, (chain, tokenAddress, update) =>
          void this.onStreamedPrice(chain, tokenAddress, update),
        ),
      )
    }
    const solana = new SolanaStream((chain, tokenAddress, update) =>
      void this.onStreamedPrice(chain, tokenAddress, update),
    )
    if (solana.streaming) this.solanaStream = solana

    const streaming = [...this.streams.keys(), ...(this.solanaStream ? ['solana'] : [])]
    if (streaming.length > 0) {
      log.monitor.info({ chains: streaming }, 'price streaming enabled')
    }

    this.timer = setInterval(() => void this.tick(), config.MONITOR_POLL_SECONDS * 1_000)
    // Let the gateway settle before the first sweep, as the other workers do.
    setTimeout(() => void this.firstTick(), 15_000)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    for (const stream of this.streams.values()) stream.close()
    this.solanaStream?.close()
  }

  private async firstTick(): Promise<void> {
    await this.status.reportCapabilities(this.registry.health())
    await this.tick()
  }

  async tick(): Promise<void> {
    if (this.running || this.stopped) return
    this.running = true
    this.ticks += 1

    try {
      const watched = await pollBatch()
      if (watched.length === 0) {
        log.monitor.debug('watchlist is empty - add tokens with /watch add')
        return
      }

      /*
       * A short interval buys latency until the watchlist grows into it. Over
       * budget the limiter queues rather than fails, so cycles quietly overrun
       * and the monitor looks healthy while running late - worth saying out
       * loud, but not every cycle.
       */
      const sustainable = sustainableTokens()
      if (watched.length > sustainable && this.ticks % 10 === 1) {
        log.monitor.warn(
          {
            watched: watched.length,
            sustainable,
            everySeconds: config.MONITOR_POLL_SECONDS,
            requestsPerMinute: Math.round(
              (watched.length * POOLS_PER_TOKEN * 60) / (MAX_BATCH * config.MONITOR_POLL_SECONDS),
            ),
          },
          'watchlist is larger than this poll interval can sustain - raise MONITOR_POLL_SECONDS or watch fewer tokens',
        )
      }

      const destinations = await this.loadDestinations()
      this.destinations = destinations

      /*
       * Polling is worth paying for in two situations, and this is the second
       * one.
       *
       * The obvious case is a channel having the feature switched on. The less
       * obvious one is somebody having deliberately run `/watch add`: momentum
       * is differenced from stored readings, so a watchlist that only starts
       * recording the moment a feature is enabled cannot report a trend for the
       * first three windows of its life. Warming it costs one request per token
       * per cycle and means the first alert after switching on is a real one.
       *
       * Auto-discovered tokens do not count. Growing a list nobody reads, and
       * then paying to poll it forever, is exactly the spend worth refusing.
       */
      const wanted = watched.some((t) => t.source === 'manual')
      if (destinations.length === 0 && !wanted) return

      this.autoAdded = new Set(
        watched
          .filter((token) => token.source !== 'manual')
          .map((token) => historyKey(token.chainId, token.tokenAddress)),
      )

      const tokens = watched.map(toTokenRef)
      const snapshots = await this.collectSnapshots(tokens)
      if (snapshots.length > 0) await recordSnapshots(snapshots)

      for (const snapshot of snapshots) {
        const key = historyKey(snapshot.chainId, snapshot.tokenAddress)
        this.lastSnapshots.set(key, snapshot)
        this.lastRecordedAt.set(key, { at: snapshot.fetchedAt, priceUsd: snapshot.priceUsd ?? 0 })
      }

      await this.syncStreams(tokens, snapshots)

      if (destinations.length > 0) {
        const histories = await loadHistories(snapshots)
        const swaps = await this.collectWhaleSwaps(tokens, destinations)
        await this.evaluate(destinations, snapshots, histories, swaps)
      } else if (this.ticks % 10 === 1) {
        log.monitor.info(
          { tokens: watched.length },
          'recording history only - no channel has a monitor feature enabled yet',
        )
      }

      // Independent of the destination list: a call is followed because somebody
      // made it, not because a channel switched a push feature on.
      await this.followCalls(snapshots)

      await this.maintain(tokens, destinations.length > 0)
    } catch (err) {
      log.monitor.error({ err }, 'volume monitor tick failed')
    } finally {
      this.running = false
    }
  }

  /** Every enabled channel across all three features and all guilds. */
  private async loadDestinations(): Promise<Destination[]> {
    const out: Destination[] = []

    for (const feature of MONITOR_FEATURES) {
      const instances = await listEnabledPushInstances(feature.id)
      for (const instance of instances) {
        if (!instance.channelId) continue
        const settings = { ...defaultSettings(feature), ...instance.settings }
        out.push({
          feature,
          guildId: instance.guildId,
          channelId: instance.channelId,
          read: readSettings(settings),
        })
      }
    }

    return out
  }

  /** One pass over every chain that has watched tokens, in parallel. */
  private async collectSnapshots(tokens: TokenRef[]): Promise<MarketSnapshot[]> {
    const byChain = new Map<string, TokenRef[]>()
    for (const token of tokens) {
      const list = byChain.get(token.chainId)
      if (list) list.push(token)
      else byChain.set(token.chainId, [token])
    }

    const results = await Promise.all(
      [...byChain.entries()].map(async ([chainId, chainTokens]) => {
        const provider = this.registry.get(chainId)
        // A chain with no provider is a chain nothing can be read from; its
        // tokens simply produce no snapshot rather than failing the cycle.
        if (!provider) return []
        return provider.getSnapshots(chainTokens)
      }),
    )

    const snapshots = results.flat()

    for (const snapshot of snapshots) {
      if (snapshot.priceUsd !== undefined && snapshot.priceUsd > 0) {
        this.prices.set(historyKey(snapshot.chainId, snapshot.tokenAddress), snapshot.priceUsd)
      }
    }

    const answered = new Set(snapshots.map((s) => historyKey(s.chainId, s.tokenAddress)))
    const failed = tokens.filter((t) => !answered.has(historyKey(t.chainId, t.tokenAddress)))
    await markPolled(
      tokens.filter((t) => answered.has(historyKey(t.chainId, t.tokenAddress))),
      failed,
    )

    return snapshots
  }

  /**
   * Whale swaps since the last sweep.
   *
   * Asked for at the *lowest* threshold any channel wants, so one sweep serves
   * every destination and each one filters up from there. Skipped entirely when
   * no channel is running whale alerts.
   */
  private async collectWhaleSwaps(
    tokens: TokenRef[],
    destinations: Destination[],
  ): Promise<WhaleSwap[]> {
    const whaleDestinations = destinations.filter((d) => d.feature.id === WHALE_BUYS.id)
    if (whaleDestinations.length === 0) return []

    const minUsd = Math.min(...whaleDestinations.map((d) => d.read.num('minUsd', 10_000)))
    const since = this.lastWhaleSweepAt
    this.lastWhaleSweepAt = Date.now()

    const chains = new Set(tokens.map((t) => t.chainId))

    const results = await Promise.all(
      [...chains].map(async (chainId) => {
        const provider = this.registry.get(chainId)
        if (!provider?.getRecentWhaleSwaps) return []
        return provider.getRecentWhaleSwaps(tokens, since, minUsd)
      }),
    )

    return results.flat()
  }

  /** Runs the detectors for every destination and posts what survives. */
  private async evaluate(
    destinations: Destination[],
    snapshots: MarketSnapshot[],
    histories: Map<string, Reading[]>,
    swaps: WhaleSwap[],
  ): Promise<void> {
    const byToken = new Map(snapshots.map((s) => [historyKey(s.chainId, s.tokenAddress), s]))

    const contexts = new Map<string, AlertContext>()
    for (const snapshot of snapshots) {
      const key = historyKey(snapshot.chainId, snapshot.tokenAddress)
      contexts.set(key, buildAlertContext(snapshot, histories.get(key) ?? [], swaps))
    }

    // Paid for once per cycle rather than once per destination, and only when
    // somewhere is actually running the feature - the same rule the whale sweep
    // follows, for the same reason: it is the only other thing here that costs
    // requests nothing else has already spent.
    if (destinations.some((d) => d.feature.id === VAMP_WATCH.id)) {
      await this.tickers.prefetch(snapshots)
    }

    for (const destination of destinations) {
      const gates = gatesFrom(destination.read)
      const candidates: MonitorCandidate[] = []

      if (destination.feature.id === WHALE_BUYS.id) {
        const whaleConfig = whaleConfigFrom(destination.read)

        for (const swap of swaps) {
          const snapshot = byToken.get(historyKey(swap.chainId, swap.tokenAddress))
          if (!snapshot) continue
          if (!passesGates(snapshot, gates, snapshot.fetchedAt).ok) continue

          const trigger = detectWhale(swap, whaleConfig)
          if (trigger) {
            candidates.push({
              tokenKey: tokenKey(swap.chainId, swap.tokenAddress),
              trigger,
              snapshot,
              swap,
              context: contexts.get(historyKey(swap.chainId, swap.tokenAddress)),
            })
          }
        }
      } else {
        const armed =
          destination.feature.id === DIP_HUNTER.id
            ? await loadArmedDips(destination.channelId)
            : undefined

        for (const snapshot of snapshots) {
          const history = histories.get(historyKey(snapshot.chainId, snapshot.tokenAddress)) ?? []
          const candidate = await this.candidateFor(destination, snapshot, history, gates, armed)
          if (candidate) {
            candidates.push({
              ...candidate,
              context: contexts.get(historyKey(snapshot.chainId, snapshot.tokenAddress)),
            })
          }
        }
      }

      if (candidates.length === 0) continue
      await this.postCandidates(destination, candidates)
    }
  }

  /**
   * Runs whichever detector this destination's feature owns, for one token.
   *
   * Shared by the polled sweep and the streamed path so a price arriving over a
   * websocket is judged by exactly the same rules as one that arrived over
   * HTTP - the alternative is two subtly different definitions of a spike.
   * Whale alerts are absent on purpose: they are about a transaction rather than
   * a price, so they have nothing to say about a snapshot.
   */
  private async candidateFor(
    destination: Destination,
    snapshot: MarketSnapshot,
    history: Reading[],
    gates: QualityGates,
    armed: Map<string, ArmedDip> | undefined,
  ): Promise<MonitorCandidate | undefined> {
    if (!passesGates(snapshot, gates, snapshot.fetchedAt).ok) return undefined

    const key = tokenKey(snapshot.chainId, snapshot.tokenAddress)

    if (destination.feature.id === DIP_HUNTER.id) {
      const dipConfig = dipConfigFrom(destination.read)
      const state = armed?.get(key)

      if (!state) {
        const trigger = detectDrawdown(snapshot, history, dipConfig)
        return trigger ? { tokenKey: key, trigger, snapshot } : undefined
      }

      // The bottom is tracked while the follow-up waits, so the recovery alert
      // can report how far off the low it actually came.
      const price = snapshot.priceUsd
      if (price !== undefined && price > 0 && price < state.lowPriceUsd) {
        state.lowPriceUsd = price
        const lowMcap = snapshot.marketCapUsd
        if (lowMcap !== undefined && Number.isFinite(lowMcap) && lowMcap > 0) {
          state.lowMarketCapUsd = lowMcap
        } else {
          delete state.lowMarketCapUsd
        }
        await noteDipLow(
          destination.channelId,
          snapshot.chainId,
          snapshot.tokenAddress,
          price,
          state.lowMarketCapUsd,
        )
      }

      const trigger = detectRecovery(snapshot, state, dipConfig)
      return trigger
        ? {
            tokenKey: key,
            trigger,
            snapshot,
            ...(state.alertMessageId ? { replyToMessageId: state.alertMessageId } : {}),
          }
        : undefined
    }

    const trigger = this.triggerFor(destination, snapshot, history)
    return trigger ? { tokenKey: key, trigger, snapshot } : undefined
  }

  /** The one detector this destination's feature owns. */
  private triggerFor(
    destination: Destination,
    snapshot: MarketSnapshot,
    history: Reading[],
  ): Trigger | undefined {
    switch (destination.feature.id) {
      case VOLUME_SPIKES.id:
        return detectSpike(
          snapshot,
          history,
          spikeConfigFrom(
            destination.read,
            this.autoAdded.has(historyKey(snapshot.chainId, snapshot.tokenAddress)),
          ),
        )

      case TRENDING.id:
        return detectMomentum(snapshot, history, momentumConfigFrom(destination.read))

      case LEVEL_BREAK.id:
        return detectLevelBreak(snapshot, history, levelConfigFrom(destination.read))

      case PVP_COINS.id:
        return detectChurn(snapshot, churnConfigFrom(destination.read))

      case VAMP_WATCH.id:
        // Read from cache, never fetched here: this runs per destination and on
        // every streamed swap, and a network call in either would multiply the
        // one request the prefetch already budgeted for. An unfilled ticker
        // simply has no rivals yet, which produces no alert rather than a wrong
        // one.
        return detectVamp(
          snapshot,
          this.tickers.rivals(snapshot.symbol),
          vampConfigFrom(destination.read),
        )

      default:
        return undefined
    }
  }

  /**
   * Follows up on every open call.
   *
   * Runs whether or not any push feature is switched on, because a call is
   * followed on the strength of somebody having made it. Settings are read per
   * channel and cached for the sweep, since a busy channel's calls all share
   * one configuration.
   */
  private async followCalls(snapshots: MarketSnapshot[]): Promise<void> {
    let calls
    try {
      calls = await openCalls()
    } catch (err) {
      log.monitor.warn({ err: String(err) }, 'could not read open calls')
      return
    }
    if (calls.length === 0) return

    const byToken = new Map(snapshots.map((s) => [historyKey(s.chainId, s.tokenAddress), s]))
    const configs = new Map<string, CallConfig | undefined>()

    for (const call of calls) {
      const scope = `${call.guildId}:${call.channelId}`
      if (!configs.has(scope)) configs.set(scope, await this.callConfigFor(call.guildId, call.channelId))

      const config = configs.get(scope)
      // The feature being switched off mid-follow closes the call quietly: the
      // channel asked to stop hearing about this, and a watchlist slot held for
      // a follow-up nobody wants is a slot wasted.
      if (!config) {
        await this.closeCallAndMaybeRetire(call, 'call tracking switched off')
        continue
      }

      const snapshot = byToken.get(historyKey(call.chainId, call.tokenAddress))
      await this.judgeCall(call, snapshot, config)
    }
  }

  /** The same follow-up for one token, off the back of a streamed price. */
  private async followCallsForToken(snapshot: MarketSnapshot): Promise<void> {
    let calls
    try {
      calls = await openCallsFor(snapshot.chainId, snapshot.tokenAddress)
    } catch {
      return
    }

    for (const call of calls) {
      const config = await this.callConfigFor(call.guildId, call.channelId)
      if (!config) continue
      await this.judgeCall(call, snapshot, config)
    }
  }

  /** Announces a call that ran, or retires one that did not. */
  private async judgeCall(
    call: TokenCall,
    snapshot: MarketSnapshot | undefined,
    config: CallConfig,
  ): Promise<void> {
    const state = {
      priceAtCall: call.priceAtCall,
      calledAt: call.calledAt.getTime(),
      alerted: call.alerted,
    }

    if (snapshot) {
      const trigger = detectCallSpike(snapshot, state, config)
      if (trigger) {
        const posted = await this.postCallSpike(call, snapshot, trigger)
        if (posted && call._id) {
          await markCallAlerted(call._id, trigger.threshold)
          // Kept locally too, so a second streamed price in the same second does
          // not re-announce the multiple before the write is read back.
          call.alerted.push(trigger.threshold)
        }
        return
      }
    }

    const retirement = callRetirement(snapshot, state, config, Date.now())
    if (retirement.retire) {
      await this.closeCallAndMaybeRetire(call, retirement.reason ?? 'went nowhere')
    }
  }

  /**
   * Posts the follow-up back where the call was made.
   *
   * The mention is listed explicitly rather than left to Discord's parser, the
   * same as the monitor's own pings: the message can only ever tag the person
   * recorded against the call.
   */
  private async postCallSpike(
    call: TokenCall,
    snapshot: MarketSnapshot,
    trigger: Trigger,
  ): Promise<boolean> {
    try {
      const channel = await this.client.channels.fetch(call.channelId)
      if (!channel?.isSendable()) return false

      // Loaded here rather than threaded down: a call follow-up fires rarely,
      // so one query on the way out costs less than carrying history through
      // every judgement that decides to stay quiet.
      const histories = await loadHistories([
        { chainId: snapshot.chainId, tokenAddress: snapshot.tokenAddress },
      ])
      const context = buildAlertContext(
        snapshot,
        histories.get(historyKey(snapshot.chainId, snapshot.tokenAddress)) ?? [],
      )

      // Read from the calling channel's own Call Tracker config, so a channel
      // that turned charts off does not get one on the follow-up either.
      const callFeature = await resolveFeature(CALL_TRACKER.id, call.guildId, call.channelId)
      const card = (callFeature?.read.bool('includeChart', true) ?? true)
        ? await chartCardFor(CALL_TRACKER.id, trigger, snapshot, { subline: context.divergence })
        : undefined
      const embed = monitorAlertEmbed(trigger, snapshot, context)
      if (card) embed.setImage(ATTACHMENT_URL)

      /*
       * The caller is pinged by name and the channel's roles alongside them, so
       * "who hears about a call paying off" is one setting rather than two
       * rules. A call with no known caller still pings the roles - the alert is
       * no less true for nobody having claimed it.
       */
      const callPing = callFeature
        ? pingFor(callFeature.read, {
            extraUserIds: call.callerId ? [call.callerId] : [],
          })
        : undefined

      await channel.send({
        ...(callPing
          ? {
              content: call.callerId ? `${callPing.content} your call is up` : callPing.content,
              allowedMentions: callPing.allowed,
            }
          : {}),
        embeds: [embed],
        ...(card ? { files: [card.attachment] } : {}),
      })

      // Call spikes are always high priority (see detect/call.ts) - checked
      // anyway rather than assumed, the same as the volume monitor's own post.
      const callTelegramText = telegramCallText(call, snapshot, trigger)
      if (trigger.priority === 'high') {
        void sendTelegramAlert(callTelegramText)
      }
      // Personal "My Alerts" watchers, independent of priority - a coin
      // someone chose to track is worth knowing about at any grade. Same
      // text as the bot-wide send above, so a personal alert never carries
      // less detail than the one it stands in for.
      void notifyPersonalWatchers(trigger, snapshot, context, callTelegramText)

      log.monitor.info(
        {
          symbol: call.symbol,
          multiple: trigger.value,
          channelId: call.channelId,
          caller: call.callerId ?? 'unattributed',
        },
        'call follow-up posted',
      )
      return true
    } catch (err) {
      log.monitor.warn({ err: String(err), token: call.tokenAddress }, 'could not post call follow-up')
      return false
    }
  }

  /** Closes a call, and frees the watchlist slot if nothing else wants it. */
  private async closeCallAndMaybeRetire(call: TokenCall, reason: string): Promise<void> {
    if (call._id) await closeCall(call._id, reason)

    // Another channel may still be following the same coin, and a token added
    // by hand or by discovery is not ours to remove at all - `removeCalledToken`
    // enforces the second, this checks the first.
    const others = await openCallsFor(call.chainId, call.tokenAddress)
    if (others.length > 0) return

    const removed = await removeCalledToken(call.chainId, call.tokenAddress)
    log.monitor.info(
      { symbol: call.symbol, reason, removedFromWatchlist: removed },
      'call closed',
    )
  }

  /** Call Tracker settings for a channel, or undefined when it is switched off. */
  private async callConfigFor(guildId: string, channelId: string): Promise<CallConfig | undefined> {
    const resolved = await resolveFeature(CALL_TRACKER.id, guildId, channelId)
    if (!resolved?.enabled) return undefined

    return {
      alertMultiples: resolved.read
        .list('alertMultiples', ['1.5', '2', '5'])
        .map(Number)
        .filter((m) => Number.isFinite(m) && m > 1),
      watchMinutes: resolved.read.num('watchMinutes', 10),
      minMarketCapUsd: resolved.read.num('minMarketCapUsd', 20_000),
      stuckMinutes: resolved.read.num('stuckMinutes', 5),
      volumeFloors: resolved.read.bands('volumeFloors', [{ upTo: null, value: 1_000 }]),
    }
  }

  /** Points each chain's websocket at the current watchlist and re-anchors USD. */
  private async syncStreams(tokens: TokenRef[], snapshots: MarketSnapshot[]): Promise<void> {
    if (this.solanaStream) {
      try {
        await this.solanaStream.sync(tokens)
        for (const snapshot of snapshots) {
          if (snapshot.chainId !== 'solana' || snapshot.priceUsd === undefined) continue
          this.solanaStream.calibrate(snapshot.tokenAddress, snapshot.priceUsd)
        }
      } catch (err) {
        log.monitor.warn({ err: String(err) }, 'solana stream sync failed')
      }
    }

    if (this.streams.size === 0) return

    for (const provider of this.registry.evm()) {
      const stream = this.streams.get(provider.chainId)
      if (!stream?.streaming) continue

      try {
        const layouts = await provider.poolLayouts(tokens)
        await stream.sync(tokens, layouts)

        // Every poll re-anchors the dollar conversion, so the USD figure a
        // streamed price carries is the aggregator's own number moved by our
        // ratio rather than a valuation of our own.
        for (const snapshot of snapshots) {
          if (snapshot.chainId !== provider.chainId || snapshot.priceUsd === undefined) continue
          stream.calibrate(snapshot.pairAddress, snapshot.priceUsd)
        }
      } catch (err) {
        log.monitor.warn({ err: String(err), chain: provider.chainId }, 'stream sync failed')
      }
    }
  }

  /**
   * A price straight off the chain.
   *
   * Laid over the last polled reading, recorded when it says something new, and
   * judged immediately - subject to a short floor between evaluations, because a
   * busy pool emits several swaps a second and the detectors would otherwise run
   * a database query per trade to re-answer a question that cannot have changed.
   */
  private async onStreamedPrice(
    chainId: string,
    tokenAddress: string,
    update: StreamedPrice,
  ): Promise<void> {
    if (this.stopped) return

    const key = historyKey(chainId, tokenAddress)
    const base = this.lastSnapshots.get(key)

    // Without a recent poll behind it, an overlay would pair a live price with
    // liquidity and volume figures that may no longer describe the same token.
    if (!base || !baseIsUsable(base, update.at)) return

    const snapshot = applyStreamedPrice(base, update)
    this.lastSnapshots.set(key, snapshot)
    this.prices.set(key, update.priceUsd)

    await this.recordIfNotable(key, snapshot)

    const lastEval = this.lastStreamEvalAt.get(key) ?? 0
    if (update.at - lastEval < STREAM_EVAL_MIN_MS) return
    this.lastStreamEvalAt.set(key, update.at)

    try {
      await this.evaluateStreamed(snapshot)
      await this.followCallsForToken(snapshot)
    } catch (err) {
      log.monitor.warn({ err: String(err), token: key }, 'streamed evaluation failed')
    }
  }

  /**
   * Writes a streamed reading into the history the detectors read back.
   *
   * Not every one: a busy token would write hundreds of rows a minute to say the
   * price barely moved. Recording on a real move is what makes the difference
   * that streaming is for - a peak that happens between two polls used to be
   * invisible, so a drawdown was measured from the highest price we *sampled*
   * rather than the highest price that traded.
   */
  private async recordIfNotable(key: string, snapshot: MarketSnapshot): Promise<void> {
    const price = snapshot.priceUsd
    if (price === undefined || price <= 0) return

    const last = this.lastRecordedAt.get(key)
    const sinceMs = last ? snapshot.fetchedAt - last.at : Infinity
    if (sinceMs < STREAM_RECORD_FLOOR_MS) return

    const moved =
      last && last.priceUsd > 0 ? Math.abs(price / last.priceUsd - 1) >= STREAM_RECORD_MOVE : true

    if (!moved && sinceMs < STREAM_RECORD_MAX_GAP_MS) return

    this.lastRecordedAt.set(key, { at: snapshot.fetchedAt, priceUsd: price })
    await recordSnapshots([snapshot])
  }

  /** Runs the detectors for one streamed token against last cycle's destinations. */
  private async evaluateStreamed(snapshot: MarketSnapshot): Promise<void> {
    const relevant = this.destinations.filter((d) => d.feature.id !== WHALE_BUYS.id)
    if (relevant.length === 0) return

    const histories = await loadHistories([
      { chainId: snapshot.chainId, tokenAddress: snapshot.tokenAddress },
    ])
    const history = histories.get(historyKey(snapshot.chainId, snapshot.tokenAddress)) ?? []

    for (const destination of relevant) {
      const armed =
        destination.feature.id === DIP_HUNTER.id
          ? await loadArmedDips(destination.channelId)
          : undefined

      const candidate = await this.candidateFor(
        destination,
        snapshot,
        history,
        gatesFrom(destination.read),
        armed,
      )
      if (candidate) {
        await this.postCandidates(destination, [
          { ...candidate, context: buildAlertContext(snapshot, history) },
        ])
      }
    }
  }

  private async postCandidates(
    destination: Destination,
    candidates: MonitorCandidate[],
  ): Promise<void> {
    let recent
    try {
      recent = await recentAlerts(destination.channelId, destination.feature.id)
    } catch {
      // Without history there is no way to honour a cooldown, and posting
      // everything again is the one outcome worse than posting nothing.
      return
    }

    /*
     * A recovery is the second half of an alert this channel has already had,
     * so it goes out regardless of cooldown or hourly cap. Suppressing it would
     * leave a dip alert standing with no answer, which is worse than one extra
     * message - and it cannot run away, because at most one exists per dip
     * already posted.
     */
    const followUps = candidates.filter((c) => c.trigger.kind === 'recovery')
    const fresh = candidates.filter((c) => c.trigger.kind !== 'recovery')

    const { posting, dropped } = selectAlerts(fresh, recent, {
      cooldownMinutes: destination.read.num('cooldownMinutes', 120),
      maxAlertsPerHour: destination.read.num('maxAlertsPerHour', 12),
    })

    if (dropped.length > 0) {
      log.monitor.debug(
        {
          channelId: destination.channelId,
          feature: destination.feature.id,
          dropped: dropped.map((d) => `${d.candidate.tokenKey}: ${d.reason}`),
        },
        'suppressed alerts',
      )
    }

    for (const candidate of followUps) {
      // The holder gate was already paid for when the dip alert went out.
      await this.post(destination, candidate)
    }

    for (const candidate of posting) {
      if (!(await this.passesHolders(destination, candidate))) continue
      await this.post(destination, candidate)
    }
  }

  /**
   * The holder-count gate, applied only to alerts that already won a slot.
   *
   * Done here rather than with the cheap gates because it costs a vendor
   * request. Checking it against the whole watchlist would mean a hundred
   * lookups a minute to reject tokens that were never going to alert anyway.
   */
  private async passesHolders(
    destination: Destination,
    candidate: MonitorCandidate,
  ): Promise<boolean> {
    const minHolders = destination.read.num('minHolders', 0)
    if (minHolders <= 0) return true

    const profile = await getHolderProfile(
      candidate.snapshot.chainId,
      candidate.snapshot.tokenAddress,
    )
    const result = passesHolderGate(profile.totalHolders, minHolders)

    if (!result.ok) {
      log.monitor.debug(
        { token: candidate.tokenKey, reason: result.reason },
        'alert dropped on holder gate',
      )
    }
    return result.ok
  }

  /**
   * Opens or closes the follow-up for a dip alert that has just been posted.
   * `armedForMinutes` is read here rather than at arm-design time so an admin
   * lengthening the wait affects dips announced from now on.
   */
  private async settleDip(
    destination: Destination,
    candidate: MonitorCandidate,
    messageId: string | undefined,
  ): Promise<void> {
    const { snapshot, trigger } = candidate

    if (trigger.kind === 'recovery') {
      await disarmDip(destination.channelId, snapshot.chainId, snapshot.tokenAddress)
      return
    }

    const price = snapshot.priceUsd
    if (price === undefined || price <= 0) return

    const mcap = snapshot.marketCapUsd
    await armDip({
      guildId: destination.guildId,
      channelId: destination.channelId,
      chainId: snapshot.chainId,
      tokenAddress: snapshot.tokenAddress,
      symbol: snapshot.symbol,
      alertPriceUsd: price,
      ...(mcap !== undefined && Number.isFinite(mcap) && mcap > 0 ? { alertMarketCapUsd: mcap } : {}),
      armedForMinutes: destination.read.num('armedForMinutes', 360),
      ...(messageId ? { alertMessageId: messageId } : {}),
    })
  }

  private async post(destination: Destination, candidate: MonitorCandidate): Promise<void> {
    const { snapshot, trigger, swap, context } = candidate

    try {
      const channel = await this.client.channels.fetch(destination.channelId)
      if (!channel?.isSendable()) {
        log.monitor.warn(
          { channelId: destination.channelId, feature: destination.feature.id },
          'monitor channel not writable',
        )
        return
      }

      const ping = pingFor(destination.read, { priority: trigger.priority })

      // Built before the embed so the image can be referenced, and never allowed
      // to cost the alert: no chart just means no chart.
      const card = destination.read.bool('includeChart', true)
        ? await chartCardFor(destination.feature.id, trigger, snapshot, {
            subline: context?.divergence,
          })
        : undefined
      const embed = monitorAlertEmbed(trigger, snapshot, context, swap)
      if (card) embed.setImage(ATTACHMENT_URL)

      const sent = await channel.send({
        ...(ping ? { content: ping.content, allowedMentions: ping.allowed } : {}),
        // A deleted dip message must not cost the recovery. Discord then posts
        // it on its own instead of failing the send.
        ...(candidate.replyToMessageId
          ? { reply: { messageReference: candidate.replyToMessageId, failIfNotExists: false } }
          : {}),
        embeds: [embed],
        ...(card ? { files: [card.attachment] } : {}),
      })

      // Fired in parallel, never awaited - same rule as signal-intake.ts: a
      // Telegram outage must never cost or delay the alert it accompanies.
      const monitorTelegramText = telegramMonitorText(trigger, snapshot, context)
      if (trigger.priority === 'high') {
        void sendTelegramAlert(monitorTelegramText)
      }
      // Personal "My Alerts" watchers, independent of priority - a coin
      // someone chose to track is worth knowing about at any grade. Same
      // text as the bot-wide send above, so a personal alert never carries
      // less detail than the one it stands in for.
      void notifyPersonalWatchers(trigger, snapshot, context, monitorTelegramText)

      // Recorded only after a successful send, so a failed post does not start
      // a cooldown on news nobody heard.
      await recordAlert({
        guildId: destination.guildId,
        channelId: destination.channelId,
        featureId: destination.feature.id,
        chainId: snapshot.chainId,
        tokenAddress: snapshot.tokenAddress,
        symbol: snapshot.symbol,
        trigger: trigger.headline,
        priority: trigger.priority,
      })

      // Arming after the send, for the same reason the cooldown is: a dip
      // nobody was told about must not produce a recovery alert.
      if (destination.feature.id === DIP_HUNTER.id) {
        await this.settleDip(destination, candidate, sent.id)
      }

      log.monitor.info(
        {
          feature: destination.feature.id,
          channelId: destination.channelId,
          symbol: snapshot.symbol,
          chain: snapshot.chainId,
          trigger: trigger.headline,
        },
        'monitor alert posted',
      )
    } catch (err) {
      log.monitor.warn(
        { err: String(err), channelId: destination.channelId, token: candidate.tokenKey },
        'failed to post monitor alert',
      )
    }
  }

  /** Subscriptions, discovery and health, none of which block alerting. */
  private async maintain(tokens: TokenRef[], alerting: boolean): Promise<void> {
    for (const provider of this.registry.all()) {
      if (provider.syncSubscriptions) await provider.syncSubscriptions(tokens)
    }

    if (this.ticks % DISCOVERY_EVERY_TICKS === 1) {
      await retireDead()
      // Only grow the watchlist while something is actually reading it.
      // Discovery on an unread watchlist adds tokens, which adds polling, which
      // buys nothing until a channel is switched on.
      if (alerting) await runDiscovery(this.registry)
    }

    await this.status.report(this.registry.health())
  }

  /** Provider health, for `/monitor status`. */
  healthReport() {
    return this.registry.health()
  }

  /**
   * How much of the watchlist's tickers have been searched, for
   * `/monitor status`. The honest answer to "why is Vamp Watch quiet": on a long
   * watchlist most tickers are simply waiting their turn at four a cycle.
   */
  tickerStats() {
    return this.tickers.stats()
  }

  /**
   * Hands a Helius delivery to the Solana provider. Returns how many swaps were
   * queued, which is what the webhook route reports back.
   */
  ingestHeliusPayload(payload: unknown): number {
    const solana = this.registry.solana()
    if (!solana) return 0
    return solana.ingest(payload)
  }

  /** The URL Helius should be pointed at, for `/monitor status` and the README. */
  heliusWebhookUrl(): string | undefined {
    return this.registry.solana()?.webhookUrl()
  }
}

/**
 * Pools an average watched token trades in.
 *
 * Measured, not assumed: on the live watchlist, 15 Solana tokens took 5 batched
 * requests and 11 Robinhood-chain tokens took 5, which puts both between eight
 * and thirteen pools each. Memecoins list on a lot of small pools and
 * `trustedPairs` keeps them, because it filters on price agreement rather than
 * size - they contribute little volume but they are still real trades.
 *
 * Only used to size the warning below, so being wrong costs an early or late
 * warning rather than a wrong request. Guessing low is the dangerous direction:
 * it would let the watchlist grow past what the interval can actually poll.
 */
const POOLS_PER_TOKEN = 10

/**
 * How many tokens this interval can poll without eating the whole DexScreener
 * budget. Capped at 60% of it, because price alerts and the coin tracker draw on
 * the same bucket and starving them to feed the monitor is not a trade anyone
 * asked for.
 *
 * A token no longer costs a request per poll. `fetchSnapshots` re-reads known
 * pools in batches of `MAX_BATCH`, so the marginal cost of watching one more
 * token is a *fraction* of a request - roughly its pool count over thirty -
 * plus the per-chain pool-set discoveries, which are capped per cycle and so
 * do not grow with the watchlist at all.
 */
export function sustainableTokens(
  everySeconds = config.MONITOR_POLL_SECONDS,
  budgetShare = 0.6,
): number {
  const perMinute = DEX_PAIRS_PER_MINUTE * budgetShare
  const pollsPerMinute = 60 / everySeconds
  const requestsPerToken = POOLS_PER_TOKEN / MAX_BATCH

  return Math.max(1, Math.floor(perMinute / (pollsPerMinute * requestsPerToken)))
}

function gatesFrom(read: ReturnType<typeof readSettings>): QualityGates {
  return {
    minLiquidityUsd: read.num('minLiquidityUsd', 50_000),
    minPairAgeMinutes: read.num('minPairAgeMinutes', 1_440),
    minTxns5m: read.num('minTxns5m', 0),
    minVolume24hUsd: read.num('minVolume24hUsd', 50_000),
    chains: read.list('chains'),
  }
}

function spikeConfigFrom(
  read: ReturnType<typeof readSettings>,
  excludeCurrentWindow = false,
): SpikeConfig {
  return {
    multiplier: read.num('multiplier', 5),
    minVolume5mUsd: read.num('minVolume5mUsd', 15_000),
    highPriorityMultiplier: read.num('highPriorityMultiplier', 12),
    // 'both' preserves what every existing channel already does - a direction
    // filter that switched itself on would silently stop alerts nobody asked to
    // stop.
    direction: read.str('direction', 'both') === 'up' ? 'up' : 'both',
    excludeCurrentWindow,
  }
}

function momentumConfigFrom(read: ReturnType<typeof readSettings>): MomentumConfig {
  return {
    windows: read.num('windows', 3),
    windowMinutes: read.num('windowMinutes', 15),
    minPriceGainPct: read.num('minPriceGainPct', 5),
    minVolumeGainPct: read.num('minVolumeGainPct', 20),
    highPriorityPriceGainPct: read.num('highPriorityPriceGainPct', 25),
  }
}

function levelConfigFrom(read: ReturnType<typeof readSettings>): LevelConfig {
  return {
    bufferPct: read.num('bufferPct', 1),
    onFall: read.bool('onFall', true),
    onRise: read.bool('onRise', true),
    highPriorityPct: read.num('highPriorityPct', 15),
    maxLookbackMinutes: read.num('maxLookbackMinutes', 30),
  }
}

function dipConfigFrom(read: ReturnType<typeof readSettings>): DipConfig {
  return {
    drawdownPct: read.num('drawdownPct', 50),
    highWindowMinutes: read.num('highWindowMinutes', 180),
    recoveryPct: read.num('recoveryPct', 10),
    minCoverageMinutes: read.num('minCoverageMinutes', 45),
    highPriorityDrawdownPct: read.num('highPriorityDrawdownPct', 70),
  }
}

function churnConfigFrom(read: ReturnType<typeof readSettings>): ChurnConfig {
  return {
    minTurnover: read.num('minTurnover', 3),
    maxImbalancePct: read.num('maxImbalancePct', 15),
    maxPriceChangePct: read.num('maxPriceChangePct', 5),
    minVolume1hUsd: read.num('minVolume1hUsd', 50_000),
    highPriorityTurnover: read.num('highPriorityTurnover', 8),
  }
}

function vampConfigFrom(read: ReturnType<typeof readSettings>): VampConfig {
  const target = read.str('target', 'both')

  return {
    target: target === 'original' || target === 'copycat' ? target : 'both',
    minVolumeRatio: read.num('minVolumeRatio', 1.5),
    minCopycatVolume1hUsd: read.num('minCopycatVolume1hUsd', 50_000),
    minCopycatLiquidityUsd: read.num('minCopycatLiquidityUsd', 25_000),
    minCopycatTrades1h: read.num('minCopycatTrades1h', 100),
    maxCopycatAgeMinutes: read.num('maxCopycatAgeMinutes', 1_440),
    highPriorityRatio: read.num('highPriorityRatio', 3),
  }
}

function whaleConfigFrom(read: ReturnType<typeof readSettings>): WhaleConfig {
  return {
    minUsd: read.num('minUsd', 10_000),
    highPriorityUsd: read.num('highPriorityUsd', 50_000),
    buysOnly: read.bool('buysOnly', true),
  }
}
