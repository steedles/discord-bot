import type { Filter } from 'mongodb'
import type { FomoAlert, FomoAlertTrade } from '../../db/models.js'
import { getCollections } from '../../db/mongo.js'
import { log } from '../../logger.js'
import { getPairsForToken } from '../../market/dexscreener.js'
import { fomoUrl } from '../../market/fomo.js'
import { axiomUrl } from '../../market/trade-links.js'
import { fomoStream } from './stream.js'
import type { FomoActivityEvent } from './types.js'

/**
 * Reading and writing the kept Fomo record.
 *
 * Separate from `fomo-watch.ts` because posting to Discord and keeping a
 * history are different jobs with different failure modes: a Discord outage
 * must not cost us the record, and a failed write must not stop the posting.
 * The worker calls in here and carries on whatever happens.
 */

/** Hard ceiling on any list query. A dashboard asking for everything gets a page. */
const MAX_LIMIT = 200
const DEFAULT_LIMIT = 100

/**
 * Drop keys whose value is `undefined`, in place.
 *
 * The MongoDB driver serialises an explicit `undefined` to BSON **null**, so
 * `{ thesis: undefined }` stores a claim that the thesis was measured and found
 * to be null - rather than leaving the field absent, which is what "this is a
 * buy, it has no thesis" actually means. The same trap is documented in
 * CLAUDE.md for the tracked-wallets import, and it bites identically here: a
 * buy stored `thesis: null, position: null` before this existed.
 *
 * It also costs disk, on the one box where disk is the binding constraint.
 */
function withoutUndefined<T extends object>(doc: T): T {
  for (const key of Object.keys(doc) as (keyof T)[]) {
    if (doc[key] === undefined) delete doc[key]
  }
  return doc
}

/**
 * Persist one accepted alert, and tell every attached tab about it.
 *
 * Called only after the worker's dedup claim has succeeded, so in the normal
 * case this insert cannot collide. It still tolerates a duplicate: the claim
 * and this write are two steps, and anything that can retry between them
 * eventually will.
 *
 * Returns the stored alert, or undefined when it was already there or the write
 * failed - callers treat all three the same way, which is to carry on.
 */
export async function recordAlert(event: FomoActivityEvent): Promise<FomoAlert | undefined> {
  const alert: FomoAlert = {
    eventId: event.eventId,
    tradeId: event.tradeId,
    kind: event.kind,

    traderId: event.traderId,
    traderHandle: event.traderHandle,
    traderName: event.traderName,
    traderVerified: event.traderVerified,

    chainId: event.chainId,
    networkId: event.networkId,
    tokenAddress: event.tokenAddress,
    ticker: event.ticker,

    usdAmount: event.usdAmount,
    price: event.price,
    marketCap: event.marketCap,
    fdv: event.fdv,

    thesis: event.thesis,
    position: event.position,

    createdAt: event.createdAt,
    receivedAt: event.receivedAt,

    // Only when we could not parse it. See the note on the model: the disk is
    // the constraint on this box, and a payload we understood adds nothing.
    raw: event.kind === 'UNKNOWN' ? event.raw : undefined,
  }

  try {
    // Absent, not null - see `withoutUndefined`. A BUY has no thesis; it does
    // not have a thesis that was measured as nothing.
    await getCollections().fomoAlerts.insertOne(withoutUndefined(alert))
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return undefined
    // Not fatal. The alert still reaches Discord and still reaches any tab
    // watching the stream - it just will not be there tomorrow.
    log.fomo.error({ err, eventId: event.eventId }, 'fomo alert write failed')
    return undefined
  }

  // With links, so a live row arrives ready to click rather than becoming
  // clickable only after the next reload. Axiom follows separately when it
  // resolves - see below.
  fomoStream.publish({ type: 'alert', alert: withLinks(alert) })

  // Deliberately not awaited. Resolving the pool is a DexScreener call against
  // a shared rate limit, and putting it in front of the Discord post would slow
  // down the one thing on this path that is supposed to be fast.
  void resolveAxiomPool(alert)

  return alert
}

