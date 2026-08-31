/** Prices span 9 orders of magnitude here, so pick precision from the value. */
export function formatUsdPrice(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return 'n/a'
  if (value === 0) return '$0'
  if (value >= 1000) return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  if (value >= 1) return `$${value.toFixed(4)}`
  if (value >= 0.0001) return `$${value.toFixed(6)}`
  return `$${value.toPrecision(4)}`
}

export function formatCompactUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return 'n/a'
  const abs = Math.abs(value)
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(1)}K`
  return `$${value.toFixed(0)}`
}

export function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return 'n/a'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

export function formatAge(minutes: number | undefined): string {
  if (minutes === undefined || !Number.isFinite(minutes)) return 'unknown'
  if (minutes < 60) return `${Math.round(minutes)}m`
  if (minutes < 60 * 24) return `${(minutes / 60).toFixed(1)}h`
  return `${(minutes / (60 * 24)).toFixed(1)}d`
}

export function truncateAddress(address: string, edge = 5): string {
  if (address.length <= edge * 2 + 3) return address
  return `${address.slice(0, edge)}…${address.slice(-edge)}`
}

/**
 * Parses "1.25", "0.5k", "2m", "$1,200" into a number.
 * Returns undefined when the input is not a usable price.
 */
export function parseAmount(input: string): number | undefined {
  const cleaned = input.trim().toLowerCase().replace(/[$,\s]/g, '')
  const match = /^(\d*\.?\d+)([kmb])?$/.exec(cleaned)
  if (!match) return undefined

  const base = Number(match[1])
  if (!Number.isFinite(base) || base <= 0) return undefined

  const mult = match[2] === 'k' ? 1e3 : match[2] === 'm' ? 1e6 : match[2] === 'b' ? 1e9 : 1
  return base * mult
}
