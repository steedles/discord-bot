import WebSocket from 'ws'
import { config } from '../../config.js'
import { log } from '../../logger.js'
import {
  bondingCurvePrice,
  decodeBondingCurve,
  decodeMeteoraPair,
  decodeMintDecimals,
  decodePumpSwapPool,
  decodeRaydiumV4Pool,
  decodeTokenAccount,
  dlmmPrice,
  poolKindFor,
  priceFromVaults,
  type PoolKind,
} from './solana-amm.js'
import type { StreamedPrice } from './streamed-snapshot.js'
import type { TokenRef } from './types.js'

/**
 * Live Solana pool state, over Helius.
 *
 * Solana has no `Sync` event to listen for - a swap rewrites an account rather
 * than announcing itself - so this subscribes to whichever accounts hold the
 * price and decodes them as they change. Which accounts those are depends on the
 * AMM, and `solana-amm.ts` holds that knowledge; everything here is transport.
 *
 * The account a pool is priced from:
 *
 * - **PumpSwap / Raydium** - the two vaults, priced against each other.
 * - **Meteora DLMM** - the pair account, whose active bin *is* the price.
 * - **pump.fun curve** - the curve account's virtual reserves.
 *
 * Anything else stays on the poll, which is a slower alert rather than a wrong
 * one. Same rule as the EVM side: a pool we cannot read exactly is a pool we do
 * not stream.
 */

export function solanaRpcUrl(): string | undefined {
  if (config.SOLANA_RPC_URL) return config.SOLANA_RPC_URL
  return config.HELIUS_API_KEY
    ? `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`
    : undefined
}

export function solanaWsUrl(): string | undefined {
  if (config.SOLANA_WS_URL) return config.SOLANA_WS_URL
  return config.HELIUS_API_KEY
    ? `wss://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`
    : undefined
}

/** How a single watched token is priced, once its pool has been identified. */
interface StreamedPool {
  token: TokenRef
  kind: PoolKind
  /** Accounts subscribed for this token. */
  accounts: string[]
  baseDecimals: number
  quoteDecimals: number
  /** Latest vault balances, for the two-account AMMs. */
  baseAmount?: bigint
  quoteAmount?: bigint
  /** Latest price of the watched token in the quote token. */
  ratio?: number
  /** What one quote token is worth, anchored to the aggregator's USD price. */
  quoteUsd?: number
  /**
   * The aggregator's last USD price, held until a ratio exists to anchor it
   * against. Without this the two halves wait on each other: the anchor needs a
   * ratio, and a ratio is not published without an anchor - which silently cost
   * a whole poll cycle before the first streamed price appeared.
   */
  pendingAnchorUsd?: number
}

type Listener = (chainId: string, tokenAddress: string, update: StreamedPrice) => void

const RECONNECT_START_MS = 1_000
const RECONNECT_MAX_MS = 30_000

export class SolanaStream {
  private ws?: WebSocket
  private closing = false
  private reconnectMs = RECONNECT_START_MS
  private nextId = 1

  /** Pools by watched token address, and the reverse lookups the socket needs. */
  private readonly pools = new Map<string, StreamedPool>()
  private readonly accountToToken = new Map<string, string>()
  private readonly requestToAccount = new Map<number, string>()
  private readonly subscriptionToAccount = new Map<number, string>()

  private watchedKey = ''

  constructor(private readonly onUpdate: Listener) {}

  get streaming(): boolean {
    return Boolean(solanaWsUrl() && solanaRpcUrl())
  }