/**
 * Find the PumpSwap pool behind a Solana alert, so an Axiom link can exist.
 *
 * Fomo sends a mint; Axiom's URL takes a pool. `market/trade-links.ts` refuses
 * to build the link from anything else, and this is the lookup that gives it
 * something it will accept. Anything that is not a Solana token on PumpSwap
 * resolves to nothing and gets no Axiom link, which is the documented and
 * intended outcome rather than a gap.
 *
 * Costs one DexScreener request per Solana alert - about one in eight of them,
 * measured over the first 46 - and never repeats for an alert already resolved.
 */
async function resolveAxiomPool(alert: FomoAlert): Promise<void> {
  if (alert.chainId !== 'solana' || !alert.tokenAddress) return

  try {
    const pairs = await getPairsForToken(alert.tokenAddress)
    // The pool Axiom understands, not merely the deepest one: a Raydium or
    // Meteora pool address is not something Axiom is known to accept.
    const pool = pairs.find(
      (p) => p.chainId === 'solana' && p.dexId?.toLowerCase() === 'pumpswap',
    )
    if (!pool) return

    await getCollections().fomoAlerts.updateOne(
      { eventId: alert.eventId },
      { $set: { pairAddress: pool.pairAddress, dexId: pool.dexId } },
    )

    const url = axiomUrl('solana', pool.dexId, pool.pairAddress)
    if (url) fomoStream.publish({ type: 'links', eventId: alert.eventId, axiomUrl: url })
  } catch (err) {
    // A missing link is a cosmetic loss. It must never cost the alert.
    log.fomo.debug({ err, eventId: alert.eventId }, 'axiom pool lookup failed')
  }
}

/** An alert as the dashboard sees it: the stored row plus its outbound links. */
export type FomoAlertWithLinks = FomoAlert & {
  fomoUrl?: string
  axiomUrl?: string
}

/**
 * Attach the venue links to a stored alert.
 *
 * Computed on read rather than stored, so the day a slug changes the fix is one
 * file and not a backfill. Both builders are the audited ones in `market/` -
 * this deliberately constructs no URL of its own, because the whole point of
 * those modules is that every link was confirmed against the real venue.
 */
export function withLinks(alert: FomoAlert): FomoAlertWithLinks {
  return {
    ...alert,
    fomoUrl: alert.chainId && alert.tokenAddress ? fomoUrl(alert.chainId, alert.tokenAddress) : undefined,
    axiomUrl: alert.chainId ? axiomUrl(alert.chainId, alert.dexId, alert.pairAddress) : undefined,
  }
}

export interface ListAlertsOptions {
  /** BUY, SELL, THESIS, UNKNOWN. Omitted means every kind. */
  kind?: FomoAlert['kind']
  traderHandle?: string
  ticker?: string
  /** Only alerts received after this instant. */
  since?: Date
  limit?: number
}

/** Newest first, because that is the only order the dashboard reads them in. */
export async function listAlerts(options: ListAlertsOptions = {}): Promise<FomoAlertWithLinks[]> {
  const filter: Filter<FomoAlert> = {}
  if (options.kind) filter.kind = options.kind
  if (options.traderHandle) filter.traderHandle = options.traderHandle
  if (options.ticker) filter.ticker = options.ticker.toUpperCase()
  if (options.since) filter.receivedAt = { $gt: options.since }

  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)

  const rows = await getCollections()
    .fomoAlerts.find(filter, { projection: { raw: 0 } })
    .sort({ receivedAt: -1 })
    .limit(limit)
    .toArray()

  return rows.map(withLinks)
}

/** What a reporter may set. `openedAt` is ours on first write and never moves. */
export interface ReportTradeInput {
  tradeRef: string
  eventId: string
  source: string
  side: FomoAlertTrade['side']
  mode: FomoAlertTrade['mode']
  status: FomoAlertTrade['status']
  chainId?: string
  tokenAddress?: string
  ticker?: string
  usdAmount?: number
  price?: number
  quantity?: number
  pnlUsd?: number
  pnlPct?: number
  txHash?: string
  note?: string
}

