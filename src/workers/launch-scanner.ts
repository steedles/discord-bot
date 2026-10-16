import type { Client } from 'discord.js'
import { config } from '../config.js'
import { listEnabledPushInstances } from '../db/features.js'
import type { FeatureInstance, RugCheck } from '../db/models.js'
import { getCollections } from '../db/mongo.js'
import { launchEmbed } from '../discord/embeds.js'
import { pingFor } from '../discord/mentions.js'
import { LAUNCH_SCANNER } from '../features/registry.js'
import { defaultSettings, readSettings } from '../features/types.js'
import { sendLaunchSignal, signalIntakeEnabled } from '../integrations/signal-intake.js'
import { log } from '../logger.js'
import { isSupportedChain } from '../market/chains.js'
import {
  getLatestTokenProfiles,
  getTopPairPerToken,
  MAX_BATCH,
  hasSocials,
  pairAgeMinutes,
  type DexPair,
} from '../market/dexscreener.js'
import { PumpPortalWatcher } from '../market/pumpportal.js'
import { passesHolderGate } from '../monitor/detect/gates.js'
import { assessToken } from '../risk/assess.js'
import { getHolderProfile } from '../risk/holders.js'
import type { RiskReport } from '../risk/index.js'
import { checkRugSignature } from '../risk/rugSignature.js'

/** Liquidity a pump.fun mint must reach before we call it a graduation. */
const GRADUATION_LIQUIDITY_USD = 10_000
/**
 * Pending pump.fun mints checked per cycle. One batched request covers the lot,
 * so this is DexScreener's per-request address cap rather than a rate budget -
 * asking for more would silently drop the overflow.
 */
const PENDING_BATCH = MAX_BATCH
/** Recently-processed tokens, so the profile feed is not re-fetched every cycle. */
const RECENT_CACHE_MAX = 5_000

/**
 * Cheap pre-filters for the rug-signature check (docs/11-RUG-SIGNATURE.md §4),
 * run on pending (pre-graduation) mints before any RPC call is spent. The
 * doc's ">90% held by the pool account" filter is not applied here - that
 * describes a token's *terminal* state, and `getHolderProfile` already strips
 * pool/AMM accounts out of the wallet list it returns, so the signal is not
 * cleanly available at this pre-graduation hook point. Holder count is doing
 * similar work: a coin with very few holders is definitionally thin.
 *
 * The liquidity floor here is deliberately **below** both graduation
 * ($10k) and any destination's own `minLiquidityUsd` (default $15k) - the
 * check now costs ~1 minute median (v2 §5), not 15-20, so there is no reason
 * to wait until a mint is already alert-worthy to start it. Triggering
 * earlier means a verdict is cached well before a coin reaches the
 * parameters that would actually post an alert, rather than racing it.
 * Pool age is widened past the doc's own §4 pre-filter for the same reason:
 * v2 §9 open question 6 notes RugCheck's holder set may lag a minutes-old
 * coin, so a mint that returns `unknown` on its first attempt (never cached -
 * see checkRugSignature) needs room to be retried on a later cycle rather
 * than aging out before its data has settled.
 */
const RUG_CHECK_MIN_LIQUIDITY_USD = 2_500
const RUG_CHECK_MAX_POOL_AGE_MINUTES = 6
const RUG_CHECK_MAX_HOLDERS = 500
/**
 * v2 (§5) measures 22-75s wall clock per check, not v1's 15-20 minutes - most
 * of that one shared, rate-limited RPC bucket (see SOLANA_RPC_CALLS_PER_MINUTE).
 * Kept modest rather than raised to match: a candidate that doesn't get a slot
 * this cycle is simply tried again next cycle, still well inside the ~6-minute
 * deploy-to-alert gap the doc measures.
 */
const MAX_CONCURRENT_RUG_CHECKS = 2

type LaunchSource = 'dexscreener' | 'pumpfun'

/** A single configured destination: one channel, with its own filters. */
interface Destination {
  instance: FeatureInstance
  guildId: string
  channelId: string
  read: ReturnType<typeof readSettings>
}

