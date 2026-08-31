import type { DexPair } from '../market/dexscreener.js'
import { checkToken } from './index.js'
import { assessMarket } from './market.js'
import type { RiskReport } from './types.js'

/**
 * The single entry point for "how risky is this token".
 *
 * The score is always a vendor's, never ours: RugCheck on Solana, honeypot.is
 * on the EVM chains it covers, GoPlus banding elsewhere. Pool health is
 * attached separately as `tradability` so an empty pool is stated as a fact
 * next to the score rather than silently changing it.
 *
 * Use this rather than checkToken() directly, so no surface can report a clean
 * contract sitting on a drained pool without saying so.
 */
export async function assessToken(pair: DexPair): Promise<RiskReport> {
  const [contract, market] = await Promise.all([
    checkToken(pair.chainId, pair.baseToken.address),
    Promise.resolve(assessMarket(pair)),
  ])

  return { ...contract, tradability: market }
}
