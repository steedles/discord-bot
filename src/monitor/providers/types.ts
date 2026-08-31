/**
 * The chain abstraction the volume monitor is built on.
 *
 * Everything downstream - the detectors, the worker, the embeds - sees only the
 * types in this file. Nothing outside `providers/` may import `DexPair` or talk
 * to Helius or an RPC directly. That is the whole point: swapping DexScreener
 * for Birdeye, or a public node for Alchemy, becomes one new file in this
 * folder rather than an edit to the alert logic.
 */

/** A token the monitor is following, and the pool it reads. */
export interface TokenRef {
  chainId: string
  tokenAddress: string
  pairAddress: string
  symbol: string
}

/**
 * One pool's state at one instant.
 *
 * The volume and price-change fields are **trailing rolling windows**, exactly
 * as the upstream reports them: `h1` is "the last 60 minutes as of `fetchedAt`",
 * not "the 12:00-13:00 bucket". Two readings 15 minutes apart share 45 minutes
 * of data. Any detector that wants discrete intervals has to difference
 * consecutive snapshots itself - see `detect/momentum.ts`.
 */
export interface MarketSnapshot {
  chainId: string
  tokenAddress: string
  pairAddress: string
  /**
   * Which DEX `pairAddress` belongs to. Always the same pool as that field, so
   * a caller cannot pair one venue's id with another venue's address - which
   * would put an Axiom link on a Raydium pool.
   */
  dexId?: string
  symbol: string
  name: string

  priceUsd?: number
  liquidityUsd?: number
  marketCapUsd?: number

  volume: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', number>>
  txns: Partial<Record<'m5' | 'h1' | 'h24', { buys: number; sells: number }>>
  priceChange: Partial<Record<'m5' | 'h1' | 'h6' | 'h24', number>>

  /** Epoch ms the pool was created, when the source knows it. */
  pairCreatedAt?: number
  /** Link to the source's own page for this pair. */
  url?: string
  imageUrl?: string
  hasSocials: boolean

  /** Epoch ms this reading was taken. */
  fetchedAt: number
}

/** A single swap large enough to be worth naming. Always one real transaction. */
export interface WhaleSwap {
  chainId: string
  tokenAddress: string
  pairAddress: string
  symbol: string
  side: 'buy' | 'sell'
  /** USD value of the swap. Providers that cannot price a swap must drop it. */
  amountUsd: number
  /** Amount of the watched token that moved, when the provider knows it. */
  tokenAmount?: number
  txHash: string
  wallet?: string
  /** Epoch ms. */
  at: number
}

/**
 * How a chain learns about individual swaps.
 *
 * - `push`        the provider is told (Helius webhook). Nothing to poll.
 * - `poll`        the provider can be asked (RPC logs).
 * - `unsupported` no per-transaction data on this chain. Whale alerts are off
 *                 there and the dashboard says so - it never guesses a swap
 *                 size out of aggregate volume.
 */
export type WhaleSupport = 'push' | 'poll' | 'unsupported'

/**
 * Latest USD price for a token, as the monitor last saw it.
 *
 * Whale detection needs this because neither Helius nor an RPC log knows what a
 * swap was worth in dollars - they report token amounts. The USD figure on a
 * `WhaleSwap` is therefore always `token amount x our own last price`, computed
 * from a real transaction rather than estimated from aggregate volume. A swap
 * whose token has no price is dropped, never guessed at.
 */
export type PriceLookup = (chainId: string, tokenAddress: string) => number | undefined

export interface ProviderHealth {
  chainId: string
  /** False once `consecutiveFailures` crosses the provider's tolerance. */
  healthy: boolean
  consecutiveFailures: number
  lastSuccessAt?: number
  lastError?: string
  whaleSupport: WhaleSupport
  /** Why whale support is off, when it is off for a fixable reason. */
  whaleNote?: string
}

export interface ChainDataProvider {
  readonly chainId: string
  readonly whaleSupport: WhaleSupport

  /**
   * Market state for the given tokens. Implementations must stay inside their
   * own rate limits and must not throw for a single bad token - a token with no
   * data is simply absent from the result.
   */
  getSnapshots(tokens: TokenRef[]): Promise<MarketSnapshot[]>

  /** Candidate tokens for auto-discovery, if the source has a trending feed. */
  discover?(): Promise<TokenRef[]>

  /** `push` providers: keep the upstream subscription matching the watchlist. */
  syncSubscriptions?(tokens: TokenRef[]): Promise<void>

  /**
   * Swaps worth at least `minUsd` that happened after `since` (epoch ms).
   *
   * Both push and poll providers implement this, so the worker never branches on
   * transport: a push provider hands back what its webhook has queued, a poll
   * provider goes and asks. `unsupported` providers do not implement it at all.
   */
  getRecentWhaleSwaps?(tokens: TokenRef[], since: number, minUsd: number): Promise<WhaleSwap[]>

  health(): ProviderHealth
}

/**
 * Failure bookkeeping every provider shares.
 *
 * Kept as a base class rather than a helper because "how many times in a row
 * has this failed" is the single input to graceful degradation, and having each
 * provider count it its own way is how one of them ends up never reporting.
 */
export abstract class BaseProvider {
  protected consecutiveFailures = 0
  protected lastSuccessAt?: number
  protected lastError?: string

  /** Failures in a row before the provider is called unhealthy. */
  protected readonly failureTolerance = 3

  protected recordSuccess(): void {
    this.consecutiveFailures = 0
    this.lastSuccessAt = Date.now()
    this.lastError = undefined
  }

  protected recordFailure(err: unknown): void {
    this.consecutiveFailures += 1
    this.lastError = err instanceof Error ? err.message : String(err)
  }

  protected baseHealth(chainId: string, whaleSupport: WhaleSupport, whaleNote?: string): ProviderHealth {
    return {
      chainId,
      healthy: this.consecutiveFailures < this.failureTolerance,
      consecutiveFailures: this.consecutiveFailures,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      whaleSupport,
      whaleNote,
    }
  }
}