export class LaunchScannerWorker {
  private timer?: NodeJS.Timeout
  private watcher?: PumpPortalWatcher
  private running = false
  private stopped = false
  private readonly recentlyProcessed = new Set<string>()
  /** Posts made per destination in the current cycle. Reset at the top of every tick. */
  private readonly postCounts = new Map<string, number>()
  /** Mints currently mid rug-check, so a slow one is not started twice. */
  private readonly rugChecksInFlight = new Set<string>()
  private ticks = 0

  constructor(private readonly client: Client) {}

  start(): void {
    log.scanner.info({ everySeconds: config.LAUNCH_POLL_SECONDS }, 'launch scanner started')

    if (signalIntakeEnabled()) {
      log.scanner.info(
        { url: config.SIGNAL_INTAKE_URL, chains: config.SIGNAL_INTAKE_CHAINS },
        'signal intake armed - launches will also be posted to the trading intake',
      )
    }

    this.timer = setInterval(() => void this.tick(), config.LAUNCH_POLL_SECONDS * 1_000)
    setTimeout(() => void this.tick(), 10_000)

    if (config.ENABLE_PUMPPORTAL) {
      this.watcher = new PumpPortalWatcher((token) => void this.queuePumpMint(token))
      this.watcher.start()
    } else {
      log.scanner.info('pump.fun watcher disabled by config')
    }
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.watcher?.stop()
  }

  async tick(): Promise<void> {
    if (this.running || this.stopped) return
    this.running = true
    this.postCounts.clear()
    this.ticks++

    try {
      const destinations = await this.loadDestinations()
      if (destinations.length === 0) return

      await this.scanTokenProfiles(destinations)

      // Only pay for the pending-mint sweep if some channel actually wants it.
      const wantsPumpfun = destinations.some((d) => d.read.list('sources').includes('pumpfun'))
      if (config.ENABLE_PUMPPORTAL && wantsPumpfun) await this.scanPendingMints(destinations)
    } catch (err) {
      log.scanner.error({ err }, 'launch scanner tick failed')
    } finally {
      this.running = false
    }
  }

  /** Every enabled scanner instance across every guild becomes one destination. */
  private async loadDestinations(): Promise<Destination[]> {
    const instances = await listEnabledPushInstances(LAUNCH_SCANNER.id)

    return instances.flatMap((instance) => {
      if (!instance.channelId) return []
      const settings = { ...defaultSettings(LAUNCH_SCANNER), ...instance.settings }
      return [
        {
          instance,
          guildId: instance.guildId,
          channelId: instance.channelId,
          read: readSettings(settings),
        },
      ]
    })
  }

  /** Source A: DexScreener's latest token profiles, across every supported chain. */
  private async scanTokenProfiles(destinations: Destination[]): Promise<void> {
    const interested = destinations.filter((d) => d.read.list('sources').includes('dexscreener'))
    if (interested.length === 0) return

    /*
     * A refused discovery feed is not a failed cycle.
     *
     * This endpoint is refused far below its documented 60/minute - the scanner
     * asks once every 45 seconds and still gets turned away - and letting that
     * throw aborted the whole tick, so a source that works (the pump.fun sweep
     * below) stopped running because a source that does not had a bad minute.
     * The two sources are independent and are now allowed to fail that way.
     */
    let profiles: Awaited<ReturnType<typeof getLatestTokenProfiles>>
    try {
      profiles = await getLatestTokenProfiles()
    } catch (err) {
      log.scanner.warn({ err: String(err) }, 'token profile feed unavailable this cycle')
      return
    }

    const fresh = profiles
      .filter((p) => isSupportedChain(p.chainId))
      .filter((p) => !this.recentlyProcessed.has(cacheKey(p.chainId, p.tokenAddress)))

    if (fresh.length === 0) return
    for (const p of fresh) this.remember(cacheKey(p.chainId, p.tokenAddress))

    // Batched per chain, because the chain is in the path. A profile feed run
    // costs a handful of requests rather than one per listed token.
    const byChain = new Map<string, string[]>()
    for (const p of fresh) {
      const list = byChain.get(p.chainId)
      if (list) list.push(p.tokenAddress)
      else byChain.set(p.chainId, [p.tokenAddress])
    }

    const candidates: DexPair[] = []
    for (const [chainId, addresses] of byChain) {
      const top = await getTopPairPerToken(chainId, addresses)
      candidates.push(...top.values())
    }

    log.scanner.debug(
      { profiles: profiles.length, fresh: fresh.length, chains: byChain.size, candidates: candidates.length },
      'profile feed',
    )

    for (const pair of candidates) {
      await this.considerLaunch(pair, 'dexscreener', interested)
    }
  }

