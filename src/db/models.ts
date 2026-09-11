import type { ObjectId } from 'mongodb'
import type { FeatureSettings } from '../features/types.js'

/** A user-configured price alert. Fires when the token crosses `target`. */
export interface Alert {
  _id?: ObjectId
  guildId: string
  userId: string
  /** Where to announce. Falls back to a DM if the channel is gone. */
  channelId: string

  chainId: string
  tokenAddress: string
  pairAddress: string
  symbol: string

  direction: 'above' | 'below'
  target: number
  /** Price when the alert was created, so we can show the move in the notification. */
  priceAtCreate: number

  /** Re-arm after firing instead of deactivating. */
  repeat: boolean
  active: boolean
  /**
   * A repeating alert only fires while armed. Firing disarms it; the price
   * moving back to the other side of the target arms it again. Without this a
   * repeating alert would fire on every poll while the condition held.
   */
  armed: boolean

  createdAt: Date
  lastTriggeredAt?: Date
  triggerCount: number
  /** Consecutive price-fetch failures. Used to retire dead tokens. */
  errorCount: number
}

/**
 * A coin somebody asked to be told about when its trend turns.
 *
 * `lastDirection` is what makes it a state machine rather than a stream of
 * crossovers: a turn is only news if it is the opposite of the last one
 * reported, so a chart chopping around a crossover produces one message, not
 * twenty.
 */
export interface CoinTracker {
  _id?: ObjectId
  guildId: string
  userId: string
  /** Where to announce. Falls back to a DM if the channel is gone. */
  channelId: string

  chainId: string
  tokenAddress: string
  /** The pool the candles come from. Trend is a property of a pool, not a token. */
  pairAddress: string
  symbol: string

  active: boolean
  createdAt: Date
  priceAtCreate: number

  /** Direction of the last turn reported, so the opposite one is the next news. */
  lastDirection?: 'up' | 'down'
  lastSignalAt?: Date
  /** Price when that turn was reported, for the "moved enough since" check. */
  lastSignalPrice?: number
  signalCount: number

  /** Least-recently-checked trackers go first when the API budget is tight. */
  lastCheckedAt?: Date
  /** Consecutive candle-fetch failures. Used to retire dead pools. */
  errorCount: number
}

/**
 * One feature, configured for one place.
 *
 * `channelId: null` means guild-wide. A row with a channelId overrides the
 * guild-wide row for that channel only, which is what lets the same feature run
 * with different settings in different channels - a strict "safe plays" scanner
 * in one channel and a loose "degen" one in another.
 *
 * Push features (the scanner) always carry a channelId, because each row is a
 * destination rather than an override.
 */
export interface FeatureInstance {
  _id?: ObjectId
  guildId: string
  featureId: string
  channelId: string | null
  enabled: boolean
  settings: FeatureSettings
  /** Free-text label so several instances of one feature stay tellable apart. */
  label?: string
  createdAt: Date
  updatedAt: Date
  updatedBy?: string
}

/** A logged-in dashboard session. Cookie holds only the signed id. */
export interface Session {
  _id?: ObjectId
  sessionId: string
  userId: string
  username: string
  avatar?: string
  /** Guilds where this user has Manage Server AND the bot is present. */
  guildIds: string[]
  /**
   * True for an email + password session rather than a Discord one. These have
   * no Discord identity to check permissions against, so access is decided by
   * "is the bot in that guild" instead - see `requireGuildAccess`.
   */
  local?: boolean
  createdAt: Date
  expiresAt: Date
}

/** @deprecated Superseded by FeatureInstance. Kept only for the one-time migration. */
export interface ScannerFilters {
  /** DexScreener chain ids, e.g. ["solana", "base"]. Empty means all supported. */
  chains: string[]
  minLiquidityUsd: number
  minVolume24hUsd: number
  /** Only post pairs created within this many minutes. */
  maxAgeMinutes: number
  /** 0-100, higher is riskier. Tokens scoring above this are dropped. */
  maxRiskScore: number
  /** Require at least one website or social link on the token profile. */
  requireSocials: boolean
}

/** @deprecated Superseded by FeatureInstance. Kept only for the one-time migration. */
export interface GuildConfig {
  _id?: ObjectId
  guildId: string
  scanner: {
    enabled: boolean
    channelId?: string
    filters: ScannerFilters
  }
  createdAt: Date
  updatedAt: Date
}

export const DEFAULT_SCANNER_FILTERS: ScannerFilters = {
  chains: [],
  minLiquidityUsd: 15_000,
  minVolume24hUsd: 25_000,
  maxAgeMinutes: 720,
  maxRiskScore: 45,
  requireSocials: true,
}