/**
 * Record a trade taken on an alert, or update one already recorded.
 *
 * An upsert on `tradeRef` rather than an insert, because the interesting part
 * is the lifecycle: a trade is reported at `intent`, again when it fills, and
 * again when it closes with a P&L. Three reports, one row - and a reporter that
 * retries a report it already made changes nothing.
 */
export async function recordTrade(input: ReportTradeInput): Promise<FomoAlertTrade | undefined> {
  const now = new Date()
  const set: Partial<FomoAlertTrade> = {
    eventId: input.eventId,
    source: input.source,
    side: input.side,
    mode: input.mode,
    status: input.status,
    chainId: input.chainId,
    tokenAddress: input.tokenAddress,
    ticker: input.ticker?.toUpperCase(),
    usdAmount: input.usdAmount,
    price: input.price,
    quantity: input.quantity,
    pnlUsd: input.pnlUsd,
    pnlPct: input.pnlPct,
    txHash: input.txHash,
    note: input.note,
    updatedAt: now,
  }
  // A close is the only thing that stamps closedAt.
  if (input.status === 'closed') set.closedAt = now

  // Here it matters twice over: as well as the null-versus-absent problem, an
  // undefined in `$set` would overwrite what an earlier report stored - a fill
  // that omits the price must not erase the price the intent carried.
  withoutUndefined(set)

  try {
    const result = await getCollections().fomoAlertTrades.findOneAndUpdate(
      { tradeRef: input.tradeRef },
      { $set: set, $setOnInsert: { tradeRef: input.tradeRef, openedAt: now } },
      { upsert: true, returnDocument: 'after' },
    )
    if (result) fomoStream.publish({ type: 'trade', trade: result })
    return result ?? undefined
  } catch (err) {
    log.fomo.error({ err, tradeRef: input.tradeRef }, 'fomo trade write failed')
    return undefined
  }
}

export interface ListTradesOptions {
  eventId?: string
  status?: FomoAlertTrade['status']
  mode?: FomoAlertTrade['mode']
  limit?: number
}

export async function listTrades(options: ListTradesOptions = {}): Promise<FomoAlertTrade[]> {
  const filter: Filter<FomoAlertTrade> = {}
  if (options.eventId) filter.eventId = options.eventId
  if (options.status) filter.status = options.status
  if (options.mode) filter.mode = options.mode

  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)

  return getCollections().fomoAlertTrades.find(filter).sort({ openedAt: -1 }).limit(limit).toArray()
}

/** One row per execution mode. Kept apart on purpose - see the model's note. */
export interface TradeSummaryRow {
  mode: FomoAlertTrade['mode']
  trades: number
  open: number
  closed: number
  realisedUsd: number
}

interface SummaryAggregateRow {
  _id: FomoAlertTrade['mode']
  trades: number
  open: number
  closed: number
  realisedUsd: number
}

/**
 * Totals for the dashboard's header, grouped by execution mode.
 *
 * Grouped rather than summed, because a paper fill and a live fill are not the
 * same currency of evidence. A single "P&L" number that quietly adds them is
 * exactly the kind of number that gets believed.
 */
export async function tradeSummary(): Promise<TradeSummaryRow[]> {
  const rows = await getCollections()
    .fomoAlertTrades.aggregate<SummaryAggregateRow>([
      {
        $group: {
          _id: '$mode',
          trades: { $sum: 1 },
          open: { $sum: { $cond: [{ $eq: ['$status', 'open'] }, 1, 0] } },
          closed: { $sum: { $cond: [{ $eq: ['$status', 'closed'] }, 1, 0] } },
          realisedUsd: {
            $sum: { $cond: [{ $eq: ['$status', 'closed'] }, { $ifNull: ['$pnlUsd', 0] }, 0] },
          },
        },
      },
    ])
    .toArray()

  return rows.map((r) => ({
    mode: r._id,
    trades: r.trades,
    open: r.open,
    closed: r.closed,
    realisedUsd: r.realisedUsd,
  }))
}