  /** Source B: pump.fun mints heard on the websocket that have since hit a DEX. */
  private async scanPendingMints(destinations: Destination[]): Promise<void> {
    const interested = destinations.filter((d) => d.read.list('sources').includes('pumpfun'))
    if (interested.length === 0) return

    const { pendingMints } = getCollections()

    const batch = await pendingMints
      .find({})
      .sort({ checkedAt: 1, firstSeenAt: 1 })
      .limit(PENDING_BATCH)
      .toArray()

    if (batch.length === 0) return

    // Every pending mint is a pump.fun token, so the whole batch is one chain
    // and one request. The question here is only "has it hit a DEX with real
    // liquidity yet", which the top pool answers on its own.
    const bySolanaToken = await getTopPairPerToken('solana', batch.map((m) => m.mint))

    const graduated: string[] = []

    for (const pending of batch) {
      const pair = bySolanaToken.get(pending.mint.toLowerCase())
      if (!pair) continue

      // Checked pre-graduation on purpose - the funding graph the check reads
      // is already complete by the time a mint is this fresh, so the verdict
      // is ready well before the coin has any real chance of graduating into
      // an alert (see docs/11-RUG-SIGNATURE.md §5).
      if ((pair.liquidity?.usd ?? 0) < GRADUATION_LIQUIDITY_USD) {
        void this.maybeRugCheck(pair)
        continue
      }

      graduated.push(pending.mint)
      await this.considerLaunch(pair, 'pumpfun', interested)
    }

    const now = new Date()
    await pendingMints.updateMany(
      { mint: { $in: batch.map((m) => m.mint) } },
      { $set: { checkedAt: now }, $inc: { checks: 1 } },
    )
    if (graduated.length > 0) {
      await pendingMints.deleteMany({ mint: { $in: graduated } })
      log.scanner.info({ count: graduated.length }, 'pump.fun graduations detected')
    }
  }

  /**
   * Starts a rug-signature check for one pending mint, if it is worth the
   * ~75-80 RPC calls the check costs. Never awaited by the caller - a slow
   * check must not hold up the rest of the poll cycle, and its verdict only
   * needs to land before the mint might graduate, not before this tick ends.
   */
  private async maybeRugCheck(pair: DexPair): Promise<void> {
    if (!config.ENABLE_RUG_SIGNATURE_CHECK) return

    const mint = pair.baseToken.address
    if (this.rugChecksInFlight.size >= MAX_CONCURRENT_RUG_CHECKS) return
    if (this.rugChecksInFlight.has(mint)) return

    // A dedicated, lower floor - not tied to any destination's own filters.
    // See the constant's comment for why this fires ahead of alert-readiness
    // rather than waiting for it.
    if ((pair.liquidity?.usd ?? 0) < RUG_CHECK_MIN_LIQUIDITY_USD) return

    const ageMinutes = pairAgeMinutes(pair)
    if (ageMinutes === undefined || ageMinutes > RUG_CHECK_MAX_POOL_AGE_MINUTES) return

    let profile
    try {
      profile = await getHolderProfile('solana', mint)
    } catch (err) {
      log.scanner.debug({ err: String(err), mint }, 'rug check: holder profile unavailable, trying next cycle')
      return
    }
    if (profile.totalHolders !== undefined && profile.totalHolders >= RUG_CHECK_MAX_HOLDERS) return

    this.rugChecksInFlight.add(mint)
    checkRugSignature(mint)
      .then((result) => {
        if (result.verdict === 'flag') {
          log.scanner.info(
            {
              mint,
              symbol: pair.baseToken.symbol,
              funding: result.fundingVerdict,
              cohort: result.tightCohortSize,
              funder: result.funderWallet,
              distribution: result.distributionVerdict,
              distributionCv: result.distributionCv,
            },
            'rug signature flagged',
          )
        }
      })
      .catch((err) => log.scanner.warn({ err: String(err), mint }, 'rug check failed'))
      .finally(() => this.rugChecksInFlight.delete(mint))
  }

