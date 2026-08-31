/**
 * Token-bucket rate limiting, shared process-wide.
 *
 * Retry-on-429 is not rate limiting. By the time a 429 comes back the request
 * has already been spent, the backoff stalls whatever asked for it, and every
 * other caller keeps hammering the same endpoint. The limiter turns that into a
 * queue: callers wait their turn locally and the upstream never sees a burst it
 * would reject.
 *
 * Buckets are module-level singletons because the budget belongs to the whole
 * bot. The volume monitor, price alerts and the coin tracker all draw on the
 * same DexScreener allowance, so they have to draw on the same bucket.
 */

const MINUTE_MS = 60_000

/**
 * How the sustained rate reacts to a refusal, and how it comes back.
 *
 * A 429 is the only honest measurement of what the endpoint will actually take.
 * Documented allowances are a starting guess - DexScreener publishes 300/minute
 * for the pair endpoints and refuses well under it - so the configured rate is
 * treated as a ceiling to approach rather than a right to spend. Multiplicative
 * down, additive up: back off fast enough to stop a refusal turning into a
 * stream of them, creep back slowly enough that the recovery does not simply
 * re-trip the limit.
 */
const BACKOFF_FACTOR = 0.75
const RECOVER_PER_MINUTE = 0.05
/** Quiet period after a refusal before the rate starts climbing again. */
const RECOVER_AFTER_MS = 30_000

export class RateLimiter {
  private readonly capacity: number
  private tokens: number
  private lastRefill = Date.now()
  private readonly waiting: (() => void)[] = []
  private timer?: NodeJS.Timeout
  /** Sustained rate actually in force. Never above `perMinute`. */
  private effective: number
  /** Never back off below this - at some point the endpoint is simply down. */
  private readonly floor: number
  private lastRejection = 0
  private rejections = 0

  /**
   * @param name       shown in stats and logs
   * @param perMinute  sustained request budget
   * @param burst      how many may go at once from idle. Defaults to a quarter
   *                   of the budget: a full-capacity burst is exactly the spike
   *                   that gets an endpoint to rate limit you.
   */
  constructor(
    readonly name: string,
    private readonly perMinute: number,
    burst?: number,
  ) {
    this.capacity = Math.max(1, burst ?? Math.ceil(perMinute / 4))
    this.tokens = this.capacity
    this.effective = perMinute
    this.floor = Math.max(1, Math.floor(perMinute / 8))
  }

  /** Resolves when the caller may make one request. */
  async acquire(): Promise<void> {
    this.refill()

    // Jumping a non-empty queue would starve whoever is already waiting.
    if (this.waiting.length === 0 && this.tokens >= 1) {
      this.tokens -= 1
      return
    }

    await new Promise<void>((resolve) => {
      this.waiting.push(resolve)
      this.schedule()
    })
  }

  /**
   * Report that the endpoint refused a request this bucket had already paid
   * for. Retrying it is the one response guaranteed to make things worse, so
   * the caller throws and the *rate* takes the correction instead.
   */
  penalise(): void {
    this.refill()
    this.rejections += 1
    this.lastRejection = Date.now()
    this.effective = Math.max(this.floor, this.effective * BACKOFF_FACTOR)
  }

  stats(): {
    name: string
    available: number
    queued: number
    perMinute: number
    ceiling: number
    rejections: number
  } {
    this.refill()
    return {
      name: this.name,
      available: Math.floor(this.tokens),
      queued: this.waiting.length,
      perMinute: Math.round(this.effective),
      ceiling: this.perMinute,
      rejections: this.rejections,
    }
  }

  private refill(): void {
    const now = Date.now()
    const elapsed = now - this.lastRefill
    if (elapsed <= 0) return

    this.lastRefill = now
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / MINUTE_MS) * this.effective)

    // Creep back toward the ceiling, but only once the endpoint has been quiet.
    if (this.effective < this.perMinute && now - this.lastRejection > RECOVER_AFTER_MS) {
      const step = (elapsed / MINUTE_MS) * RECOVER_PER_MINUTE * this.perMinute
      this.effective = Math.min(this.perMinute, this.effective + step)
    }
  }

  private schedule(): void {
    if (this.timer) return

    const msPerToken = MINUTE_MS / this.effective
    const wait = Math.max(5, Math.ceil((1 - this.tokens) * msPerToken))

    this.timer = setTimeout(() => {
      this.timer = undefined
      this.drain()
    }, wait)

    // Never hold the process open for a queued request. Shutdown wins.
    this.timer.unref?.()
  }

  private drain(): void {
    this.refill()

    while (this.tokens >= 1 && this.waiting.length > 0) {
      this.tokens -= 1
      this.waiting.shift()!()
    }

    if (this.waiting.length > 0) this.schedule()
  }
}

/**
 * DexScreener's documented allowances. The pair endpoints (tokens, pairs,
 * search) share 300/minute; the discovery feeds (token-profiles, token-boosts)
 * get 60/minute and are counted separately.
 *
 * Both sit a little under the published numbers. The published figure is where
 * they start refusing, not a target to run at.
 */
/**
 * Sustained pair-endpoint budget, shared by every DexScreener caller.
 *
 * The published allowance is 300 a minute. Running at 280 drew 429s steadily,
 * and pacing the burst down to a second's worth did not stop them - so whatever
 * is enforced for this endpoint is well under what is documented. This is set
 * from what the API actually tolerates rather than from what it advertises;
 * losing headroom costs a slower sweep, while spending it costs every caller in
 * the bot a failed request.
 */
export const DEX_PAIRS_PER_MINUTE = 120

/**
 * Almost no burst at all.
 *
 * The published allowance is 300 a minute, and staying comfortably under that in
 * aggregate still drew 429s: the limit is enforced per *second*, so 300/minute
 * means five a second and a cycle that fires thirty at once is refused even
 * though its minute is quiet. The burst is therefore set to one second's worth,
 * which turns each cycle into an evenly paced stream instead of a spike.
 *
 * This costs a poll cycle a few seconds to complete, which is invisible next to
 * a 20-second interval - and irrelevant on the chains that stream, where the
 * poll is only supplying context.
 */
export const dexPairsLimiter = new RateLimiter('dexscreener:pairs', DEX_PAIRS_PER_MINUTE, 5)
export const dexDiscoveryLimiter = new RateLimiter('dexscreener:discovery', 55)

/**
 * GeckoTerminal's candle feed.
 *
 * Documented at 30 a minute for an unkeyed caller and, like DexScreener's,
 * enforced below what it advertises - a handful of requests from one machine
 * already draws a 429. Nothing enforced this before charts existed, because the
 * coin tracker was the only caller and its concurrency cap held it down by
 * accident. Attaching a chart to an alert makes every alerting feature a caller,
 * which is exactly the arithmetic that turned the DexScreener budget into a
 * steady stream of refusals.
 *
 * The burst is one request: a cycle that wants six charts at once should spread
 * them, not spend the whole second's allowance in one go.
 */
export const geckoCandlesLimiter = new RateLimiter('geckoterminal:candles', 24, 1)
