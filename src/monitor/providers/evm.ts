import { createPublicClient, http, parseAbiItem, type Address, type PublicClient } from 'viem'
import { config } from '../../config.js'
import { log } from '../../logger.js'
import { fetchDiscoveryCandidates, fetchSnapshots } from './dexscreener-source.js'
import {
  BaseProvider,
  type ChainDataProvider,
  type MarketSnapshot,
  type PriceLookup,
  type ProviderHealth,
  type TokenRef,
  type WhaleSupport,
  type WhaleSwap,
} from './types.js'

/**
 * The two Swap events that between them cover essentially every EVM DEX pool
 * DexScreener lists. Nearly all AMMs are a Uniswap V2 or V3 fork and kept the
 * event signature; anything genuinely novel is simply not decoded, which shows
 * up as no whale alerts rather than as wrong ones.
 */
const V2_SWAP = parseAbiItem(
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
)
const V3_SWAP = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
)

const PAIR_ABI = [
  parseAbiItem('function token0() view returns (address)'),
  parseAbiItem('function token1() view returns (address)'),
] as const

const ERC20_ABI = [parseAbiItem('function decimals() view returns (uint8)')] as const

/**
 * Blocks to look back in one poll.
 *
 * After an outage the gap can be enormous, and asking a public node for a
 * million blocks of logs gets the request refused rather than answered. Missing
 * the swaps from a long outage is the correct outcome: a whale buy is news for
 * about a minute, and posting an hour-old one as if it just happened is worse
 * than not posting it.
 */
const MAX_BLOCK_SPAN = 2_000n

/**
 * Pool addresses per `getLogs` call. Many public nodes reject a filter carrying
 * a long address array outright, and one refused request means no whale alerts
 * on that chain at all rather than fewer.
 */
const ADDRESS_CHUNK = 50

/** What token0/token1 and decimals are for a pool. Constant, so read once. */
export interface PairLayout {
  token0: Address
  token1: Address
  /** Decimals of the watched token, whichever side it is on. */
  decimals: number
  decimals0: number
  decimals1: number
  /** Whether the watched token is token0 in this pool. */
  watchedIsToken0: boolean
}

/**
 * A pool address that is not 20 bytes.
 *
 * DexScreener returns pair identifiers in whatever shape the chain uses, and on
 * at least one chain that is a 32-byte id rather than an EVM address. Passing it
 * to `eth_getLogs` does not skip that pool - the node rejects the whole filter,
 * so one odd token silently costs every other pool on the chain its swap data.
 * The same is true of a websocket subscription, so both go through this.
 */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

export function isEvmAddress(value: string | undefined): value is Address {
  return typeof value === 'string' && EVM_ADDRESS.test(value)
}

const RPC_URLS: Record<string, string | undefined> = {
  ethereum: config.ETHEREUM_RPC_URL,
  bsc: config.BSC_RPC_URL,
  base: config.BASE_RPC_URL,
  // Keyless public endpoint, so this one is configured by default.
  robinhood: config.ROBINHOOD_RPC_URL,
}

/** Chains this provider can do whale detection on, given the configured RPCs. */
export function evmWhaleChains(): string[] {
  return Object.entries(RPC_URLS)
    .filter(([, url]) => Boolean(url))
    .map(([chainId]) => chainId)
}

/**
 * Market data for one EVM chain, plus whale swaps read straight from the chain.
 *
 * DexScreener has no public per-transaction endpoint - it reports how many
 * trades happened, not what any one of them was - so whale detection reads Swap
 * logs from a node instead. Dividing 5-minute volume by 5-minute trade count
 * would be cheaper and is what it looks like the aggregate data supports, but it
 * yields an average, and an average is not a transaction: four $12.5k trades and
 * one $47k buy against three dust sells produce the same number.
 *
 * Without an RPC URL for its chain the provider serves market data only and
 * reports `whaleSupport: 'unsupported'`.
 */
export class EvmProvider extends BaseProvider implements ChainDataProvider {
  readonly whaleSupport: WhaleSupport

  private client?: PublicClient
  private lastBlock?: bigint
  private readonly layouts = new Map<string, PairLayout | null>()
  private whaleNote?: string

