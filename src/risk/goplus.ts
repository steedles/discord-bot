import { log } from '../logger.js'
import { fetchJson } from '../market/http.js'
import { scoreForLevel } from './honeypot.js'
import { unknownRisk, type RiskFlag, type RiskLevel, type RiskReport } from './types.js'

const BASE = 'https://api.gopluslabs.io/api/v1'

export interface GoPlusHolder {
  address: string
  tag?: string
  is_contract?: number
  balance?: string
  percent?: string
  is_locked?: number
}

export interface GoPlusToken {
  is_honeypot?: string
  cannot_sell_all?: string
  is_open_source?: string
  is_proxy?: string
  is_mintable?: string
  can_take_back_ownership?: string
  hidden_owner?: string
  transfer_pausable?: string
  slippage_modifiable?: string
  is_blacklisted?: string
  is_whitelisted?: string
  trading_cooldown?: string
  personal_slippage_modifiable?: string
  buy_tax?: string
  sell_tax?: string
  owner_address?: string
  creator_percent?: string
  holder_count?: string
  lp_holders?: GoPlusHolder[]
  holders?: GoPlusHolder[]
}

interface GoPlusResponse {
  code: number
  message: string
  result?: Record<string, GoPlusToken>
}

const num = (v: string | undefined): number | undefined => {
  if (v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

const isTrue = (v: string | undefined): boolean => v === '1'

/**
 * The checks that matter most. If GoPlus has not answered these, it has not
 * meaningfully looked at the contract - see the coverage handling below.
 */
const CRITICAL_FIELDS: (keyof GoPlusToken)[] = [
  'is_honeypot',
  'cannot_sell_all',
  'is_mintable',
  'transfer_pausable',
  'can_take_back_ownership',
  'hidden_owner',
  'slippage_modifiable',
  'is_blacklisted',
]

/**
 * GoPlus findings mapped to a severity band.
 *
 * These are NOT weights to be summed. GoPlus returns facts, not a score, so the
 * only honest translation is "the worst thing the vendor found decides the
 * level". Adding invented numbers together produced the failure this replaced:
 * a token with no findings at all scoring the same as one verified clean.
 */
const BOOLEAN_RULES: {
  key: keyof GoPlusToken
  band: RiskLevel
  label: string
  severity: 'warn' | 'danger'
}[] = [
  { key: 'is_honeypot', band: 'critical', label: 'Honeypot - cannot sell', severity: 'danger' },
  { key: 'cannot_sell_all', band: 'critical', label: 'Cannot sell entire balance', severity: 'danger' },
  { key: 'hidden_owner', band: 'high', label: 'Hidden owner', severity: 'danger' },
  { key: 'can_take_back_ownership', band: 'high', label: 'Ownership can be reclaimed', severity: 'danger' },
  { key: 'transfer_pausable', band: 'medium', label: 'Transfers can be paused', severity: 'warn' },
  { key: 'slippage_modifiable', band: 'medium', label: 'Tax can be changed', severity: 'warn' },
  { key: 'is_mintable', band: 'medium', label: 'Supply is mintable', severity: 'warn' },
  { key: 'is_blacklisted', band: 'medium', label: 'Has a blacklist', severity: 'warn' },
  { key: 'is_proxy', band: 'low', label: 'Proxy contract (upgradeable)', severity: 'warn' },
  { key: 'trading_cooldown', band: 'low', label: 'Trading cooldown', severity: 'warn' },
]

const BAND_ORDER: RiskLevel[] = ['unknown', 'low', 'medium', 'high', 'critical']
const worst = (a: RiskLevel, b: RiskLevel): RiskLevel =>
  BAND_ORDER.indexOf(b) > BAND_ORDER.indexOf(a) ? b : a

const rawCache = new Map<string, { at: number; token: GoPlusToken }>()
const RAW_TTL_MS = 10 * 60_000
const RAW_MAX_ENTRIES = 1_000

/**
 * The raw vendor record.
 *
 * Exported because the holder profile needs the parts `checkEvmToken` discards -
 * per-wallet percentages - and GoPlus is free-tier rate limited, so both callers
 * share one cached response rather than each fetching the same contract.
 *
 * Throws when the request fails; returns undefined when GoPlus simply holds no
 * record for the contract. Callers depend on telling those two apart, and a
 * missing record is not cached because it usually means "too new", which fixes
 * itself minutes later.
 */
export async function fetchGoPlusToken(
  goplusChainId: string,
  address: string,
): Promise<GoPlusToken | undefined> {
  const key = `${goplusChainId}:${address.toLowerCase()}`
  const hit = rawCache.get(key)
  if (hit && Date.now() - hit.at < RAW_TTL_MS) return hit.token

  const data = await fetchJson<GoPlusResponse>(
    `${BASE}/token_security/${goplusChainId}?contract_addresses=${address.toLowerCase()}`,
    { timeoutMs: 12_000, retries: 1 },
  )

  const token = data.result?.[address.toLowerCase()]
  if (!token) return undefined

  if (rawCache.size >= RAW_MAX_ENTRIES) {
    const oldest = rawCache.keys().next().value
    if (oldest !== undefined) rawCache.delete(oldest)
  }
  rawCache.set(key, { at: Date.now(), token })

  return token
}

/** EVM token risk via GoPlus Security. Free, no API key. */
export async function checkEvmToken(goplusChainId: string, address: string): Promise<RiskReport> {
  let token: GoPlusToken | undefined
  try {
    token = await fetchGoPlusToken(goplusChainId, address)
  } catch (err) {
    log.risk.warn({ address, goplusChainId, err: String(err) }, 'goplus lookup failed')
    return unknownRisk('GoPlus did not respond - treat this token as unverified.')
  }

  if (!token) {
    return unknownRisk('GoPlus has no data for this contract yet - very new or unsupported chain.')
  }

  const flags: RiskFlag[] = []
  let band: RiskLevel = 'unknown'

  for (const rule of BOOLEAN_RULES) {
    if (isTrue(token[rule.key] as string | undefined)) {
      band = worst(band, rule.band)
      flags.push({ label: rule.label, severity: rule.severity })
    }
  }

  /*
   * GoPlus omits a field entirely when it has not analysed that property, which
   * is common on contracts only a few hours old. Every rule above then matches
   * nothing, and an unanalysed token comes out looking identical to a
   * verified-clean one. Measure what it actually answered.
   */
  const answered = CRITICAL_FIELDS.filter((k) => {
    const v = token[k] as string | undefined
    return v === '0' || v === '1'
  })
  const coverage = answered.length / CRITICAL_FIELDS.length

  // GoPlus reports taxes as decimals: "0.05" means 5%.
  const buyTax = num(token.buy_tax)
  const sellTax = num(token.sell_tax)
  const worstTax = Math.max(buyTax ?? 0, sellTax ?? 0)
  if (worstTax >= 0.25) {
    band = worst(band, 'high')
    flags.push({ label: `Very high tax (${(worstTax * 100).toFixed(1)}%)`, severity: 'danger' })
  } else if (worstTax >= 0.1) {
    band = worst(band, 'medium')
    flags.push({ label: `High tax (${(worstTax * 100).toFixed(1)}%)`, severity: 'warn' })
  }

  if (token.is_open_source === '0') {
    band = worst(band, 'high')
    flags.push({ label: 'Contract source not verified', severity: 'danger' })
  }

  const creatorPct = num(token.creator_percent)
  if (creatorPct !== undefined && creatorPct >= 0.05) {
    band = worst(band, 'medium')
    flags.push({ label: `Creator holds ${(creatorPct * 100).toFixed(1)}% of supply`, severity: 'warn' })
  }

  const topHolderPct = num(token.holders?.[0]?.percent)
  if (topHolderPct !== undefined && topHolderPct >= 0.3 && token.holders?.[0]?.is_contract !== 1) {
    band = worst(band, 'medium')
    flags.push({ label: `Top wallet holds ${(topHolderPct * 100).toFixed(1)}%`, severity: 'warn' })
  }

  const lpLockedPct = lockedLiquidityPct(token.lp_holders)
  const holderCount = num(token.holder_count)
  if (lpLockedPct !== undefined && lpLockedPct < 50) {
    /*
     * GoPlus cannot always tell "LP was never locked" from "the lock is in a
     * contract I do not recognise", and established tokens routinely burn LP in
     * ways it does not detect. On a token with a real holder base that reads as
     * a false alarm, so it is reported but does not by itself set a medium
     * verdict. On a thin-holder token it remains a genuine rug signal.
     */
    const established = (holderCount ?? 0) >= 1_000
    band = worst(band, established ? 'low' : 'medium')
    flags.push({
      label: `Only ${lpLockedPct.toFixed(0)}% of LP is locked or burned`,
      severity: 'warn',
      ...(established ? { detail: 'May be a detection gap on an established token' } : {}),
    })
  }

  /*
   * Barely analysed. Reporting "low" here is what made a drained BSC token look
   * safe. Note this must beat incidental low-severity findings too: a lone
   * "proxy contract" flag is not evidence the token was checked, and letting it
   * lift the band out of `unknown` reintroduced exactly the original bug.
   *
   * A definite high/critical finding is a real vendor verdict, so that still
   * reports through even on thin coverage.
   */
  if (coverage < 0.5 && BAND_ORDER.indexOf(band) <= BAND_ORDER.indexOf('low')) {
    return {
      score: 0,
      level: 'unknown',
      flags: [
        {
          label: `GoPlus answered only ${answered.length}/${CRITICAL_FIELDS.length} safety checks`,
          severity: 'warn',
          detail: 'Usually means the contract is too new to have been analysed',
        },
        ...flags,
      ],
      source: 'goplus',
      metrics: {
        lpLockedPct,
        holderCount,
        dataCoveragePct: Math.round(coverage * 100),
      },
      note: 'GoPlus has not analysed this contract yet - treat it as unverified, not as safe.',
    }
  }

  if (band === 'unknown') band = 'low'
  if (coverage < 0.85) {
    flags.push({
      label: `Partially analysed - ${answered.length}/${CRITICAL_FIELDS.length} safety checks answered`,
      severity: 'warn',
    })
  }

  return {
    score: scoreForLevel(band),
    level: band,
    flags,
    source: 'goplus',
    metrics: {
      lpLockedPct,
      holderCount: num(token.holder_count),
      buyTaxPct: buyTax !== undefined ? buyTax * 100 : undefined,
      sellTaxPct: sellTax !== undefined ? sellTax * 100 : undefined,
      topHolderPct: topHolderPct !== undefined ? topHolderPct * 100 : undefined,
      creatorPct: creatorPct !== undefined ? creatorPct * 100 : undefined,
      dataCoveragePct: Math.round(coverage * 100),
    },
  }
}

const BURN_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
])

function lockedLiquidityPct(lpHolders: GoPlusHolder[] | undefined): number | undefined {
  if (!lpHolders || lpHolders.length === 0) return undefined

  const locked = lpHolders.reduce((sum, h) => {
    const pct = num(h.percent) ?? 0
    const isBurned = BURN_ADDRESSES.has(h.address.toLowerCase())
    return sum + (h.is_locked === 1 || isBurned ? pct : 0)
  }, 0)

  return Math.min(100, locked * 100)
}
