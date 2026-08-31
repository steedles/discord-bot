import { createPublicClient, parseAbiItem, webSocket, type Address, type PublicClient } from 'viem'
import { config } from '../../config.js'
import { log } from '../../logger.js'
import { anchorQuoteUsd, inQuote, liquidityUsdFromQuoteReserve, priceFromReserves, priceFromSqrtPriceX96 } from './amm-math.js'
import type { StreamedPrice } from './streamed-snapshot.js'
import type { TokenRef } from './types.js'

/**
 * Live pool state from an EVM node, over a websocket.
 *
 * The same two events the whale detector already reads carry the pool's price
 * alongside the amounts: a V2 `Sync` restates both reserves after every trade,
 * and a V3 `Swap` carries `sqrtPriceX96`, which is the price itself. So a
 * sub-second price feed is not a second subscription or a second vendor - it is
 * the subscription we were already going to open, decoded further.
 *
 * Both event shapes are watched on every pool rather than probing which kind a
 * pool is. Whichever one fires answers the question, and a pool that is neither
 * simply never streams, which shows up as polling-speed alerts rather than as
 * wrong ones.
 */

const V2_SYNC = parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)')
const V3_SWAP = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
)

const WS_URLS: Record<string, string | undefined> = {
  ethereum: config.ETHEREUM_WS_URL,
  bsc: config.BSC_WS_URL,
  base: config.BASE_WS_URL,
  robinhood: config.ROBINHOOD_WS_URL,
}

/** Chains a websocket is configured for. The rest stay on the poll. */
export function evmStreamChains(): string[] {
  return Object.entries(WS_URLS)
    .filter(([, url]) => Boolean(url))
    .map(([chainId]) => chainId)
}

/** Everything about a pool that never changes, read once per pool. */
export interface PoolLayout {
  token0: Address
  token1: Address
  decimals0: number
  decimals1: number
  watchedIsToken0: boolean
}

interface PoolState {
  token: TokenRef
  layout: PoolLayout
  /** Latest price of the watched token in the quote token. */
  ratio?: number
  /** What one quote token is worth, anchored to the aggregator's USD price. */
  quoteUsd?: number
  /**
   * The aggregator's last USD price, held until a ratio exists to anchor it
   * against. Without this the two halves wait on each other and the first
   * streamed price costs a whole poll cycle.
   */
  pendingAnchorUsd?: number
  /** Quote-side reserve from the last `Sync`, for a V2 liquidity figure. */
  quoteReserve?: bigint
}

export type SnapshotListener = (chainId: string, tokenAddress: string, update: StreamedPrice) => void

export class EvmStream {
  private client?: PublicClient
  private readonly pools = new Map<string, PoolState>()
  private unwatch: (() => void)[] = []
  private watchedKey = ''

  constructor(
    readonly chainId: string,
    private readonly onUpdate: SnapshotListener,
  ) {
    const url = WS_URLS[chainId]
    if (url) this.client = createPublicClient({ transport: webSocket(url) })
  }

  get streaming(): boolean {
    return this.client !== undefined
  }

  /**
   * Points the subscriptions at the current watchlist.
   *
   * Re-subscribing costs a round trip and drops in-flight events, so it only
   * happens when the set of pools actually changed - the watchlist is re-read
   * every cycle but usually says the same thing.
   */
  async sync(tokens: TokenRef[], layouts: Map<string, PoolLayout>): Promise<void> {
    const client = this.client
    if (!client) return

    const mine = tokens.filter((t) => t.chainId === this.chainId && t.pairAddress)
    const key = mine
      .map((t) => t.pairAddress.toLowerCase())
      .sort()
      .join(',')
    if (key === this.watchedKey) return

    this.close()
    this.watchedKey = key
    if (mine.length === 0) return

    this.pools.clear()
    for (const token of mine) {
      const layout = layouts.get(token.pairAddress.toLowerCase())
      if (layout) this.pools.set(token.pairAddress.toLowerCase(), { token, layout })
    }
    if (this.pools.size === 0) return

    const address = [...this.pools.keys()] as Address[]

    try {
      this.unwatch = [
        client.watchEvent({
          address,
          event: V2_SYNC,
          onLogs: (logs) => this.onSync(logs),
          onError: (err) => this.onError(err),
        }),
        client.watchEvent({
          address,
          event: V3_SWAP,
          onLogs: (logs) => this.onSwap(logs),
          onError: (err) => this.onError(err),
        }),
      ]
      log.monitor.info({ chain: this.chainId, pools: this.pools.size }, 'evm stream subscribed')
    } catch (err) {
      log.monitor.warn({ err: String(err), chain: this.chainId }, 'evm stream subscribe failed')
    }
  }