  constructor(
    readonly chainId: string,
    private readonly priceLookup: PriceLookup,
  ) {
    super()

    const url = RPC_URLS[chainId]
    if (!url) {
      this.whaleSupport = 'unsupported'
      this.whaleNote = `no RPC configured - set ${chainId.toUpperCase()}_RPC_URL for whale alerts`
    } else {
      this.whaleSupport = 'poll'
      this.client = createPublicClient({ transport: http(url) })
    }
  }

  async getSnapshots(tokens: TokenRef[]): Promise<MarketSnapshot[]> {
    try {
      const snapshots = await fetchSnapshots(this.chainId, tokens)
      this.recordSuccess()
      return snapshots
    } catch (err) {
      this.recordFailure(err)
      log.monitor.warn({ err: String(err), chain: this.chainId }, 'evm snapshots failed')
      return []
    }
  }

  async discover(): Promise<TokenRef[]> {
    return fetchDiscoveryCandidates(this.chainId)
  }

  async getRecentWhaleSwaps(tokens: TokenRef[], since: number, minUsd: number): Promise<WhaleSwap[]> {
    const client = this.client
    if (!client || this.whaleSupport !== 'poll') return []

    const watched = tokens.filter((t) => t.chainId === this.chainId && isEvmAddress(t.pairAddress))
    if (watched.length === 0) return []

    const malformed = tokens.filter(
      (t) => t.chainId === this.chainId && t.pairAddress && !isEvmAddress(t.pairAddress),
    )
    if (malformed.length > 0) {
      log.monitor.debug(
        { chain: this.chainId, pairs: malformed.map((t) => `${t.symbol}:${t.pairAddress}`) },
        'skipping pools whose address is not a 20-byte EVM address',
      )
    }

    try {
      const head = await client.getBlockNumber()
      const from =
        this.lastBlock === undefined ? head : bigMax(this.lastBlock + 1n, head - MAX_BLOCK_SPAN)

      // First run: establish a starting point and report nothing. Alerting on
      // whatever happened to be in the last block at boot is noise, not news.
      if (from > head) {
        this.lastBlock = head
        return []
      }

      const chunks = chunk(
        watched.map((t) => t.pairAddress as Address),
        ADDRESS_CHUNK,
      )
      const byPair = new Map(watched.map((t) => [t.pairAddress.toLowerCase(), t]))

      const [v2Batches, v3Batches] = await Promise.all([
        Promise.all(
          chunks.map((address) =>
            client.getLogs({ address, event: V2_SWAP, fromBlock: from, toBlock: head }),
          ),
        ),
        Promise.all(
          chunks.map((address) =>
            client.getLogs({ address, event: V3_SWAP, fromBlock: from, toBlock: head }),
          ),
        ),
      ])

      const v2Logs = v2Batches.flat()
      const v3Logs = v3Batches.flat()

      // Advanced only once the logs are actually in hand. Moving it before the
      // request would mean a transient RPC failure silently skipped every block
      // in the window instead of retrying them next cycle.
      this.lastBlock = head

      const out: WhaleSwap[] = []

      for (const entry of v2Logs) {
        const token = byPair.get(entry.address.toLowerCase())
        if (!token) continue

        const layout = await this.layoutFor(token)
        if (!layout) continue

        const { amount0In, amount1In, amount0Out, amount1Out } = entry.args
        if (amount0In === undefined || amount1In === undefined) continue
        if (amount0Out === undefined || amount1Out === undefined) continue

        const inRaw = layout.watchedIsToken0 ? amount0In : amount1In
        const outRaw = layout.watchedIsToken0 ? amount0Out : amount1Out

        // The pool sending the watched token out means the trader received it.
        const swap = this.toSwap(
          token,
          layout,
          outRaw - inRaw,
          entry.transactionHash,
          entry.args.to,
          minUsd,
        )
        if (swap) out.push(swap)
      }

      for (const entry of v3Logs) {
        const token = byPair.get(entry.address.toLowerCase())
        if (!token) continue

        const layout = await this.layoutFor(token)
        if (!layout) continue

        const { amount0, amount1 } = entry.args
        if (amount0 === undefined || amount1 === undefined) continue

        // V3 amounts are signed from the pool's side: negative means it paid out.
        const delta = layout.watchedIsToken0 ? amount0 : amount1
        const swap = this.toSwap(
          token,
          layout,
          -delta,
          entry.transactionHash,
          entry.args.recipient,
          minUsd,
        )
        if (swap) out.push(swap)
      }

      this.recordSuccess()
      // Blocks carry no wall-clock time here, so `since` is enforced by the
      // block window itself; this filter only guards a clock skew case.
      return out.filter((s) => s.at >= since - 60_000)
    } catch (err) {
      this.recordFailure(err)
      this.whaleNote = err instanceof Error ? err.message : String(err)
      log.monitor.warn({ err: String(err), chain: this.chainId }, 'evm swap-log poll failed')
      return []
    }
  }