  private async queuePumpMint(token: { mint: string; name: string; symbol: string }): Promise<void> {
    try {
      const { pendingMints } = getCollections()
      await pendingMints.updateOne(
        { mint: token.mint },
        {
          $setOnInsert: {
            mint: token.mint,
            symbol: token.symbol,
            name: token.name,
            firstSeenAt: new Date(),
            checks: 0,
          },
        },
        { upsert: true },
      )
    } catch (err) {
      log.scanner.debug({ err: String(err), mint: token.mint }, 'could not queue pump mint')
    }
  }

  /**
   * Applies each destination's cheap filters first, and only pays for a risk
   * lookup if at least one channel would still be interested.
   */
  private async considerLaunch(
    pair: DexPair,
    source: LaunchSource,
    destinations: Destination[],
  ): Promise<void> {
    const interested = destinations.filter((d) => passesCheapFilters(pair, d))
    if (interested.length === 0) return

    let report: RiskReport
    try {
      report = await assessToken(pair)
    } catch (err) {
      log.scanner.debug({ err: String(err), token: pair.baseToken.address }, 'risk check failed, skipping')
      return
    }

    // An unknown score is not a pass - it means nobody could vouch for the token.
    if (report.level === 'unknown') return

    const wanted = interested.filter((d) => report.score <= d.read.num('maxRiskScore', 45))
    if (wanted.length === 0) return

    const cleared = await this.passingHolders(pair, wanted)

    // Solana only. Fetched unfiltered - whatever verdict is cached, if any,
    // including 'unknown' now that a checked-but-inconclusive attempt is
    // persisted too (see RugCheck in db/models.ts) - because the two
    // consumers below want different things from it: the signal intake can
    // tell "never checked", "checked, inconclusive" and "checked, clean"
    // apart and decide with that, while the Discord embed only ever shows a
    // positive flag (anything else must read as "nothing to show" there, not
    // "safe").
    const rugCheck =
      pair.chainId === 'solana'
        ? await getCollections().rugChecks.findOne({ chainId: 'solana', mint: pair.baseToken.address })
        : null

    /*
     * Signalled in parallel with the Discord post, never after it.
     *
     * The intake refuses a signal older than 120 seconds by the time its worker
     * reaches it, and posting to several channels is several round trips to
     * Discord - so waiting for them would spend the window on work the intake
     * does not care about. Fired once however many channels hear about it, and
     * never awaited: this must not be able to slow or fail a scan cycle.
     */
    void sendLaunchSignal(pair, report, rugCheck)

    if (cleared.length === 0) return

    for (const destination of cleared) {
      await this.postToDestination(destination, pair, report, source, rugCheck)
    }
  }

  /**
   * Holder gate, after every cheap filter and the risk score.
   *
   * One lookup for the token, then each channel applies its own floor. Channels
   * with the floor off are not waiting on the vendor. A missing count fails a
   * channel that asked for one: unknown is not "few enough to ignore".
   */
  private async passingHolders(pair: DexPair, destinations: Destination[]): Promise<Destination[]> {
    if (!destinations.some((d) => d.read.num('minHolders', 0) > 0)) return destinations

    let holders: number | undefined
    try {
      holders = (await getHolderProfile(pair.chainId, pair.baseToken.address)).totalHolders
    } catch (err) {
      log.scanner.debug(
        { err: String(err), token: pair.baseToken.address },
        'holder count unavailable',
      )
    }

    return destinations.filter((d) => {
      const result = passesHolderGate(holders, d.read.num('minHolders', 0))
      if (!result.ok) {
        log.scanner.debug(
          { token: pair.baseToken.address, channelId: d.channelId, reason: result.reason },
          'launch dropped on holder gate',
        )
      }
      return result.ok
    })
  }

