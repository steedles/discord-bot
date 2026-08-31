export interface ChainInfo {
  /** DexScreener chain id - the canonical key used throughout the bot. */
  id: string
  label: string
  kind: 'solana' | 'evm'
  /** GoPlus numeric chain id. Only EVM chains have one. */
  goplusId?: string
  /** Prefix for a token address page, address appended directly. */
  explorerToken: string
  emoji: string
}

export const CHAINS: Record<string, ChainInfo> = {
  solana: {
    id: 'solana',
    label: 'Solana',
    kind: 'solana',
    explorerToken: 'https://solscan.io/token/',
    emoji: '🟣',
  },
  ethereum: {
    id: 'ethereum',
    label: 'Ethereum',
    kind: 'evm',
    goplusId: '1',
    explorerToken: 'https://etherscan.io/token/',
    emoji: '🔷',
  },
  bsc: {
    id: 'bsc',
    label: 'BNB Chain',
    kind: 'evm',
    goplusId: '56',
    explorerToken: 'https://bscscan.com/token/',
    emoji: '🟡',
  },
  base: {
    id: 'base',
    label: 'Base',
    kind: 'evm',
    goplusId: '8453',
    explorerToken: 'https://basescan.org/token/',
    emoji: '🔵',
  },
  arbitrum: {
    id: 'arbitrum',
    label: 'Arbitrum',
    kind: 'evm',
    goplusId: '42161',
    explorerToken: 'https://arbiscan.io/token/',
    emoji: '🔹',
  },
  polygon: {
    id: 'polygon',
    label: 'Polygon',
    kind: 'evm',
    goplusId: '137',
    explorerToken: 'https://polygonscan.com/token/',
    emoji: '🟪',
  },
  optimism: {
    id: 'optimism',
    label: 'Optimism',
    kind: 'evm',
    goplusId: '10',
    explorerToken: 'https://optimistic.etherscan.io/token/',
    emoji: '🔴',
  },
  avalanche: {
    id: 'avalanche',
    label: 'Avalanche',
    kind: 'evm',
    goplusId: '43114',
    explorerToken: 'https://snowtrace.io/token/',
    emoji: '🔺',
  },
  blast: {
    id: 'blast',
    label: 'Blast',
    kind: 'evm',
    goplusId: '81457',
    explorerToken: 'https://blastscan.io/token/',
    emoji: '🟨',
  },
  /**
   * Robinhood Chain. Everything it needs was verified against a live token
   * rather than assumed: DexScreener indexes it, GoPlus covers chain 4663, and
   * the public RPC answers `eth_getLogs`, `token0()` and `decimals()`.
   *
   * GeckoTerminal had no network for it until 2026-08-20, when one appeared -
   * confirmed by pulling OHLCV for a live pool rather than by the network merely
   * being listed. So trend detection and chart cards work here now, subject to
   * the same density bar as everywhere else: the busy pools return clean
   * minute-by-minute candles, and the quiet ones return a hundred and fifty
   * "minutes" spread over four days.
   */
  robinhood: {
    id: 'robinhood',
    label: 'Robinhood Chain',
    kind: 'evm',
    goplusId: '4663',
    explorerToken: 'https://robinhoodchain.blockscout.com/token/',
    emoji: '🪶',
  },
}

/** Chain ids offered in slash command choices, in menu order. */
export const CHAIN_CHOICES = Object.values(CHAINS).map((c) => ({ name: c.label, value: c.id }))

export function getChain(chainId: string | undefined): ChainInfo | undefined {
  if (!chainId) return undefined
  return CHAINS[chainId.toLowerCase()]
}

export function isSupportedChain(chainId: string | undefined): boolean {
  return getChain(chainId) !== undefined
}

export function explorerUrl(chainId: string, tokenAddress: string): string | undefined {
  const chain = getChain(chainId)
  return chain ? `${chain.explorerToken}${tokenAddress}` : undefined
}

/** Loose shape check so we can guess the chain family from a pasted address. */
export function addressKind(address: string): 'solana' | 'evm' | 'unknown' {
  if (/^0x[a-fA-F0-9]{40}$/.test(address)) return 'evm'
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return 'solana'
  return 'unknown'
}