  /**
   * Pool layouts for the streamer, keyed by lowercased pair address.
   *
   * Read through the same cache the whale sweep uses, so subscribing costs
   * nothing for a pool this chain has already looked at.
   */
  async poolLayouts(tokens: TokenRef[]): Promise<Map<string, PairLayout>> {
    const out = new Map<string, PairLayout>()

    for (const token of tokens) {
      if (token.chainId !== this.chainId || !isEvmAddress(token.pairAddress)) continue
      const layout = await this.layoutFor(token)
      if (layout) out.set(token.pairAddress.toLowerCase(), layout)
    }

    return out
  }

  health(): ProviderHealth {
    return this.baseHealth(this.chainId, this.whaleSupport, this.whaleNote)
  }

  /**
   * Converts a signed raw amount into a priced swap, or nothing.
   *
   * Returns undefined for anything it cannot state as a fact: no price, a
   * zero-value trade, or a total below the threshold.
   */
  private toSwap(
    token: TokenRef,
    layout: PairLayout,
    signedRaw: bigint,
    txHash: string,
    wallet: string | undefined,
    minUsd: number,
  ): WhaleSwap | undefined {
    if (signedRaw === 0n) return undefined

    const price = this.priceLookup(this.chainId, token.tokenAddress)
    if (price === undefined || !Number.isFinite(price) || price <= 0) return undefined

    const magnitude = signedRaw < 0n ? -signedRaw : signedRaw
    const tokenAmount = Number(magnitude) / 10 ** layout.decimals
    const amountUsd = tokenAmount * price
    if (!Number.isFinite(amountUsd) || amountUsd < minUsd) return undefined

    return {
      chainId: this.chainId,
      tokenAddress: token.tokenAddress,
      pairAddress: token.pairAddress,
      symbol: token.symbol,
      side: signedRaw > 0n ? 'buy' : 'sell',
      amountUsd,
      tokenAmount,
      txHash,
      wallet,
      at: Date.now(),
    }
  }

  /** Reads and caches a pool's layout. Null means "asked, and it did not answer". */
  private async layoutFor(token: TokenRef): Promise<PairLayout | undefined> {
    const key = token.pairAddress.toLowerCase()
    const cached = this.layouts.get(key)
    if (cached !== undefined) return cached ?? undefined

    const client = this.client
    if (!client) return undefined

    try {
      const pair = token.pairAddress as Address
      const [token0, token1] = await Promise.all([
        client.readContract({ address: pair, abi: PAIR_ABI, functionName: 'token0' }),
        client.readContract({ address: pair, abi: PAIR_ABI, functionName: 'token1' }),
      ])

      const watched = token.tokenAddress.toLowerCase()
      const isToken0 = token0.toLowerCase() === watched

      // Neither side being the watched token means this is not its pool.
      if (!isToken0 && token1.toLowerCase() !== watched) {
        this.layouts.set(key, null)
        return undefined
      }

      // Both sides, because a price is a ratio between them: the decimals of the
      // quote token shift the answer exactly as much as the watched one's do.
      const [decimals0, decimals1] = await Promise.all([
        client.readContract({ address: token0, abi: ERC20_ABI, functionName: 'decimals' }),
        client.readContract({ address: token1, abi: ERC20_ABI, functionName: 'decimals' }),
      ])

      const layout: PairLayout = {
        token0,
        token1,
        decimals: Number(isToken0 ? decimals0 : decimals1),
        decimals0: Number(decimals0),
        decimals1: Number(decimals1),
        watchedIsToken0: isToken0,
      }
      this.layouts.set(key, layout)
      return layout
    } catch (err) {
      // A pool that will not describe itself is cached as unreadable so the
      // next poll does not pay for the same failure again.
      this.layouts.set(key, null)
      log.monitor.debug({ err: String(err), pair: token.pairAddress }, 'could not read pool layout')
      return undefined
    }
  }
}

function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