/**
 * Dedupe record so the scanner never posts the same token to the same channel
 * twice. Scoped per channel rather than per guild, so a strict channel and a
 * loose channel can both surface the same token.
 */
export interface SeenToken {
  _id?: ObjectId
  guildId: string
  channelId: string
  chainId: string
  tokenAddress: string
  postedAt: Date
  /**
   * Added for the Live Charts "New Launches" column - absent on rows written
   * before that existed, so both stay optional rather than backfilled.
   */
  symbol?: string
  pairAddress?: string
}

/**
 * One poll's reading of one pool.
 *
 * These exist because DexScreener's volume fields are *trailing rolling
 * windows*, not buckets: `h1` read at 12:00 and at 12:15 overlap by 45 minutes.
 * "Three consecutive 15-minute windows of rising volume" therefore cannot be
 * read off the API at all - it has to be differenced from our own readings,
 * which is what these rows are for.
 */
/**
 * One closed one-minute candle, kept so the same pool is not re-fetched.
 *
 * Safe to persist precisely because a *closed* candle never changes - the
 * forming minute is dropped before anything reaches here. What this cannot do is
 * make a request cheaper: GeckoTerminal's OHLCV endpoint returns its newest N or
 * nothing, with no way to ask only for what is missing. So the store exists to
 * let a request be skipped altogether, and to survive a restart while doing it.
 */
export interface StoredCandle {
  _id?: ObjectId
  chainId: string
  poolAddress: string
  /** Unix seconds at the start of the minute. */
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
  /** When this row was written, for the TTL index. */
  at: Date
}

/**
 * When a pool's candles were last fetched from upstream.
 *
 * Freshness cannot be read off the candles themselves: a candle exists only for
 * a minute that traded, so "nothing in the last five minutes" is indistinguish-
 * able between a quiet pool and one nobody has asked about. The fetch time is
 * the only thing that separates them.
 */
export interface CandlePool {
  _id?: ObjectId
  chainId: string
  poolAddress: string
  fetchedAt: Date
}

export interface VolumeSnapshot {
  _id?: ObjectId
  chainId: string
  tokenAddress: string
  pairAddress: string
  at: Date

  priceUsd?: number
  liquidityUsd?: number
  marketCapUsd?: number
  volM5?: number
  volH1?: number
  volH6?: number
  volH24?: number
  /** Buys + sells in the trailing 5m, used as an activity floor. */
  txnsM5?: number
  txnsH24?: number
}

/**
 * A posted alert, kept so the same token cannot be posted again inside its
 * cooldown and so the hourly per-channel cap can be counted.
 *
 * Scoped per channel as well as per feature: two channels running the monitor
 * with different thresholds are two different audiences, and one seeing a token
 * should not silence the other.
 */
/**
 * A dip the bot has announced, kept until it recovers or expires.
 *
 * One row per channel rather than per token: two channels can run Dip Hunter
 * with different recovery targets, and each one's follow-up has to be measured
 * against the price *its* alert went out at. `expiresAt` carries a TTL index, so
 * a dip that never comes back stops being tracked without anything sweeping.
 */
export interface DipState {
  _id?: ObjectId
  guildId: string
  channelId: string
  chainId: string
  tokenAddress: string
  symbol: string
  /** Price when the drawdown alert was posted. Recovery is measured from this. */
  alertPriceUsd: number
  /** Lowest price seen since the alert. Reported, never compared against. */
  lowPriceUsd: number
  lowAt: Date
  armedAt: Date
  expiresAt: Date
}

export interface MonitorAlert {
  _id?: ObjectId
  guildId: string
  channelId: string
  /** The feature that posted: volume-spikes, whale-buys or trending. */
  featureId: string
  chainId: string
  tokenAddress: string
  symbol: string
  /** Human-readable trigger, e.g. "5m vol 8.2x baseline". Shown by /monitor status. */
  trigger: string
  priority: 'normal' | 'high'
  postedAt: Date
}

/**
 * A token the monitor polls every cycle.
 *
 * `source` decides its lifetime. A token someone added by hand stays until they
 * remove it; one auto-discovered from the trending feed carries an `expiresAt`
 * and drops out on its own, so discovery cannot silently grow the watchlist
 * past the request budget.
 */
export interface WatchedToken {
  _id?: ObjectId
  chainId: string
  tokenAddress: string
  /** The pool snapshots are read from. Re-picked when it stops being the busiest. */
  pairAddress: string
  symbol: string
  name: string

