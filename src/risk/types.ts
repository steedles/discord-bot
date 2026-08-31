export type RiskSeverity = 'info' | 'warn' | 'danger'
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical' | 'unknown'

export interface RiskFlag {
  label: string
  severity: RiskSeverity
  detail?: string
}

export interface RiskReport {
  /** 0-100. Higher is riskier. */
  score: number
  level: RiskLevel
  flags: RiskFlag[]
  source: 'rugcheck' | 'goplus' | 'honeypot' | 'honeypot+goplus' | 'none'
  metrics: {
    lpLockedPct?: number
    holderCount?: number
    buyTaxPct?: number
    sellTaxPct?: number
    topHolderPct?: number
    creatorPct?: number
    /** How much of the provider's safety checklist actually returned an answer. */
    dataCoveragePct?: number
  }
  /** Set when the check could not run - the score is then not meaningful. */
  note?: string
  /**
   * Pool-level facts, kept out of `score` so a vendor's judgement is never
   * overwritten by ours. `untradeable` means the pool is effectively empty.
   */
  tradability?: { flags: RiskFlag[]; untradeable: boolean }
}

export function levelFromScore(score: number): RiskLevel {
  if (score >= 70) return 'critical'
  if (score >= 45) return 'high'
  if (score >= 20) return 'medium'
  return 'low'
}

export const LEVEL_EMOJI: Record<RiskLevel, string> = {
  low: '🟢',
  medium: '🟡',
  high: '🟠',
  critical: '🔴',
  unknown: '⚪',
}

export const LEVEL_COLOR: Record<RiskLevel, number> = {
  low: 0x2ecc71,
  medium: 0xf1c40f,
  high: 0xe67e22,
  critical: 0xe74c3c,
  unknown: 0x95a5a6,
}

export function unknownRisk(note: string): RiskReport {
  return { score: 0, level: 'unknown', flags: [], source: 'none', metrics: {}, note }
}