  /**
   * Resolves each watched token's pool and points the socket at it.
   *
   * Pool identity never changes, so resolution is cached per pair address and
   * only new tokens cost RPC calls.
   */
  async sync(tokens: TokenRef[]): Promise<void> {
    if (!this.streaming) return

    const mine = tokens.filter((t) => t.chainId === 'solana' && t.pairAddress)
    const key = mine
      .map((t) => t.tokenAddress)
      .sort()
      .join(',')
    if (key === this.watchedKey) return
    this.watchedKey = key

    for (const token of mine) {
      if (this.pools.has(token.tokenAddress)) continue
      try {
        const pool = await this.resolvePool(token)
        if (!pool) continue

        this.pools.set(token.tokenAddress, pool)
        for (const account of pool.accounts) this.accountToToken.set(account, token.tokenAddress)
      } catch (err) {
        log.monitor.debug(
          { err: String(err), token: token.symbol },
          'could not resolve solana pool for streaming',
        )
      }
    }

    // Tokens that have left the watchlist stop costing a subscription.
    const wanted = new Set(mine.map((t) => t.tokenAddress))
    for (const [address, pool] of this.pools) {
      if (wanted.has(address)) continue
      for (const account of pool.accounts) this.accountToToken.delete(account)
      this.pools.delete(address)
    }

    this.connect()
  }

  /** Re-anchors the USD conversion from an aggregator reading. */
  calibrate(tokenAddress: string, watchedPriceUsd: number): void {
    const pool = this.pools.get(tokenAddress)
    if (!pool || !(watchedPriceUsd > 0)) return

    pool.pendingAnchorUsd = watchedPriceUsd
    if (pool.ratio) this.anchor(pool)
  }

  /** Turns the held vendor price into a quote-token value, given a ratio. */
  private anchor(pool: StreamedPool): void {
    if (!pool.ratio || !pool.pendingAnchorUsd) return

    const quoteUsd = pool.pendingAnchorUsd / pool.ratio
    if (Number.isFinite(quoteUsd) && quoteUsd > 0) pool.quoteUsd = quoteUsd
  }

  close(): void {
    this.closing = true
    this.ws?.close()
    this.ws = undefined
  }