  /**
   * `called` is a third kind: added because somebody called the coin in a
   * channel, watched briefly, and dropped again if it goes nowhere. It expires
   * like a discovered token but on its own much shorter rules.
   */
  source: 'manual' | 'discovered' | 'called'
  addedBy?: string
  guildId?: string
  addedAt: Date

  lastPolledAt?: Date
  /** Consecutive snapshot failures. Used to retire dead pools. */
  errorCount: number
  /** Only set for discovered tokens. A TTL index deletes the row when it passes. */
  expiresAt?: Date
}

/**
 * Somebody calling a coin in a channel, and what happened next.
 *
 * Kept separate from the watchlist entry because the two answer different
 * questions: the watchlist says "poll this", while a call says "this person, in
 * this channel, at this price, at this moment". Two people calling the same coin
 * in different channels are two calls against one watched token.
 */
export interface TokenCall {
  _id?: ObjectId
  guildId: string
  /** The channel the call was made in - where the follow-up has to go back to. */
  channelId: string
  messageId: string
  /** Whoever gets tagged when it moves. Absent when no human could be credited. */
  callerId?: string
  chainId: string
  tokenAddress: string
  pairAddress: string
  symbol: string

  /** Price when the call was seen. Every multiple is measured from this. */
  priceAtCall: number
  marketCapAtCall?: number
  calledAt: Date
  /** Multiples already announced, so 2x is not posted on every poll after it. */
  alerted: number[]
  /** Set once the call stops being followed, with the reason it was dropped. */
  closedAt?: Date
  closedReason?: string
  /** TTL cleanup. Long after the call stops being followed. */
  expiresAt: Date
}

/**
 * A pump.fun mint heard on the websocket, waiting to show up on a DEX with real
 * liquidity. When it does, that is a "graduation" and it gets posted.
 */
export interface PendingMint {
  _id?: ObjectId
  mint: string
  symbol: string
  name: string
  firstSeenAt: Date
  checkedAt?: Date
  checks: number
}

/**
 * Two independent rug checks, Solana pump.fun only (docs/11-RUG-SIGNATURE.md
 * v2's funding graph, plus a v3 holder-distribution flatness check - see
 * risk/rugSignature.ts for both). One row per mint - `flag` and `clean` are
 * permanent, `unknown` is not: it is the outcome of the *last attempt*, not a
 * verdict, kept only so a reader other than `checkRugSignature` (the launch
 * alert, the signal intake) can tell "checked, inconclusive" from "never
 * checked" - `checkRugSignature` itself never treats a cached `unknown` row
 * as a reason to skip a fresh attempt, since whatever was missing may simply
 * not exist yet. An `unknown` row is therefore overwritten every time the
 * mint is checked again, until it resolves to something permanent.
 *
 * `verdict` is the combination of `fundingVerdict` and `distributionVerdict`:
 * `flag` if either flagged, `clean` only if at least one ran to completion
 * and neither flagged, `unknown` if both were inconclusive. `verdict ===
 * 'flag'` is the only thing the Discord embed or Live Charts may act on -
 * `unknown`/`clean` must never read as "safe" there. The signal intake is the
 * one consumer allowed to see all three, since it is an automated
 * decision-maker that can weigh "inconclusive" for itself.
 */
export interface RugCheck {
  _id?: ObjectId
  chainId: 'solana'
  mint: string
  checkedAt: Date
  verdict: 'flag' | 'clean' | 'unknown'
  fundingVerdict: 'flag' | 'clean' | 'unknown'
  cohortSize: number
  tightCohortSize: number
  checkedHolders: number
  totalHolders: number
  cohortSharePct?: number
  funderWallet?: string
  creatorWallet?: string
  tailMatch: boolean
  distributionVerdict: 'flag' | 'clean' | 'unknown'
  /** Population CV of the top-10 non-pool holders' pct. `null` when unknown. */
  distributionCv: number | null
  /** How many holders fed the CV. `null` when unknown. */
  distributionCohort: number | null
  reason: string
}

