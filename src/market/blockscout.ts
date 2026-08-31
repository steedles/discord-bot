/**
 * Free, keyless "every token this address holds" for the chains that happen
 * to run a public Blockscout instance - confirmed live per chain, not
 * assumed: `chains.blockscout.com`'s own registry lists an instance for
 * ethereum, base and Robinhood Chain, and each answered a real query against
 * a real wallet. BSC has none - its Etherscan-family equivalent
 * (`addresstokenbalance`) is a paid-plan-only endpoint, so there is no free
 * "list everything" call for it at all, and it is left out rather than
 * guessed at with a wrong host.
 */
import { RateLimiter } from './limiter.js'
import { fetchJson } from './http.js'

const BLOCKSCOUT_HOSTS: Record<string, string> = {
  ethereum: 'eth.blockscout.com',
  base: 'base.blockscout.com',
  robinhood: 'robinhoodchain.blockscout.com',
}

export function blockscoutHost(chainId: string): string | undefined {
  return BLOCKSCOUT_HOSTS[chainId.toLowerCase()]
}

/** Public, unauthenticated - conservative so this dashboard is never the reason one of these instances rate-limits everyone. */
const blockscoutLimiter = new RateLimiter('blockscout', 30)

interface TokenBalanceEntry {
  token: { address_hash: string; symbol: string | null; name: string | null }
  value: string
}

export interface EvmHolding {
  tokenAddress: string
  symbol: string | null
}

/**
 * Every ERC-20 this address holds a nonzero balance of on one chain. `value`
 * is a raw base-unit string (needs `decimals` to become a human amount) -
 * unused here, since the Holdings page only needs presence, the same as the
 * fresh-start positions it replaces never carried a quantity either.
 */
export async function evmTokenHoldings(chainId: string, address: string): Promise<EvmHolding[]> {
  const host = blockscoutHost(chainId)
  if (!host) return []

  const entries = await fetchJson<TokenBalanceEntry[]>(
    `https://${host}/api/v2/addresses/${address}/token-balances`,
    { timeoutMs: 10_000, retries: 1, limiter: blockscoutLimiter },
  )

  return entries
    .filter((e) => e.value !== '0')
    .map((e) => ({ tokenAddress: e.token.address_hash, symbol: e.token.symbol }))
}
