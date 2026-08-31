import { config } from '../config.js'
import type { WatchedToken } from '../db/models.js'
import { getCollections } from '../db/mongo.js'
import { log } from '../logger.js'
import type { MarketSnapshot, TokenRef } from './providers/types.js'
import type { ProviderRegistry } from './providers/registry.js'

/**
 * The set of tokens the monitor polls.
 *
 * Kept small on purpose. Every token on it costs one DexScreener request per
 * cycle out of a budget shared with the rest of the bot, so the watchlist is
 * capped rather than allowed to grow, and auto-discovery only ever fills the
 * space manual entries have not taken.
 */

/** Discovered tokens must be at least this real before they earn a slot. */
const DISCOVERY_MIN_LIQUIDITY_USD = 50_000
const DISCOVERY_MIN_VOLUME_24H_USD = 100_000

/**
 * How long a discovered token keeps its slot without being re-discovered. Long
 * enough to see a full day's cycle, short enough that yesterday's boosted
 * listings are not still occupying the budget tomorrow.
 */
const DISCOVERY_TTL_MS = 24 * 60 * 60_000

/** New candidates measured per cycle. Each costs a request, so it is bounded. */
const DISCOVERY_BATCH = 8

/** Consecutive failed polls before a token is treated as dead. */
const MAX_ERRORS = 10

export function toTokenRef(token: WatchedToken): TokenRef {
  return {
    chainId: token.chainId,
    tokenAddress: token.tokenAddress,
    pairAddress: token.pairAddress,
    symbol: token.symbol,
  }
}

/**
 * The tokens to poll this cycle, least recently polled first.
 *
 * Ordering matters once the watchlist is at its cap: a list longer than the
 * budget degrades into everything being covered a little less often, rather than
 * into the same first hundred being covered and the rest never.
 */
export async function pollBatch(limit = config.MONITOR_MAX_TOKENS): Promise<WatchedToken[]> {
  const { watchedTokens } = getCollections()
  return watchedTokens.find({}).sort({ lastPolledAt: 1 }).limit(limit).toArray()
}

export async function listAll(): Promise<WatchedToken[]> {
  const { watchedTokens } = getCollections()
  return watchedTokens.find({}).sort({ source: 1, symbol: 1 }).toArray()
}

export async function countTokens(): Promise<number> {
  const { watchedTokens } = getCollections()
  return watchedTokens.countDocuments({})
}

export interface AddResult {
  ok: boolean
  /** Set when the token was already there. */
  existing?: boolean
  reason?: string
  token?: WatchedToken
}

/**
 * Adds a token by hand.
 *
 * A manual add outranks a discovered one: adding a token that discovery already
 * found promotes it, clearing the expiry so it stops being temporary.
 */
export async function addToken(
  snapshot: MarketSnapshot,
  addedBy: string,
  guildId: string,
): Promise<AddResult> {
  const { watchedTokens } = getCollections()

  const filter = { chainId: snapshot.chainId, tokenAddress: snapshot.tokenAddress }
  const existing = await watchedTokens.findOne(filter)

  if (existing?.source === 'manual') {
    return { ok: true, existing: true, token: existing }
  }

  if (!existing) {
    const total = await countTokens()
    if (total >= config.MONITOR_MAX_TOKENS) {
      // Evicting somebody else's token to make room would be a surprise. Say no.
      const evictable = await watchedTokens.countDocuments({ source: 'discovered' })
      return {
        ok: false,
        reason:
          evictable > 0
            ? `The watchlist is full (${total}/${config.MONITOR_MAX_TOKENS}). ${evictable} slots are held by auto-discovered tokens, which expire within 24h, or remove one with \`/watch remove\`.`
            : `The watchlist is full (${total}/${config.MONITOR_MAX_TOKENS}). Remove a token with \`/watch remove\` first.`,
      }
    }
  }

  await watchedTokens.updateOne(
    filter,
    {
      $set: {
        pairAddress: snapshot.pairAddress,
        symbol: snapshot.symbol,
        name: snapshot.name,
        source: 'manual',
        addedBy,
        guildId,
        errorCount: 0,
      },
      // Manual entries never expire, so any inherited expiry has to go.
      $unset: { expiresAt: '' },
      $setOnInsert: { ...filter, addedAt: new Date() },
    },
    { upsert: true },
  )

  const token = await watchedTokens.findOne(filter)
  return { ok: true, existing: Boolean(existing), token: token ?? undefined }
}

/**
 * Adds a token because somebody called it.
 *
 * Ranked below both other sources: a called token that is already watched by
 * hand or by discovery keeps whatever it was, because those outlive a call. It
 * carries a short expiry so that even if the follow-up sweep never runs - a
 * crash, a restart mid-window - the watchlist still empties itself rather than
 * filling up with coins nobody is following any more.
 */
export async function addCalledToken(
  snapshot: MarketSnapshot,
  guildId: string,
  watchMinutes: number,
): Promise<AddResult> {
  const { watchedTokens } = getCollections()

  const filter = { chainId: snapshot.chainId, tokenAddress: snapshot.tokenAddress }
  const existing = await watchedTokens.findOne(filter)
  if (existing) return { ok: true, existing: true, token: existing }

  const total = await countTokens()
  if (total >= config.MONITOR_MAX_TOKENS) {
    // Silently evicting somebody's token to follow a call would be a surprise,
    // and the call is the lower-value claim on the slot.
    return {
      ok: false,
      reason: `watchlist is full (${total}/${config.MONITOR_MAX_TOKENS})`,
    }
  }

  const expiresAt = new Date(Date.now() + Math.max(2, watchMinutes) * 60_000)

  await watchedTokens.insertOne({
    ...filter,
    pairAddress: snapshot.pairAddress,
    symbol: snapshot.symbol,
    name: snapshot.name,
    source: 'called',
    guildId,
    addedAt: new Date(),
    errorCount: 0,
    expiresAt,
  })

  const token = await watchedTokens.findOne(filter)
  return { ok: true, token: token ?? undefined }
}

