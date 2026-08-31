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

const HELIUS_API = 'https://api.helius.xyz/v0/webhooks'

/**
 * Addresses attached to the single webhook.
 *
 * Helius plans differ in how many they allow, so this stays well under any of
 * them. If the watchlist is longer, the busiest tokens keep their subscription
 * and the rest still get spike and momentum alerts - which come from polling and
 * do not need a subscription at all.
 */
const MAX_SUBSCRIBED_ADDRESSES = 100

/** Unclaimed swaps are dropped oldest-first rather than growing without bound. */
const QUEUE_MAX = 2_000

/** One swap as it arrived, before we know what it was worth. */
interface RawSwap {
  tokenAddress: string
  tokenAmount: number
  side: 'buy' | 'sell'
  txHash: string
  wallet?: string
  at: number
}

interface HeliusTokenTransfer {
  fromUserAccount?: string
  toUserAccount?: string
  mint?: string
  tokenAmount?: number
}

interface HeliusTransaction {
  signature?: string
  timestamp?: number
  type?: string
  feePayer?: string
  tokenTransfers?: HeliusTokenTransfer[]
}

interface HeliusWebhook {
  webhookID: string
  webhookURL: string
  accountAddresses?: string[]
}

/**
 * Solana market data plus real whale swaps from Helius.
 *
 * Swaps arrive by webhook rather than by polling. Polling for individual
 * transactions on Solana means asking for signatures per account and then
 * fetching each one, which is both slow and expensive; a webhook is pushed the
 * moment the transaction lands.
 *
 * Without `HELIUS_API_KEY` and `HELIUS_WEBHOOK_SECRET` the provider still serves
 * market data and simply reports `whaleSupport: 'unsupported'`. It never falls
 * back to inferring swap sizes from aggregate volume - an average trade size is
 * not a trade.
 */
export class SolanaProvider extends BaseProvider implements ChainDataProvider {
  readonly chainId = 'solana'
  readonly whaleSupport: WhaleSupport

  private readonly queue: RawSwap[] = []
  private webhookId?: string
  private subscribed = new Set<string>()
  private whaleNote?: string

  constructor(private readonly priceLookup: PriceLookup) {
    super()

    if (!config.HELIUS_API_KEY) {
      this.whaleSupport = 'unsupported'
      this.whaleNote = 'HELIUS_API_KEY is not set'
    } else if (!config.HELIUS_WEBHOOK_SECRET) {
      // An unauthenticated webhook lets anyone POST a fabricated whale buy into
      // the channel, so a missing secret disables the feature rather than
      // opening the endpoint.
      this.whaleSupport = 'unsupported'
      this.whaleNote = 'HELIUS_WEBHOOK_SECRET is not set, so the webhook cannot be secured'
    } else if (!this.webhookUrl()) {
      this.whaleSupport = 'unsupported'
      this.whaleNote = 'no public URL - set HELIUS_WEBHOOK_URL or DASHBOARD_URL'
    } else {
      this.whaleSupport = 'push'
    }
  }

  async getSnapshots(tokens: TokenRef[]): Promise<MarketSnapshot[]> {
    try {
      const snapshots = await fetchSnapshots(this.chainId, tokens)
      this.recordSuccess()
      return snapshots
    } catch (err) {
      this.recordFailure(err)
      log.monitor.warn({ err: String(err), chain: this.chainId }, 'solana snapshots failed')
      return []
    }
  }

  async discover(): Promise<TokenRef[]> {
    return fetchDiscoveryCandidates(this.chainId)
  }

  /**
   * Points the Helius webhook at the current watchlist.
   *
   * Idempotent: it finds the webhook by URL rather than storing an id, so a
   * restart reattaches to the existing one instead of creating a second.
   */
  async syncSubscriptions(tokens: TokenRef[]): Promise<void> {
    if (this.whaleSupport !== 'push') return

    const addresses = tokens
      .filter((t) => t.chainId === this.chainId)
      .map((t) => t.tokenAddress)
      .slice(0, MAX_SUBSCRIBED_ADDRESSES)

    if (sameSet(addresses, this.subscribed)) return

    try {
      const id = this.webhookId ?? (await this.findWebhookId())

      if (addresses.length === 0) {
        // Helius rejects an empty address list, so an empty watchlist means
        // leaving the last subscription in place rather than tearing it down.
        return
      }

      const body = JSON.stringify({
        webhookURL: this.webhookUrl(),
        transactionTypes: ['SWAP'],
        accountAddresses: addresses,
        webhookType: 'enhanced',
        authHeader: config.HELIUS_WEBHOOK_SECRET,
      })

      const res = await fetch(
        id
          ? `${HELIUS_API}/${id}?api-key=${config.HELIUS_API_KEY}`
          : `${HELIUS_API}?api-key=${config.HELIUS_API_KEY}`,
        { method: id ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body },
      )

      if (!res.ok) throw new Error(`Helius webhook ${res.status}: ${(await res.text()).slice(0, 200)}`)

      const saved = (await res.json()) as HeliusWebhook
      this.webhookId = saved.webhookID ?? id
      this.subscribed = new Set(addresses)

      log.monitor.info({ count: addresses.length, webhookId: this.webhookId }, 'helius subscription updated')
    } catch (err) {
      this.whaleNote = err instanceof Error ? err.message : String(err)
      log.monitor.warn({ err: String(err) }, 'could not sync helius subscription')
    }
  }