  /**
   * Re-anchors the USD conversion from an aggregator reading.
   *
   * The stream measures the pool exactly and knows nothing about dollars; the
   * aggregator knows dollars and arrives once a poll. Anchoring one to the other
   * means the USD price between polls is the vendor's own figure carried on our
   * ratio, rather than a number of our own invention.
   */
  calibrate(pairAddress: string, watchedPriceUsd: number): void {
    const pool = this.pools.get(pairAddress.toLowerCase())
    if (!pool || !(watchedPriceUsd > 0)) return

    pool.pendingAnchorUsd = watchedPriceUsd
    if (pool.ratio) this.anchor(pool)
  }

  /** Turns the held vendor price into a quote-token value, given a ratio. */
  private anchor(pool: PoolState): void {
    if (!pool.ratio || !pool.pendingAnchorUsd) return

    const quoteUsd = anchorQuoteUsd(pool.pendingAnchorUsd, pool.ratio)
    if (quoteUsd) pool.quoteUsd = quoteUsd
  }

  close(): void {
    for (const stop of this.unwatch) {
      try {
        stop()
      } catch {
        // A socket already gone is the state we wanted anyway.
      }
    }
    this.unwatch = []
  }

  private onSync(logs: { address: string; args: { reserve0?: bigint; reserve1?: bigint } }[]): void {
    for (const entry of logs) {
      const pool = this.pools.get(entry.address.toLowerCase())
      if (!pool) continue

      const { reserve0, reserve1 } = entry.args
      if (reserve0 === undefined || reserve1 === undefined) continue

      const { decimals0, decimals1, watchedIsToken0 } = pool.layout
      const price0In1 = priceFromReserves(reserve0, reserve1, decimals0, decimals1)
      if (price0In1 === undefined) continue

      pool.quoteReserve = watchedIsToken0 ? reserve1 : reserve0
      this.publish(pool, inQuote(price0In1, watchedIsToken0))
    }
  }

  private onSwap(logs: { address: string; args: { sqrtPriceX96?: bigint } }[]): void {
    for (const entry of logs) {
      const pool = this.pools.get(entry.address.toLowerCase())
      if (!pool) continue

      const { sqrtPriceX96 } = entry.args
      if (sqrtPriceX96 === undefined) continue

      const { decimals0, decimals1, watchedIsToken0 } = pool.layout
      const price0In1 = priceFromSqrtPriceX96(sqrtPriceX96, decimals0, decimals1)
      if (price0In1 === undefined) continue

      this.publish(pool, inQuote(price0In1, watchedIsToken0))
    }
  }

  /** Emits a USD price, or holds the ratio until an anchor makes one possible. */
  private publish(pool: PoolState, ratio: number | undefined): void {
    if (ratio === undefined) return
    pool.ratio = ratio
    this.anchor(pool)

    // No anchor yet means the next poll will supply one. Publishing a ratio as
    // if it were dollars is exactly the kind of number this codebase refuses to
    // make up.
    if (!pool.quoteUsd) return

    const priceUsd = ratio * pool.quoteUsd
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return

    const quoteDecimals = pool.layout.watchedIsToken0
      ? pool.layout.decimals1
      : pool.layout.decimals0

    const liquidityUsd =
      pool.quoteReserve !== undefined
        ? liquidityUsdFromQuoteReserve(pool.quoteReserve, quoteDecimals, pool.quoteUsd)
        : undefined

    this.onUpdate(this.chainId, pool.token.tokenAddress, {
      priceUsd,
      ...(liquidityUsd !== undefined ? { liquidityUsd } : {}),
      at: Date.now(),
    })
  }

  private onError(err: unknown): void {
    log.monitor.warn({ err: String(err), chain: this.chainId }, 'evm stream error')
  }
}