/**
 * Drops a token that is only being watched because of a call.
 *
 * Guarded on `source` so a follow-up finishing never removes a coin somebody
 * added by hand, or one discovery is still interested in.
 */
export async function removeCalledToken(chainId: string, tokenAddress: string): Promise<boolean> {
  const { watchedTokens } = getCollections()
  const result = await watchedTokens.deleteOne({ chainId, tokenAddress, source: 'called' })
  return result.deletedCount === 1
}

export async function removeToken(chainId: string, tokenAddress: string): Promise<boolean> {
  const { watchedTokens } = getCollections()
  const result = await watchedTokens.deleteOne({ chainId, tokenAddress })
  return result.deletedCount === 1
}

/** Records that a token was polled, and whether the poll worked. */
export async function markPolled(succeeded: TokenRef[], failed: TokenRef[]): Promise<void> {
  const { watchedTokens } = getCollections()
  const now = new Date()

  const writes = []

  if (succeeded.length > 0) {
    writes.push(
      watchedTokens.updateMany(
        { $or: succeeded.map((t) => ({ chainId: t.chainId, tokenAddress: t.tokenAddress })) },
        { $set: { lastPolledAt: now, errorCount: 0 } },
      ),
    )
  }

  if (failed.length > 0) {
    writes.push(
      watchedTokens.updateMany(
        { $or: failed.map((t) => ({ chainId: t.chainId, tokenAddress: t.tokenAddress })) },
        { $set: { lastPolledAt: now }, $inc: { errorCount: 1 } },
      ),
    )
  }

  await Promise.all(writes)
}

/**
 * Drops discovered tokens that have stopped answering.
 *
 * Manual entries are kept however badly they behave - somebody asked for that
 * token, and quietly removing it would leave them believing it is still watched.
 * They show their error count in `/watch list` instead.
 */
export async function retireDead(): Promise<number> {
  const { watchedTokens } = getCollections()
  const result = await watchedTokens.deleteMany({
    source: 'discovered',
    errorCount: { $gte: MAX_ERRORS },
  })

  if (result.deletedCount > 0) {
    log.monitor.info({ count: result.deletedCount }, 'retired unresponsive discovered tokens')
  }
  return result.deletedCount
}

/**
 * Fills spare watchlist capacity from the providers' discovery feeds.
 *
 * The feed itself is paid placement rather than a ranking, so nothing is trusted
 * because it appeared there - each candidate is measured, and only liquidity and
 * real 24h volume decide whether it earns a slot.
 */
export async function runDiscovery(registry: ProviderRegistry): Promise<number> {
  const { watchedTokens } = getCollections()

  const room = config.MONITOR_MAX_TOKENS - (await countTokens())
  if (room <= 0) return 0

  const candidates: TokenRef[] = []
  for (const provider of registry.all()) {
    if (!provider.discover) continue
    try {
      candidates.push(...(await provider.discover()))
    } catch (err) {
      log.monitor.debug({ err: String(err), chain: provider.chainId }, 'discovery failed')
    }
  }

  if (candidates.length === 0) return 0

  // Anything already on the list is not a candidate.
  const known = new Set(
    (await watchedTokens.find({}).project<{ chainId: string; tokenAddress: string }>({ chainId: 1, tokenAddress: 1 }).toArray()).map(
      (t) => `${t.chainId}:${t.tokenAddress.toLowerCase()}`,
    ),
  )

  const fresh = candidates
    .filter((c) => !known.has(`${c.chainId}:${c.tokenAddress.toLowerCase()}`))
    .slice(0, Math.min(DISCOVERY_BATCH, room))

  if (fresh.length === 0) return 0

  let added = 0
  const expiresAt = new Date(Date.now() + DISCOVERY_TTL_MS)

  for (const candidate of fresh) {
    const provider = registry.get(candidate.chainId)
    if (!provider) continue

    const [snapshot] = await provider.getSnapshots([candidate])
    if (!snapshot) continue

    if ((snapshot.liquidityUsd ?? 0) < DISCOVERY_MIN_LIQUIDITY_USD) continue
    if ((snapshot.volume.h24 ?? 0) < DISCOVERY_MIN_VOLUME_24H_USD) continue

    await watchedTokens.updateOne(
      { chainId: snapshot.chainId, tokenAddress: snapshot.tokenAddress },
      {
        $set: {
          pairAddress: snapshot.pairAddress,
          symbol: snapshot.symbol,
          name: snapshot.name,
          expiresAt,
        },
        $setOnInsert: {
          chainId: snapshot.chainId,
          tokenAddress: snapshot.tokenAddress,
          source: 'discovered',
          addedAt: new Date(),
          errorCount: 0,
        },
      },
      { upsert: true },
    )
    added += 1
  }

  if (added > 0) log.monitor.info({ added, considered: fresh.length }, 'discovery added tokens')
  return added
}