  // --- pool identification -------------------------------------------------

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const url = solanaRpcUrl()
    if (!url) throw new Error('no solana rpc configured')

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const json = (await res.json()) as { result?: T; error?: unknown }
    if (json.error) throw new Error(JSON.stringify(json.error))
    return json.result as T
  }

  private async accountData(pubkey: string): Promise<{ owner: string; data: Buffer } | undefined> {
    const result = await this.rpc<{
      value?: { owner: string; data: [string, string] }
    }>('getAccountInfo', [pubkey, { encoding: 'base64', commitment: 'confirmed' }])

    if (!result?.value) return undefined
    return { owner: result.value.owner, data: Buffer.from(result.value.data[0], 'base64') }
  }

  private async mintDecimals(mint: string): Promise<number | undefined> {
    const account = await this.accountData(mint)
    return account ? decodeMintDecimals(account.data) : undefined
  }

  private async resolvePool(token: TokenRef): Promise<StreamedPool | undefined> {
    const account = await this.accountData(token.pairAddress)
    if (!account) return undefined

    const kind = poolKindFor(account.owner)
    if (!kind) return undefined

    if (kind === 'meteora-dlmm') {
      const pair = decodeMeteoraPair(account.data)
      if (!pair) return undefined
      // The pair account carries the active bin, so it is the only subscription
      // needed - and the reserves would price it wrongly anyway.
      return {
        token,
        kind,
        accounts: [token.pairAddress],
        baseDecimals: 0,
        quoteDecimals: 0,
      }
    }

    if (kind === 'pump-curve') {
      const decimals = await this.mintDecimals(token.tokenAddress)
      if (decimals === undefined) return undefined
      return {
        token,
        kind,
        accounts: [token.pairAddress],
        baseDecimals: decimals,
        quoteDecimals: 9,
      }
    }

    const pool =
      kind === 'pump-swap' ? decodePumpSwapPool(account.data) : decodeRaydiumV4Pool(account.data)
    if (!pool) return undefined

    // Raydium stores its decimals; PumpSwap does not, so the mints are asked.
    const baseDecimals = pool.baseDecimals ?? (await this.mintDecimals(pool.baseMint))
    const quoteDecimals = pool.quoteDecimals ?? (await this.mintDecimals(pool.quoteMint))
    if (baseDecimals === undefined || quoteDecimals === undefined) return undefined

    // A pool whose base side is not the watched token would price the wrong way
    // round, and inverting on a guess is how a token ends up quoted at 4,000.
    if (pool.baseMint !== token.tokenAddress) return undefined

    return {
      token,
      kind,
      accounts: [pool.baseVault, pool.quoteVault],
      baseDecimals,
      quoteDecimals,
    }
  }

  // --- socket --------------------------------------------------------------

  private connect(): void {
    if (this.closing || this.ws) return

    const url = solanaWsUrl()
    if (!url) return

    const ws = new WebSocket(url)
    this.ws = ws

    ws.on('open', () => {
      this.reconnectMs = RECONNECT_START_MS
      this.requestToAccount.clear()
      this.subscriptionToAccount.clear()
      for (const account of this.accountToToken.keys()) this.subscribe(account)
      log.monitor.info({ accounts: this.accountToToken.size }, 'solana stream subscribed')
    })

    ws.on('message', (raw) => this.onMessage(String(raw)))
    ws.on('error', (err) => log.monitor.warn({ err: String(err) }, 'solana stream error'))

    ws.on('close', () => {
      this.ws = undefined
      if (this.closing) return
      // Backoff with jitter: a provider that dropped everyone at once should not
      // get every client back in the same millisecond.
      const wait = this.reconnectMs
      this.reconnectMs = Math.min(Math.floor(this.reconnectMs * 1.8 + 250), RECONNECT_MAX_MS)
      log.monitor.info({ reconnectInMs: wait }, 'solana stream closed, reconnecting')
      setTimeout(() => this.connect(), wait)
    })
  }

  private subscribe(account: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return

    const id = this.nextId++
    this.requestToAccount.set(id, account)
    this.ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'accountSubscribe',
        // `confirmed` rather than `processed`: a price from a slot that never
        // lands would fire an alert about a trade that did not happen.
        params: [account, { encoding: 'base64', commitment: 'confirmed' }],
      }),
    )
  }

  private onMessage(raw: string): void {
    let message: {
      id?: number
      result?: unknown
      method?: string
      params?: { subscription?: number; result?: { value?: { data?: [string, string] } } }
    }
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }

    if (typeof message.id === 'number' && typeof message.result === 'number') {
      const account = this.requestToAccount.get(message.id)
      if (account) this.subscriptionToAccount.set(message.result, account)
      return
    }

    if (message.method !== 'accountNotification') return

    const account = this.subscriptionToAccount.get(message.params?.subscription ?? -1)
    const encoded = message.params?.result?.value?.data?.[0]
    if (!account || !encoded) return

    this.onAccount(account, Buffer.from(encoded, 'base64'))
  }

  private onAccount(account: string, data: Buffer): void {
    const tokenAddress = this.accountToToken.get(account)
    if (!tokenAddress) return

    const pool = this.pools.get(tokenAddress)
    if (!pool) return

    if (pool.kind === 'meteora-dlmm') {
      const pair = decodeMeteoraPair(data)
      if (pair) this.publish(pool, dlmmPrice(pair.activeId, pair.binStep))
      return
    }

    if (pool.kind === 'pump-curve') {
      const curve = decodeBondingCurve(data)
      if (!curve) return
      // A graduated curve stops moving; the AMM pool takes over and the next
      // sync picks it up. Publishing its frozen price would be a lie.
      if (curve.complete) return
      this.publish(pool, bondingCurvePrice(curve, pool.baseDecimals))
      return
    }

    const balance = decodeTokenAccount(data)
    if (!balance) return

    if (account === pool.accounts[0]) pool.baseAmount = balance.amount
    else pool.quoteAmount = balance.amount

    // Both sides are needed for a ratio, and the first notification only ever
    // carries one of them.
    if (pool.baseAmount === undefined || pool.quoteAmount === undefined) return

    this.publish(
      pool,
      priceFromVaults(pool.baseAmount, pool.baseDecimals, pool.quoteAmount, pool.quoteDecimals),
    )
  }

  private publish(pool: StreamedPool, ratio: number | undefined): void {
    if (ratio === undefined) return
    pool.ratio = ratio
    this.anchor(pool)

    // No anchor yet means the next poll supplies one. A ratio is not dollars.
    if (!pool.quoteUsd) return

    const priceUsd = ratio * pool.quoteUsd
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) return

    this.onUpdate('solana', pool.token.tokenAddress, { priceUsd, at: Date.now() })
  }
}
