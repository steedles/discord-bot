import { log } from '../logger.js'
import { fetchJson } from '../market/http.js'
import { levelFromScore, unknownRisk, type RiskFlag, type RiskReport, type RiskSeverity } from './types.js'

const BASE = 'https://api.rugcheck.xyz/v1'

interface RugcheckRisk {
  name: string
  value?: string
  description?: string
  score?: number
  level?: string
}

interface RugcheckSummary {
  tokenProgram?: string
  tokenType?: string
  risks?: RugcheckRisk[]
  score?: number
  /** 0-100, higher is riskier. */
  score_normalised?: number
  lpLockedPct?: number
}

function mapSeverity(level: string | undefined): RiskSeverity {
  switch ((level ?? '').toLowerCase()) {
    case 'danger':
      return 'danger'
    case 'warn':
    case 'warning':
      return 'warn'
    default:
      return 'info'
  }
}

/** Solana token risk via RugCheck. Free, no API key. */
export async function checkSolanaToken(mint: string): Promise<RiskReport> {
  let data: RugcheckSummary
  try {
    data = await fetchJson<RugcheckSummary>(`${BASE}/tokens/${mint}/report/summary`, {
      timeoutMs: 12_000,
      retries: 1,
    })
  } catch (err) {
    log.risk.warn({ mint, err: String(err) }, 'rugcheck lookup failed')
    return unknownRisk('RugCheck did not respond - treat this token as unverified.')
  }

  const flags: RiskFlag[] = (data.risks ?? []).map((r) => ({
    label: r.name,
    severity: mapSeverity(r.level),
    detail: r.value && r.value !== '' ? r.value : r.description,
  }))

  const raw = data.score_normalised ?? data.score ?? 0
  const score = Math.max(0, Math.min(100, Math.round(raw)))

  return {
    score,
    level: levelFromScore(score),
    flags,
    source: 'rugcheck',
    metrics: { lpLockedPct: data.lpLockedPct },
  }
}
