/**
 * The plain Solana JSON-RPC calls the rug-signature check needs
 * (docs/11-RUG-SIGNATURE.md v2 in fresh-start). No `@solana/web3.js` - this
 * codebase already decodes Solana accounts by hand rather than take that
 * dependency (see solana-amm.ts), and these are all read-only POST calls
 * `fetchJson` already knows how to make, rate-limited and retried the same
 * way as every other upstream here.
 *
 * v2 amendment A2: `getTokenLargestAccounts` is gone from here on purpose -
 * it is per-method throttled on public RPC and 429s on the very first call
 * with no burst allowance. Holders now come from the RugCheck report
 * (src/risk/holders.ts), which is free. This file is left with only the one
 * primitive the amended algorithm still needs: a wallet's first-ever funding.
 */
import { RateLimiter } from './limiter.js'
import { solanaRpcUrl } from '../monitor/providers/solana-stream.js'
import { fetchJson } from './http.js'
import { config } from '../config.js'

/**
 * Conservative by default so this is safe to run on a free-tier key before a
 * paid one is ready - see the "Free-tier accommodations" section of the rug
 * checker plan. Bump `SOLANA_RPC_CALLS_PER_MINUTE` once a paid key is live.
 */
export const solanaRpcLimiter = new RateLimiter('solana:rpc', config.SOLANA_RPC_CALLS_PER_MINUTE)

class SolanaRpcError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SolanaRpcError'
  }
}

interface RpcResponse<T> {
  result?: T
  error?: { code: number; message: string }
}

let idCounter = 0

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const url = solanaRpcUrl()
  if (!url) throw new SolanaRpcError('No Solana RPC configured (SOLANA_RPC_URL / HELIUS_API_KEY)')

  idCounter += 1
  const body = { jsonrpc: '2.0', id: idCounter, method, params }
  const data = await fetchJson<RpcResponse<T>>(url, {
    body,
    timeoutMs: 15_000,
    retries: 1,
    limiter: solanaRpcLimiter,
  })

  if (data.error) throw new SolanaRpcError(`${method}: ${data.error.message}`)
  if (data.result === undefined) throw new SolanaRpcError(`${method}: empty result`)
  return data.result
}

interface SignatureInfo {
  signature: string
  blockTime: number | null
}

/** One page, newest first - Solana's own cap. */
const SIGNATURES_PAGE_LIMIT = 1000

/**
 * A wallet's whole signature history, oldest first - but only when it fits in
 * one page. A page that comes back full means the wallet has more history
 * than that, which means it is not a fresh, single-purpose wallet, and the
 * caller should stop rather than pay for more pages to confirm what is
 * already obvious (doc: "if the creator wallet has a long history predating
 * the launch, this hop is meaningless").
 *
 * **The two outcomes are returned separately, not both as `undefined`.**
 * "This wallet has thousands of transactions" is a measurement that SUCCEEDED
 * and is itself evidence - the rug signature's whole premise (doc §1) is that
 * every wallet involved is fresh and single-use, and a wallet with 8,000
 * signatures is categorically not that. Collapsing it into the same empty
 * answer as a failed RPC call made half of all rug checks report ignorance
 * about coins they had in fact learned something definite about.
 *
 * Paging back is deliberately not offered. The wallets that hit this are
 * deployer bots - the one measured while writing this was still returning full
 * pages at 8,000 signatures - so reaching the first funding would cost dozens
 * of calls to answer a question that is already moot.
 */
export type SignatureHistory =
  | { kind: 'complete'; signatures: SignatureInfo[] }
  /** Longer than one page. `atLeast` is what was seen, not the true total. */
  | { kind: 'not-fresh'; atLeast: number }

export async function oldestSignaturesIfFresh(address: string): Promise<SignatureHistory> {
  const page = await rpc<SignatureInfo[]>('getSignaturesForAddress', [
    address,
    { limit: SIGNATURES_PAGE_LIMIT },
  ])
  if (page.length >= SIGNATURES_PAGE_LIMIT) return { kind: 'not-fresh', atLeast: page.length }

  // API returns newest first; callers want oldest first.
  return { kind: 'complete', signatures: [...page].reverse() }
}

interface TokenBalanceEntry {
  accountIndex: number
  mint: string
  owner?: string
  uiTokenAmount: { uiAmount: number | null }
}

interface ParsedTransaction {
  blockTime: number | null
  transaction: { message: { accountKeys: (string | { pubkey: string })[] } }
  meta: {
    preBalances: number[]
    postBalances: number[]
    preTokenBalances?: TokenBalanceEntry[]
    postTokenBalances?: TokenBalanceEntry[]
    err: unknown
  } | null
}

export interface BalanceChange {
  account: string
  deltaLamports: number
}

/**
 * Every account's SOL balance change in one transaction, from the pre/post
 * balance arrays lined up against the account list. A failed transaction
 * (`meta.err` set) moved nothing real, so it is skipped by the caller instead
 * of read as a payout.
 */
export async function transactionBalanceChanges(
  signature: string,
): Promise<{ blockTime: number | null; changes: BalanceChange[] } | undefined> {
  const tx = await rpc<ParsedTransaction | null>('getTransaction', [
    signature,
    { encoding: 'json', maxSupportedTransactionVersion: 0 },
  ])
  if (!tx?.meta || tx.meta.err) return undefined

  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey))
  const changes = keys.map((account, i) => ({
    account,
    deltaLamports: tx.meta!.postBalances[i]! - tx.meta!.preBalances[i]!,
  }))

  return { blockTime: tx.blockTime, changes }
}

/**
 * SPL and Token-2022 program ids - confirmed live (both queried successfully
 * against a real wallet holding tokens under each). A pump.fun-graduated
 * token can mint under either, so both are queried; two calls rather than
 * one because `getTokenAccountsByOwner` filters by a single program id at a
 * time, with no "any SPL token" mode.
 */
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

interface TokenAccountsResponse {
  value: { account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmount: number | null } } } } } }[]
}

export interface SolanaHolding {
  mint: string
  uiAmount: number
}

/**
 * Every SPL/Token-2022 mint this owner currently holds a nonzero balance of -
 * for the dashboard's Holdings page (src/web/routes.ts), reading a
 * configured wallet directly rather than any tracked position. Zero-balance
 * accounts (closed out, or a spam airdrop swept to zero) are the common case
 * - confirmed live, one test wallet had 91 Token-2022 accounts and only 3
 * with anything actually in them - so filtering them here is what keeps the
 * result to what is genuinely held, not every account ever opened.
 */
export async function solanaTokenHoldings(owner: string): Promise<SolanaHolding[]> {
  const [standard, token2022] = await Promise.all([
    rpc<TokenAccountsResponse>('getTokenAccountsByOwner', [
      owner,
      { programId: TOKEN_PROGRAM_ID },
      { encoding: 'jsonParsed' },
    ]),
    rpc<TokenAccountsResponse>('getTokenAccountsByOwner', [
      owner,
      { programId: TOKEN_2022_PROGRAM_ID },
      { encoding: 'jsonParsed' },
    ]),
  ])

  const byMint = new Map<string, number>()
  for (const { account } of [...standard.value, ...token2022.value]) {
    const info = account.data.parsed.info
    const amount = info.tokenAmount.uiAmount
    if (!amount) continue // zero or null - not a real holding
    byMint.set(info.mint, (byMint.get(info.mint) ?? 0) + amount) // a mint can have more than one account
  }

  return [...byMint.entries()].map(([mint, uiAmount]) => ({ mint, uiAmount }))
}