  /**
   * Prices and returns the swaps the webhook has queued.
   *
   * Draining is destructive: a swap handed out once is gone. Anything that
   * cannot be priced, or is below the threshold, is discarded here rather than
   * held - it will never become interesting later.
   */
  async getRecentWhaleSwaps(tokens: TokenRef[], since: number, minUsd: number): Promise<WhaleSwap[]> {
    if (this.whaleSupport !== 'push') return []

    const watched = new Map(
      tokens.filter((t) => t.chainId === this.chainId).map((t) => [t.tokenAddress.toLowerCase(), t]),
    )

    const drained = this.queue.splice(0, this.queue.length)
    const out: WhaleSwap[] = []

    for (const raw of drained) {
      if (raw.at < since) continue

      const token = watched.get(raw.tokenAddress.toLowerCase())
      if (!token) continue

      const price = this.priceLookup(this.chainId, raw.tokenAddress)
      if (price === undefined || !Number.isFinite(price) || price <= 0) continue

      const amountUsd = raw.tokenAmount * price
      if (!Number.isFinite(amountUsd) || amountUsd < minUsd) continue

      out.push({
        chainId: this.chainId,
        tokenAddress: raw.tokenAddress,
        pairAddress: token.pairAddress,
        symbol: token.symbol,
        side: raw.side,
        amountUsd,
        tokenAmount: raw.tokenAmount,
        txHash: raw.txHash,
        wallet: raw.wallet,
        at: raw.at,
      })
    }

    return out
  }

  /**
   * Accepts a webhook delivery. Returns how many swaps were queued.
   *
   * Reads `tokenTransfers` rather than the parsed `events.swap` block: the
   * transfer list is present on every enhanced transaction and describes what
   * actually moved, while the swap block's shape varies by which DEX and which
   * route Helius managed to decode.
   */
  ingest(payload: unknown): number {
    if (!Array.isArray(payload)) return 0

    let queued = 0

    for (const entry of payload as HeliusTransaction[]) {
      const signature = entry?.signature
      const feePayer = entry?.feePayer
      if (!signature || !feePayer || !Array.isArray(entry.tokenTransfers)) continue

      const at = typeof entry.timestamp === 'number' ? entry.timestamp * 1_000 : Date.now()

      // Net the transfers per mint. A routed swap moves the same token through
      // several hops, and counting each hop would multiply one buy into three.
      const netByMint = new Map<string, number>()

      for (const transfer of entry.tokenTransfers) {
        const mint = transfer?.mint
        const amount = transfer?.tokenAmount
        if (!mint || typeof amount !== 'number' || !Number.isFinite(amount)) continue

        const received = transfer.toUserAccount === feePayer
        const sent = transfer.fromUserAccount === feePayer
        if (!received && !sent) continue

        netByMint.set(mint, (netByMint.get(mint) ?? 0) + (received ? amount : -amount))
      }

      for (const [mint, net] of netByMint) {
        if (net === 0) continue
        this.push({
          tokenAddress: mint,
          tokenAmount: Math.abs(net),
          side: net > 0 ? 'buy' : 'sell',
          txHash: signature,
          wallet: feePayer,
          at,
        })
        queued += 1
      }
    }

    return queued
  }

  health(): ProviderHealth {
    return this.baseHealth(this.chainId, this.whaleSupport, this.whaleNote)
  }

  /** Where Helius should POST. Explicit setting wins; otherwise the dashboard's URL. */
  webhookUrl(): string | undefined {
    if (config.HELIUS_WEBHOOK_URL) return config.HELIUS_WEBHOOK_URL
    return config.DASHBOARD_URL ? `${config.DASHBOARD_URL}/webhooks/helius` : undefined
  }

  private push(swap: RawSwap): void {
    this.queue.push(swap)
    if (this.queue.length > QUEUE_MAX) this.queue.splice(0, this.queue.length - QUEUE_MAX)
  }

  private async findWebhookId(): Promise<string | undefined> {
    const res = await fetch(`${HELIUS_API}?api-key=${config.HELIUS_API_KEY}`)
    if (!res.ok) throw new Error(`Helius list webhooks ${res.status}`)

    const all = (await res.json()) as HeliusWebhook[]
    const url = this.webhookUrl()
    return Array.isArray(all) ? all.find((w) => w.webhookURL === url)?.webhookID : undefined
  }
}

function sameSet(values: string[], set: Set<string>): boolean {
  return values.length === set.size && values.every((v) => set.has(v))
}
