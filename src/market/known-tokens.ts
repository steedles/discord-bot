/**
 * Canonical contract addresses for tickers people actually ask about.
 *
 * Why this exists: DexScreener's text search cannot be trusted to map a ticker
 * to the real token. Searching "USDC" surfaces Solana copycats with seven
 * figures of liquidity, and "WIF" often does not return dogwifhat at all. Any
 * ranking heuristic loses when the right answer is missing from the candidate
 * set, and quoting a trading group the wrong token is the worst thing this bot
 * could do. So the majors are pinned here and never guessed.
 *
 * Every address below was verified against live DexScreener data: the token
 * trades as a base token on the listed chain, its symbol matches, and it has
 * real liquidity. Verify the same way before adding more - see the `wrapped`
 * note for tickers like BNB that trade as their wrapped version.
 *
 * Anything not listed here falls back to ranked search, which warns the user
 * that the ticker was matched fuzzily.
 */
export interface KnownToken {
  chainId: string
  address: string
  /** Display name, for the "did you mean" list. */
  name: string
}

const REGISTRY: Record<string, KnownToken[]> = {
  sol: [{ chainId: 'solana', address: 'So11111111111111111111111111111111111111112', name: 'Wrapped SOL' }],
  usdc: [
    { chainId: 'solana', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', name: 'USD Coin' },
    { chainId: 'ethereum', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', name: 'USD Coin' },
  ],
  usdt: [{ chainId: 'solana', address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', name: 'Tether USD' }],
  bonk: [{ chainId: 'solana', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', name: 'Bonk' }],
  wif: [{ chainId: 'solana', address: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', name: 'dogwifhat' }],
  jup: [{ chainId: 'solana', address: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', name: 'Jupiter' }],
  ray: [{ chainId: 'solana', address: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', name: 'Raydium' }],
  jto: [{ chainId: 'solana', address: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', name: 'Jito' }],
  pyth: [{ chainId: 'solana', address: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', name: 'Pyth Network' }],
  popcat: [{ chainId: 'solana', address: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', name: 'Popcat' }],
  trump: [{ chainId: 'solana', address: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN', name: 'OFFICIAL TRUMP' }],

  eth: [{ chainId: 'ethereum', address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', name: 'Wrapped Ether' }],
  weth: [{ chainId: 'ethereum', address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', name: 'Wrapped Ether' }],
  btc: [{ chainId: 'ethereum', address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', name: 'Wrapped BTC' }],
  wbtc: [{ chainId: 'ethereum', address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', name: 'Wrapped BTC' }],
  pepe: [{ chainId: 'ethereum', address: '0x6982508145454ce325ddbe47a25d4ec3d2311933', name: 'Pepe' }],
  shib: [{ chainId: 'ethereum', address: '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce', name: 'Shiba Inu' }],
  link: [{ chainId: 'ethereum', address: '0x514910771af9ca656af840dff83e8264ecf986ca', name: 'Chainlink' }],
  uni: [{ chainId: 'ethereum', address: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', name: 'Uniswap' }],
  aave: [{ chainId: 'ethereum', address: '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9', name: 'Aave' }],

  arb: [{ chainId: 'arbitrum', address: '0x912ce59144191c1204e64559fe8253a0e49e6548', name: 'Arbitrum' }],
  op: [{ chainId: 'optimism', address: '0x4200000000000000000000000000000000000042', name: 'Optimism' }],

  // BNB trades as WBNB; the native asset has no contract to quote.
  bnb: [{ chainId: 'bsc', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', name: 'Wrapped BNB' }],
  wbnb: [{ chainId: 'bsc', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', name: 'Wrapped BNB' }],
  cake: [{ chainId: 'bsc', address: '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82', name: 'PancakeSwap' }],

  brett: [{ chainId: 'base', address: '0x532f27101965dd16442E59d40670FaF5eBB142E4', name: 'Brett' }],
  degen: [{ chainId: 'base', address: '0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed', name: 'Degen' }],
  aero: [{ chainId: 'base', address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', name: 'Aerodrome' }],
  toshi: [{ chainId: 'base', address: '0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4', name: 'Toshi' }],
}

/** Canonical entries for a ticker, optionally narrowed to one chain. */
export function lookupKnown(symbol: string, chainId?: string): KnownToken[] {
  const key = symbol.trim().replace(/^\$/, '').toLowerCase()
  const entries = REGISTRY[key] ?? []
  return chainId ? entries.filter((e) => e.chainId === chainId) : entries
}

export function isKnownTicker(symbol: string): boolean {
  return lookupKnown(symbol).length > 0
}