  private async postToDestination(
    destination: Destination,
    pair: DexPair,
    report: RiskReport,
    source: LaunchSource,
    rugCheck: RugCheck | null,
  ): Promise<void> {
    const key = `${destination.guildId}:${destination.channelId}`
    const postedThisCycle = this.postCounts.get(key) ?? 0
    if (postedThisCycle >= destination.read.num('maxPostsPerCycle', 5)) return

    const { seenTokens } = getCollections()

    // The unique index is the dedupe: a duplicate insert throws and we bail.
    // Scoped per channel, so two channels with different filters both get a
    // shot at the same token.
    const seenKey = {
      guildId: destination.guildId,
      channelId: destination.channelId,
      chainId: pair.chainId,
      tokenAddress: pair.baseToken.address,
    }

    try {
      await seenTokens.insertOne({
        ...seenKey,
        postedAt: new Date(),
        symbol: pair.baseToken.symbol,
        pairAddress: pair.pairAddress,
      })
    } catch {
      return
    }

    try {
      const channel = await this.client.channels.fetch(destination.channelId)
      if (!channel?.isSendable()) {
        log.scanner.warn(
          { guildId: destination.guildId, channelId: destination.channelId },
          'scanner channel not writable',
        )
        return
      }

      // A launch has no priority grade, so `pingOn` is not consulted: the
      // configured roles hear about every post or none.
      const ping = pingFor(destination.read)
      await channel.send({
        ...(ping ? { content: ping.content, allowedMentions: ping.allowed } : {}),
        embeds: [launchEmbed(pair, report, source, rugCheck?.verdict === 'flag' ? rugCheck : undefined)],
      })

      this.postCounts.set(key, postedThisCycle + 1)
      log.scanner.info(
        {
          guildId: destination.guildId,
          channelId: destination.channelId,
          symbol: pair.baseToken.symbol,
          chain: pair.chainId,
          source,
        },
        'launch posted',
      )
    } catch (err) {
      log.scanner.warn({ err, ...seenKey }, 'failed to post launch')
      // Undo the dedupe record so a transient send failure does not lose the token.
      await seenTokens.deleteOne(seenKey)
    }
  }

  private remember(key: string): void {
    if (this.recentlyProcessed.size >= RECENT_CACHE_MAX) {
      const oldest = this.recentlyProcessed.values().next().value
      if (oldest !== undefined) this.recentlyProcessed.delete(oldest)
    }
    this.recentlyProcessed.add(key)
  }
}

function passesCheapFilters(pair: DexPair, destination: Destination): boolean {
  const { read } = destination

  const chains = read.list('chains')
  if (chains.length > 0 && !chains.includes(pair.chainId)) return false
  if ((pair.liquidity?.usd ?? 0) < read.num('minLiquidityUsd', 15_000)) return false
  if ((pair.volume?.h24 ?? 0) < read.num('minVolume24hUsd', 25_000)) return false

  const maxMcap = read.num('maxMarketCapUsd', 0)
  if (maxMcap > 0) {
    const mcap = pair.marketCap ?? pair.fdv
    if (mcap === undefined || mcap > maxMcap) return false
  }

  if (read.bool('requireSocials', true) && !hasSocials(pair)) return false

  const age = pairAgeMinutes(pair)
  if (age === undefined || age > read.num('maxAgeMinutes', 720)) return false

  return true
}

const cacheKey = (chainId: string, address: string): string => `${chainId}:${address.toLowerCase()}`
