import { chainIdForNetwork } from './networks.js'
import type { FomoActivityEvent, FomoFrame, RawFomoActivity } from './types.js'

/**
 * The only file in the bot that knows Fomo's field names.
 *
 * Everything downstream consumes `FomoActivityEvent`. When Fomo renames a field -
 * and it will, this is a private API we are reading without permission - this is
 * the file that changes, and nothing else does.
 *
 * Nothing here throws. A malformed payload is a normal event on an undocumented
 * feed, and one bad frame must not take down a websocket that is delivering good
 * ones. Failures come back as `{ ok: false, reason }` so the caller can log and
 * carry on.
 */

export type NormaliseResult =
  | { ok: true; event: FomoActivityEvent }
  | { ok: false; reason: string; raw: unknown }

/** The topic carrying buys, sells and theses for the authenticated account. */
export const TRADING_ACTIVITY = 'trading_activity'

/**
 * Whether a frame is a `trading_activity` payload worth normalising.
 *
 * Rejects `subscribed` acknowledgements, which share the topic but carry no
 * payload, and every other topic. `trending_tokens` and `prices` together run at
 * roughly 2000 frames a minute against about three events an hour that matter,
 * so this predicate is also the noise filter.
 */
export function isActivityFrame(frame: unknown): frame is FomoFrame & { payload: RawFomoActivity } {
  if (!frame || typeof frame !== 'object') return false
  const f = frame as FomoFrame
  return f.type === 'data' && f.topicType === TRADING_ACTIVITY && !!f.payload && typeof f.payload === 'object'
}

/** Parse a websocket frame, tolerating anything. */
export function parseFrame(text: string): FomoFrame | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return undefined
    return parsed as FomoFrame
  } catch {
    return undefined
  }
}

function kindOf(type: string | undefined): FomoActivityEvent['kind'] {
  switch (type) {
    case 'swap_buy':
      return 'BUY'
    case 'swap_sell':
      return 'SELL'
    case 'thesis':
      return 'THESIS'
    default:
      // Deliberately not an error. A new Fomo event type should surface as an
      // UNKNOWN we can see in the logs, with its raw payload kept, rather than
      // as a crash or as silence.
      return 'UNKNOWN'
  }
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)

/**
 * Raw Fomo payload to our event.
 *
 * Two fields are genuinely required: `id`, because it is the dedup key and an
 * event we cannot identify is an event we cannot promise to post only once; and
 * a parseable `createdAt`, because the restart backfill guard compares against
 * it and an event with no age would bypass that guard entirely.
 */
export function normaliseActivity(payload: unknown, now: Date = new Date()): NormaliseResult {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: 'payload is not an object', raw: payload }
  }

  const p = payload as RawFomoActivity

  const eventId = str(p.id)
  if (!eventId) return { ok: false, reason: 'missing id (the dedup key)', raw: payload }

  const createdRaw = str(p.createdAt)
  const createdAt = createdRaw ? new Date(createdRaw) : undefined
  if (!createdAt || Number.isNaN(createdAt.getTime())) {
    return { ok: false, reason: 'missing or unparseable createdAt', raw: payload }
  }

  const kind = kindOf(str(p.type))
  const networkId = num(p.networkId)

  // On a thesis the address and chain also appear on the nested comment; prefer
  // the top level and fall back, because we have seen both populated.
  const tokenAddress = str(p.tokenAddress) ?? str(p.comment?.tokenAddress)

  return {
    ok: true,
    event: {
      eventId,
      tradeId: str(p.tradeId),
      kind,

      traderId: str(p.userId),
      traderHandle: str(p.userHandle),
      traderName: str(p.displayName),
      traderVerified: p.verified === true,
      traderAvatarUrl: str(p.profilePictureLink),

      chainId: chainIdForNetwork(networkId ?? num(p.comment?.networkId)),
      networkId: networkId ?? num(p.comment?.networkId),
      tokenAddress,
      ticker: str(p.ticker),
      tokenImageUrl: str(p.tokenImageUrl),

      usdAmount: num(p.usdAmount),
      price: num(p.price),
      marketCap: num(p.marketCap),
      fdv: num(p.fdv),

      thesis: kind === 'THESIS' ? str(p.comment?.comment) : undefined,
      position: kind === 'THESIS' ? p.authorTrade : undefined,

      createdAt,
      receivedAt: now,
      raw: payload,
    },
  }
}

/**
 * Whether an event is too old to announce.
 *
 * A restart resubscribes and Fomo may replay recent activity. Posting an
 * hour-old trade as though it just happened is worse than missing it - the same
 * call `whale-buys` already makes about its log sweep - so anything older than
 * the window is dropped on the way in, regardless of what dedup thinks.
 */
export function isStale(event: FomoActivityEvent, maxAgeMinutes: number, now: Date = new Date()): boolean {
  return now.getTime() - event.createdAt.getTime() > maxAgeMinutes * 60_000
}
