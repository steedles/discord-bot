import { log } from '../logger.js'
import { fetchJson, HttpError } from '../market/http.js'
import { levelFromScore, unknownRisk, type RiskFlag, type RiskLevel, type RiskReport } from './types.js'

const BASE = 'https://api.honeypot.is/v2'

/**
 * honeypot.is chain ids. It covers only these three - not Arbitrum, Polygon,
 * Optimism, Avalanche or Blast, which fall back to GoPlus flags alone.
 */
const SUPPORTED: Record<string, string> = {
  ethereum: '1',
  bsc: '56',
  base: '8453',
}

export function honeypotSupports(chainId: string): boolean {
  return chainId in SUPPORTED
}

interface HoneypotResponse {
  token?: { name?: string; symbol?: string; totalHolders?: number }
  simulationSuccess?: boolean
  honeypotResult?: { isHoneypot?: boolean; honeypotReason?: string }
  simulationResult?: { buyTax?: number; sellTax?: number; transferTax?: number }
  summary?: {
    risk?: string
    riskLevel?: number
    flags?: { flag?: string; description?: string; severity?: string }[]
  }
  pair?: { liquidity?: number }
  error?: string
  code?: number
}

/** honeypot.is risk words, mapped to our levels. */
const RISK_WORD: Record<string, RiskLevel> = {
  very_low: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  very_high: 'critical',
  critical: 'critical',
}

/**
 * EVM token risk from honeypot.is.
 *
 * Unlike a flag checklist, this actually simulates a buy and a sell against a
 * forked chain state, so it answers the question that matters - can this be
 * sold - rather than inferring it from contract properties. Its verdict is used
 * as-is; nothing here invents a score.
 */
export async function checkHoneypot(chainId: string, address: string): Promise<RiskReport> {
  const numericChain = SUPPORTED[chainId]
  if (!numericChain) return unknownRisk(`honeypot.is does not cover ${chainId}.`)

  let data: HoneypotResponse
  try {
    data = await fetchJson<HoneypotResponse>(
      `${BASE}/IsHoneypot?address=${address}&chainID=${numericChain}`,
      { timeoutMs: 15_000, retries: 1 },
    )
  } catch (err) {
    // 404 means it could not find a tradeable pair to simulate against. That is
    // not proof the token is safe or unsafe - it may simply be on a DEX
    // honeypot.is does not index - so it stays "unknown" and the liquidity
    // warning does the talking.
    if (err instanceof HttpError && err.status === 404) {
      return unknownRisk('honeypot.is found no tradeable pair to simulate against.')
    }
    log.risk.warn({ address, chainId, err: String(err) }, 'honeypot.is lookup failed')
    return unknownRisk('honeypot.is did not respond.')
  }

  if (data.error) return unknownRisk(`honeypot.is: ${data.error}`)

  const flags: RiskFlag[] = []
  const summary = data.summary ?? {}

  if (data.honeypotResult?.isHoneypot) {
    flags.push({
      label: 'HONEYPOT — a simulated sell failed',
      severity: 'danger',
      detail: data.honeypotResult.honeypotReason,
    })
  }

  for (const f of summary.flags ?? []) {
    if (!f.flag && !f.description) continue
    flags.push({
      label: f.description || f.flag!,
      severity: f.severity === 'high' || f.severity === 'critical' ? 'danger' : 'warn',
    })
  }

  const buyTax = data.simulationResult?.buyTax
  const sellTax = data.simulationResult?.sellTax
  const worstTax = Math.max(buyTax ?? 0, sellTax ?? 0)
  if (worstTax >= 25) {
    flags.push({ label: `Very high tax (${worstTax.toFixed(1)}% measured on a real trade)`, severity: 'danger' })
  } else if (worstTax >= 10) {
    flags.push({ label: `High tax (${worstTax.toFixed(1)}% measured on a real trade)`, severity: 'warn' })
  }

  if (data.simulationSuccess === false) {
    flags.push({ label: 'Trade simulation did not succeed', severity: 'danger' })
  }

  // The vendor's own number and word. A honeypot is critical regardless of what
  // the summary says, since that is a definitive finding rather than a rating.
  const vendorScore = typeof summary.riskLevel === 'number' ? Math.max(0, Math.min(100, summary.riskLevel)) : undefined
  const vendorLevel = RISK_WORD[(summary.risk ?? '').toLowerCase()]

  if (vendorScore === undefined && vendorLevel === undefined && !data.honeypotResult) {
    return unknownRisk('honeypot.is returned no verdict for this token.')
  }

  const level: RiskLevel = data.honeypotResult?.isHoneypot
    ? 'critical'
    : (vendorLevel ?? levelFromScore(vendorScore ?? 0))

  const score = data.honeypotResult?.isHoneypot ? 100 : (vendorScore ?? scoreForLevel(level))

  return {
    score,
    level,
    flags,
    source: 'honeypot',
    metrics: {
      ...(buyTax !== undefined ? { buyTaxPct: buyTax } : {}),
      ...(sellTax !== undefined ? { sellTaxPct: sellTax } : {}),
      /*
       * The holder count, and it beats GoPlus's on the chains honeypot.is
       * covers - `checkEvmChain` spreads these metrics last for exactly this
       * reason.
       *
       * GoPlus's `holder_count` is a figure from whenever it last indexed the
       * contract, and for a token launched recently that is routinely the hour
       * it appeared: BOMB on Ethereum read `holder_count: 2` with 92 holders,
       * because GoPlus had seen it once, with the supply still in the contract.
       * honeypot.is derives its number from transfer analysis performed for the
       * request, so it describes the token now rather than when somebody first
       * asked about it.
       */
      ...(typeof data.token?.totalHolders === 'number' && data.token.totalHolders >= 0
        ? { holderCount: data.token.totalHolders }
        : {}),
    },
  }
}

/** Representative number when a provider gives a word but no figure. */
export function scoreForLevel(level: RiskLevel): number {
  switch (level) {
    case 'critical':
      return 85
    case 'high':
      return 60
    case 'medium':
      return 35
    case 'low':
      return 10
    default:
      return 0
  }
}
