import { getChain } from '../market/chains.js'
import { checkEvmToken } from './goplus.js'
import { checkHoneypot, honeypotSupports } from './honeypot.js'
import { checkSolanaToken } from './rugcheck.js'
import { unknownRisk, type RiskFlag, type RiskReport } from './types.js'

/**
 * EVM risk, preferring a vendor that actually simulates a trade.
 *
 * honeypot.is buys and sells the token against forked chain state, so its
 * verdict answers "can this be sold" directly. GoPlus only returns contract
 * properties and no score of its own, so where honeypot.is has an opinion it
 * decides the level, and GoPlus is merged in for supporting detail (LP lock,
 * holder counts, mintability). Where honeypot.is has no coverage - Arbitrum,
 * Polygon, Optimism, Avalanche, Blast - GoPlus stands alone.
 */
async function checkEvmChain(
  chainId: string,
  goplusId: string,
  address: string,
): Promise<RiskReport> {
  if (!honeypotSupports(chainId)) return checkEvmToken(goplusId, address)

  const [honeypot, goplus] = await Promise.all([
    checkHoneypot(chainId, address),
    checkEvmToken(goplusId, address).catch(() => unknownRisk('GoPlus lookup failed.')),
  ])

  // Neither vendor reached a verdict: say so rather than inventing one.
  if (honeypot.level === 'unknown' && goplus.level === 'unknown') {
    return {
      ...honeypot,
      flags: dedupeFlags([...honeypot.flags, ...goplus.flags]),
      metrics: { ...goplus.metrics, ...honeypot.metrics },
      note: [honeypot.note, goplus.note].filter(Boolean).join(' '),
    }
  }

  // honeypot.is could not simulate, but GoPlus did analyse the contract.
  if (honeypot.level === 'unknown') {
    return {
      ...goplus,
      flags: dedupeFlags([...goplus.flags, ...honeypot.flags]),
      note: honeypot.note,
    }
  }

  return {
    score: honeypot.score,
    level: honeypot.level,
    flags: dedupeFlags([...honeypot.flags, ...goplus.flags]),
    source: goplus.level === 'unknown' ? 'honeypot' : 'honeypot+goplus',
    metrics: { ...goplus.metrics, ...honeypot.metrics },
    ...(goplus.note ? { note: goplus.note } : {}),
  }
}

/** Both vendors report taxes and ownership, so identical labels can collide. */
function dedupeFlags(flags: RiskFlag[]): RiskFlag[] {
  const seen = new Set<string>()
  return flags.filter((f) => {
    const key = f.label.toLowerCase().replace(/[\d.]+/g, '')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export * from './types.js'
export * from './market.js'

/** Cheap in-process cache - risk data barely moves and the free APIs are rate limited. */
const cache = new Map<string, { at: number; report: RiskReport }>()
const TTL_MS = 10 * 60_000
const MAX_ENTRIES = 2_000

/** Routes to RugCheck (Solana) or GoPlus (EVM) based on the chain. */
export async function checkToken(chainId: string, tokenAddress: string): Promise<RiskReport> {
  const chain = getChain(chainId)
  if (!chain) return unknownRisk(`No risk provider configured for chain "${chainId}".`)

  const key = `${chainId}:${tokenAddress.toLowerCase()}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.report

  let report: RiskReport
  if (chain.kind === 'solana') {
    // RugCheck publishes its own normalised score; we pass it through as-is.
    report = await checkSolanaToken(tokenAddress)
  } else if (chain.goplusId) {
    report = await checkEvmChain(chain.id, chain.goplusId, tokenAddress)
  } else {
    report = unknownRisk(`No risk provider configured for ${chain.label}.`)
  }

  // Do not cache failures - the next call should retry the provider.
  if (report.source !== 'none') {
    if (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, { at: Date.now(), report })
  }

  return report
}