/**
 * Tracked Wallets - a curated "known wallet" list, imported wholesale from
 * wherever it was actually built rather than inferred by this bot. Replaces
 * the earlier Wallet Scout, which guessed at a wallet's quality from one
 * signal (buying early into a fresh pump.fun launch) - too weak a heuristic
 * to tag a wallet's reputation from, dropped 2026-08-25 in favour of
 * importing a real, externally-vetted list (see `pnpm import:wallets` /
 * `src/scripts/import-tracked-wallets.ts`).
 *
 * Every field except `wallet`, `chainId` and `active` mirrors whatever the
 * source system tracked verbatim - nothing here is computed by this
 * codebase, so a blank `score` (some rows are cohort-tagged rather than
 * trade-scored) is left absent rather than defaulted to zero, the same
 * unknown-is-not-low rule every vendor score in this codebase follows.
 * `source`/`cohort`/`notes` are free text from the origin system, kept as-is
 * for provenance rather than normalised into an enum this bot would have to
 * keep in sync with a system it doesn't own.
 */
export interface TrackedWallet {
  _id?: ObjectId
  wallet: string
  chainId: 'solana' | 'ethereum' | 'bsc' | 'base' | 'robinhood'
  label?: string
  source?: string
  cohort?: string
  score?: number
  winRate30d?: number
  avgHoldMin?: number
  avgPosSol?: number
  active: boolean
  favourited?: boolean
  notes?: string
  totalTrades30d?: number
  totalPnlSol30d?: number
  lastActiveAt?: Date
  earlyEntryRate?: number
  earlyEntryWinRate?: number
  earlyEntryCount?: number
  importedAt: Date
}

/**
 * One chart slot on a "My Charts" board - a free-form grid position (`x, y`
 * in grid cells, `w, h` in cell spans) plus, once the owner has pasted one, a
 * resolved coin. `chainId`/`tokenAddress`/`pairAddress`/`network`/`symbol` are
 * all absent together or present together: a slot is either still asking for
 * a coin (rendered greyed out) or fully resolved (rendered as a live chart) -
 * there is no partial state, because `pairAddress` only ever comes back from
 * `resolveToken()`, never typed in directly.
 */
export interface CustomBoardSlot {
  id: string
  x: number
  y: number
  w: number
  h: number
  chainId?: string
  tokenAddress?: string
  pairAddress?: string
  network?: string
  symbol?: string
  /**
   * GeckoTerminal candle width for this slot's embed, e.g. '15m', '1h' - one
   * of RESOLUTION_OPTIONS in web/routes.ts. Picked when the coin is loaded,
   * independent of chainId/tokenAddress/etc: unlike those, a slot keeps its
   * resolution across `clearBoardSlot` (changing the coin in a slot is not a
   * reason to also lose how zoomed in its chart was). Absent on a slot never
   * loaded, or one saved before this field existed - the client falls back
   * to '15m' either way.
   */
  resolution?: string
}

/**
 * A dashboard user's own freeform chart board - "My Charts". Keyed by
 * `userId` (Session.userId: a Discord snowflake, or `local:<email>` for a
 * password account - see completeLogin/completePasswordLogin in web/auth.ts),
 * never by guild: this is a personal layout, not a server setting, so Wayne
 * and Ash each get their own regardless of which guild they're currently
 * viewing in the dashboard's guild switcher.
 */
export interface CustomBoard {
  _id?: ObjectId
  userId: string
  slots: CustomBoardSlot[]
  updatedAt: Date
}

/** One coin on someone's personal "My Alerts" tracked list. */
export interface TrackedCoin {
  chainId: string
  tokenAddress: string
  pairAddress: string
  symbol: string
  addedAt: Date
}

/**
 * A dashboard user's personal Telegram watchlist - "My Alerts". Keyed by
 * `userId`, same identity `CustomBoard` uses and for the same reason: this is
 * personal, not a server setting, so Wayne and Ash each get their own list
 * and their own delivery chat regardless of which guild they're viewing.
 *
 * `telegramChatId` is absent until someone messages the bot and pastes the
 * resulting chat ID in - a doc with coins but no chat ID is a real, intended
 * state (tracked, not yet wired to a destination), not an error. Delivery is
 * skipped for it, silently, the same way `TELEGRAM_CHAT_ID` being unset
 * silently turns off the bot-wide mirror in telegram-alerts.ts.
 */
export interface TelegramWatch {
  _id?: ObjectId
  userId: string
  telegramChatId?: string
  coins: TrackedCoin[]
  updatedAt: Date
}

/**
 * One Fomo activity event we have already handled.
 *
 * Exists solely to make posting idempotent. `eventId` is Fomo's own
 * `payload.id`, and the unique index on it IS the dedup mechanism: an insert
 * that throws duplicate-key is the "already seen" answer, with no read-then-write
 * race between the two paths that can deliver the same event (a live frame and a
 * replay after reconnect).
 *
 * Deliberately NOT keyed on `tradeId`: a thesis carries the tradeId of the trade
 * it comments on, so two distinct events share one tradeId and keying on it
 * would silently swallow every thesis attached to an already-posted trade.
 */
