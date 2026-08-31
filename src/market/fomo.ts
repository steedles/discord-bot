/**
 * Links into fomo.family, which is where the group actually trades.
 *
 * Every alert already carries DexScreener and an explorer - one to read the
 * chart, one to verify the contract. Neither is somewhere you can act, and an
 * alert whose whole point is timing should not end with a copy-paste into
 * another tab.
 *
 * The path is `/tokens/<chain>/<address>`. Fomo's slugs are close to the ids in
 * `chains.ts` but not the same - BNB Chain is `bnb` where we call it `bsc` - so
 * the map below is explicit and holds only slugs seen on a real fomo link. A
 * chain that is missing produces no link rather than a guessed one, because an
 * alert someone is acting on is the worst place to find a 404.
 */

const BASE = 'https://fomo.family/tokens'

/**
 * Our chain id to fomo's slug, each one confirmed against a real link rather
 * than guessed. `bsc` -> `bnb` is why: the slugs are close enough to our own ids
 * to invite an assumption, and that one would have been wrong.
 */
const FOMO_CHAIN: Record<string, string> = {
  solana: 'solana',
  robinhood: 'robinhood',
  bsc: 'bnb',
  base: 'base',
  ethereum: 'ethereum',
}

/** A fomo token page, or undefined when fomo does not cover the chain. */
export function fomoUrl(chainId: string, tokenAddress: string): string | undefined {
  const slug = FOMO_CHAIN[chainId]
  if (!slug || !tokenAddress) return undefined
  return `${BASE}/${slug}/${tokenAddress}`
}

/** Whether an alert on this chain can offer a trade link. */
export function fomoSupports(chainId: string): boolean {
  return chainId in FOMO_CHAIN
}
