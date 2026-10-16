/**
 * Fomo.family activity types.
 *
 * Fomo has no public API. Everything here was captured from live traffic on
 * 2026-08-31 and is documented in the spike's PROTOCOL.md - it is not derived
 * from Fomo's documentation, because there is none. Treat every field as liable
 * to disappear without notice, which is why `RawFomoActivity` is written as
 * "everything optional" and the normaliser validates rather than trusts.
 */

/** The websocket envelope. Every frame has this shape. */
export interface FomoFrame {
  type: 'data' | 'subscribed' | 'challenge' | 'challengeAccepted' | string
  topicType?: string
  topicId?: string
  activeSubscriptions?: number
  payload?: unknown
}

/**
 * The three payload types carried on `trading_activity`.
 *
 * All three arrive on ONE topic, distinguished by `payload.type` - theses do not
 * have their own topic and do not require REST polling, which is the single
 * biggest finding of the spike.
 */
export const FOMO_EVENT_TYPES = ['swap_buy', 'swap_sell', 'thesis'] as const
export type FomoEventType = (typeof FOMO_EVENT_TYPES)[number]

/** The comment object carried on a thesis event. */
export interface RawFomoComment {
  id?: string
  userId?: string
  tradeId?: string
  comment?: string
  createdAt?: string
  parentId?: string | null
  numLikes?: number
  tokenAddress?: string
  networkId?: number
}

/** The author's position at the time of a thesis. */
export interface RawFomoAuthorTrade {
  humanTokenAmount?: number
  usdValue?: number
  unrealizedPnlUsd?: number
  realizedPnlUsd?: number
  percentageUnrealizedPnl?: number
  percentageRealizedPnl?: number
  closedAt?: string | null
}

/**
 * A raw `trading_activity` payload, exactly as Fomo sends it.
 *
 * Every field is optional on purpose. This is an undocumented feed: a payload
 * missing a field we expect is a thing that will happen, and it must produce a
 * dropped event and a log line, never a thrown exception inside the bot.
 */
export interface RawFomoActivity {
  type?: string
  id?: string
  tradeId?: string
  createdAt?: string
  userId?: string
  displayName?: string
  userHandle?: string
  profilePictureLink?: string | null
  verified?: boolean
  twitter?: string | null
  usdAmount?: number
  marketCap?: number
  fdv?: number
  price?: number
  ticker?: string
  tokenImageUrl?: string
  tokenAddress?: string
  networkId?: number
  equity?: number
  isDev?: boolean
  comment?: RawFomoComment
  authorTrade?: RawFomoAuthorTrade
  numReplies?: number
  threshold?: number
}

/** What the rest of the bot sees. Nothing downstream reads a raw payload. */
export interface FomoActivityEvent {
  /**
   * `payload.id`. THE dedup key.
   *
   * Not `tradeId`: a thesis carries the `tradeId` of the trade it comments on,
   * so two different events share one `tradeId`. Deduping on that would silently
   * swallow every thesis attached to a trade we had already posted.
   */
  eventId: string
  /** Correlates a thesis with its trade. Deliberately not unique. */
  tradeId?: string
  kind: 'BUY' | 'SELL' | 'THESIS' | 'UNKNOWN'

  traderId?: string
  traderHandle?: string
  traderName?: string
  traderVerified: boolean
  /** Fomo's profile picture, when the payload carried one. */
  traderAvatarUrl?: string

  /** Our chain id from `chains.ts`, or undefined when Fomo's networkId is unmapped. */
  chainId?: string
  networkId?: number
  tokenAddress?: string
  ticker?: string
  /** Token image from the payload. Shown on the alert; never invented. */
  tokenImageUrl?: string

  /** Present on BUY/SELL. Fomo sends no token amount and no transaction hash. */
  usdAmount?: number
  price?: number
  marketCap?: number
  fdv?: number

  /** Present on THESIS. */
  thesis?: string
  position?: RawFomoAuthorTrade

  /** Fomo's timestamp, not ours. Used for the restart backfill guard. */
  createdAt: Date
  receivedAt: Date

  /** Kept because Fomo is undocumented and today's ignored field is tomorrow's. */
  raw: unknown
}