export interface FomoSeenEvent {
  /** Fomo's payload.id. Unique. */
  eventId: string
  /** Fomo's payload.tradeId. Correlation only - not unique. */
  tradeId?: string
  kind: 'BUY' | 'SELL' | 'THESIS' | 'UNKNOWN'
  traderHandle?: string
  ticker?: string
  /** Fomo's timestamp. */
  createdAt: Date
  /** Ours. Carries the TTL - these rows are worthless once they cannot recur. */
  seenAt: Date
}

/**
 * One Fomo alert, kept.
 *
 * Distinct from `FomoSeenEvent` above, which is a dedup ledger: six fields, a
 * seven-day TTL, and deliberately nothing anybody would want to read later.
 * This is the record - every normalised field, so the dashboard can show what
 * an alert actually said long after Discord has scrolled past it.
 *
 * `raw` is kept for `UNKNOWN` only. On the homelab `/` is a 5400rpm disk that
 * is already the binding constraint on that box, and a full payload per event
 * buys nothing for the three kinds we parse - but an UNKNOWN means Fomo changed
 * something, and that one is worth the bytes.
 */
export interface FomoAlert {
  _id?: ObjectId
  /** Fomo's `payload.id`. Unique, and the same key `FomoSeenEvent` dedups on. */
  eventId: string
  /** Correlates a thesis with the trade it comments on. Not unique. */
  tradeId?: string
  kind: 'BUY' | 'SELL' | 'THESIS' | 'UNKNOWN'

  traderId?: string
  traderHandle?: string
  traderName?: string
  traderVerified: boolean

  chainId?: string
  networkId?: number
  tokenAddress?: string
  ticker?: string

  /** Present on BUY/SELL. Fomo sends no token amount and no transaction hash. */
  usdAmount?: number
  price?: number
  marketCap?: number
  fdv?: number

  /** Present on THESIS. */
  thesis?: string
  position?: FomoAlertPosition

  /** Fomo's clock. */
  createdAt: Date
  /** Ours, when the sidecar handed it over. Carries the TTL. */
  receivedAt: Date

  /** UNKNOWN only - see the note above. */
  raw?: unknown
}

/** The author's position at the time of a thesis, as Fomo reported it. */
export interface FomoAlertPosition {
  humanTokenAmount?: number
  usdValue?: number
  unrealizedPnlUsd?: number
  realizedPnlUsd?: number
  percentageUnrealizedPnl?: number
  percentageRealizedPnl?: number
  closedAt?: string | null
}

/**
 * A trade made because of an alert.
 *
 * **Nothing writes one of these yet**, and that is the honest state of the
 * system rather than an oversight: T6 in `fresh-start` detects and records but
 * has no executor (`services/fomo-frontrun/src/main.ts` - "entry signal, no
 * executor wired"), and this bot only posts to Discord. The collection and the
 * reporting route exist so that whatever grows an executor first has somewhere
 * to report to, and so the dashboard's attribution panel is wired rather than
 * invented later.
 *
 * `mode` is not decoration. `fresh-start` runs three execution modes and a
 * paper fill must never be countable alongside a live one - the whole point of
 * the column is that the dashboard can refuse to add them together.
 */
export interface FomoAlertTrade {
  _id?: ObjectId
  /**
   * The reporter's own id for this trade. Unique, so a retry is idempotent.
   *
   * Ours rather than an exchange's: a trade can be reported at intent, before
   * any venue has given it an id, and it must still be the same row when the
   * fill arrives.
   */
  tradeRef: string
  /** The alert this trade was taken on. Joins to `FomoAlert.eventId`. */
  eventId: string
  /** Which system took it - `fomo-frontrun`, `manual`, whatever comes next. */
  source: string

  side: 'BUY' | 'SELL'
  /** Never mix these in a total. See the note above. */
  mode: 'dry_run' | 'paper' | 'live'
  status: 'intent' | 'open' | 'closed' | 'failed'

  chainId?: string
  tokenAddress?: string
  ticker?: string

  usdAmount?: number
  price?: number
  quantity?: number

  /** Set when status becomes `closed`. */
  pnlUsd?: number
  pnlPct?: number

  txHash?: string
  /** Why a `failed` failed, or anything the reporter wants on the row. */
  note?: string

  openedAt: Date
  closedAt?: Date
  updatedAt: Date
}
