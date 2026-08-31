import { CHAINS } from '../../market/chains.js'
import { EvmProvider } from './evm.js'
import { SolanaProvider } from './solana.js'
import type { ChainDataProvider, PriceLookup, ProviderHealth } from './types.js'

/**
 * The set of chains the monitor watches, built once at startup.
 *
 * Every chain in `CHAINS` gets a provider, because spike and momentum detection
 * only needs DexScreener and that works everywhere. Whale detection is the part
 * that varies, and each provider reports its own `whaleSupport` rather than the
 * registry deciding for it.
 *
 * Adding a chain is therefore an edit to `CHAINS` and nothing else - which is
 * how Robinhood Chain was added after its RPC, explorer and GoPlus coverage
 * were verified. There is no per-chain code here to keep in step.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, ChainDataProvider>()

  constructor(priceLookup: PriceLookup) {
    for (const chain of Object.values(CHAINS)) {
      this.providers.set(
        chain.id,
        chain.kind === 'solana'
          ? new SolanaProvider(priceLookup)
          : new EvmProvider(chain.id, priceLookup),
      )
    }
  }

  get(chainId: string): ChainDataProvider | undefined {
    return this.providers.get(chainId)
  }

  all(): ChainDataProvider[] {
    return [...this.providers.values()]
  }

  /** The EVM providers, which are the ones that can hand over pool layouts. */
  evm(): EvmProvider[] {
    return this.all().filter((p): p is EvmProvider => p instanceof EvmProvider)
  }

  /** The Solana provider, when it exists - the webhook route needs it by name. */
  solana(): SolanaProvider | undefined {
    const provider = this.providers.get('solana')
    return provider instanceof SolanaProvider ? provider : undefined
  }

  health(): ProviderHealth[] {
    return this.all().map((p) => p.health())
  }

  /** Chains that can report real individual swaps right now. */
  whaleCapableChains(): string[] {
    return this.all()
      .filter((p) => p.whaleSupport !== 'unsupported')
      .map((p) => p.chainId)
  }
}
