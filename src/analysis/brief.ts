import { getChain } from '../market/chains.js'
import { pairAgeMinutes, priceOf, type DexPair } from '../market/dexscreener.js'
import { formatAge, formatCompactUsd, formatPercent, formatUsdPrice } from '../market/format.js'
import type { HolderProfile } from '../risk/holders.js'
import type { RiskReport } from '../risk/index.js'

/**
 * Turns the raw numbers for a token into something a person can read.
 *
 * Two rules hold this together:
 *
 * 1. **Every sentence is tied to a number we actually have.** Nothing is
 *    inferred, softened or invented. If a provider did not answer, that goes in
 *    `notChecked` rather than being guessed at - the same reason the risk score
 *    is always a vendor's.
 * 2. **The vendor's findings and ours stay in separate columns.** `sections`
 *    ends with what the risk provider said; `concerns` is what the market and
 *    distribution numbers say. They never restate each other, so a reader can
 *    see when the two disagree - which is exactly when a token is interesting.
 *
 * Output is plain data. Rendering it as a Discord embed, console text or
 * anything else is somebody else's problem.
 */

export interface BriefLine {
  label: string
  value: string
  /** Plain English: why the number matters. Omitted when it speaks for itself. */
  meaning?: string
}

export interface BriefSection {
  title: string
  lines: BriefLine[]
  /** Pre-formatted bullets, used for vendor findings. */
  bullets?: string[]
}

export interface TokenBrief {
  title: string
  subtitle: string
  verdict: { emoji: string; text: string }
  /** One paragraph covering what this token is and where it stands. */
  summary: string
  sections: BriefSection[]
  /** What the numbers warn about, worst first. */
  concerns: string[]
  /** What the numbers say in its favour. */
  inFavour: string[]
  /** Questions nobody answered. Never left implicit. */
  notChecked: string[]
  sources: string[]
}

/** Ranked so the reader sees the worst thing first, not the first thing found. */
interface Weighted {
  weight: number
  text: string
}

const LEVEL_WORD: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  critical: 'critical',
  unknown: 'unrated',
}

/** Vendors are named as they name themselves - it is their verdict, not ours. */
const VENDOR_NAME: Record<string, string[]> = {
  rugcheck: ['RugCheck'],
  goplus: ['GoPlus'],
  honeypot: ['honeypot.is'],
  'honeypot+goplus': ['honeypot.is', 'GoPlus'],
  none: ['no provider'],
}

const vendorNames = (source: string): string[] => VENDOR_NAME[source] ?? [source]

/**
 * A verdict can come from two vendors at once, so sentences are phrased to put
 * them at the end - "scores 1/100 with honeypot.is and GoPlus" rather than
 * anything that has to agree with them in number.
 */
const vendor = (source: string): string => vendorNames(source).join(' and ')

const article = (word: string): string => (/^[aeiou]/i.test(word) ? 'an' : 'a')

export interface BriefContext {
  now?: number
  /**
   * Liquidity across every pool the token trades in, not just the quoted one.
   *
   * This matters more than it looks. A token with a dozen pools has its depth
   * spread across them, so measuring the market cap against a single pool made
   * BONK read as "market cap is 1643x liquidity" - the signature of a drained
   * token, on one of the most liquid memecoins there is.
   */
  totalLiquidityUsd?: number
  /** 24h volume across those same pools. */
  totalVolume24hUsd?: number
  poolCount?: number
}

export function buildBrief(
  pair: DexPair,
  report: RiskReport,
  holders: HolderProfile,
  context: BriefContext = {},
): TokenBrief {
  const { now = Date.now(), poolCount } = context
  const chain = getChain(pair.chainId)
  const price = priceOf(pair)
  const mcap = pair.marketCap ?? pair.fdv
  const poolLiquidity = pair.liquidity?.usd
  const liquidity = context.totalLiquidityUsd ?? poolLiquidity
  const ageMinutes = pairAgeMinutes(pair, now)
  const mcapToLiq = mcap && liquidity && liquidity > 0 ? mcap / liquidity : undefined

  return {
    title: `${pair.baseToken.symbol} · ${pair.baseToken.name}`,
    subtitle: [chain?.label ?? pair.chainId, pair.dexId, holders.launchpad]
      .filter(Boolean)
      .join(' · '),
    verdict: verdict(report),
    summary: summary(pair, report, holders, price, mcap, liquidity, ageMinutes),
    sections: [
      marketSection(pair, price, mcap, liquidity, poolCount, ageMinutes, mcapToLiq),
      activitySection(pair, liquidity, context.totalVolume24hUsd, poolCount),
      ...(holders.source === 'none' ? [] : [holdersSection(holders)]),
      safetySection(report, holders),
    ],
    concerns: rank(concerns(pair, report, holders, mcapToLiq, ageMinutes)),
    inFavour: rank(inFavour(pair, report, holders, liquidity, mcapToLiq, ageMinutes)),
    notChecked: notChecked(report, holders, chain?.label ?? pair.chainId),
    sources: sources(report, holders),
  }
}

// --- headline -------------------------------------------------------------

function verdict(report: RiskReport): { emoji: string; text: string } {
  if (report.tradability?.untradeable) {
    return { emoji: '🚫', text: 'Cannot be traded - there is nothing left in the pool' }
  }
  if (report.level === 'unknown') {
    return {
      emoji: '⚪',
      text: 'Unrated - no provider would vouch for this contract, which is not the same as clean',
    }
  }
  return {
    emoji: { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' }[report.level] ?? '⚪',
    text: `${LEVEL_WORD[report.level]} risk - the contract scores ${report.score}/100 with ${vendor(report.source)}, lower being safer`,
  }
}

function summary(
  pair: DexPair,
  report: RiskReport,
  holders: HolderProfile,
  price: number | undefined,
  mcap: number | undefined,
  liquidity: number | undefined,
  ageMinutes: number | undefined,
): string {
  const chain = getChain(pair.chainId)?.label ?? pair.chainId
  const launched = holders.launchpad ? ` launched on ${holders.launchpad}` : ''
  const age = ageMinutes !== undefined ? `${humanAge(ageMinutes)} old` : 'of unknown age'

  const opening =
    mcap === undefined
      ? `trading at ${formatUsdPrice(price)}`
      : `trading at ${formatUsdPrice(price)} on a ${formatCompactUsd(mcap)}${pair.marketCap === undefined ? ' fully diluted' : ''} market cap`

  const parts = [
    `**${pair.baseToken.symbol}** is ${article(chain)} ${chain} token${launched}, ${age}, ${opening}`,
  ]

  const backing = [
    liquidity !== undefined ? `${formatCompactUsd(liquidity)} of liquidity` : '',
    holders.totalHolders !== undefined ? `${holders.totalHolders.toLocaleString()} holders` : '',
  ].filter(Boolean)

  if (backing.length > 0) parts.push(`backed by ${backing.join(' and ')}`)

  const tail =
    report.level === 'unknown'
      ? 'No risk provider has rated the contract.'
      : `The contract is rated ${LEVEL_WORD[report.level]} risk by ${vendor(report.source)}.`

  return `${parts.join(', ')}. ${tail}`
}

// --- sections -------------------------------------------------------------

function marketSection(
  pair: DexPair,
  price: number | undefined,
  mcap: number | undefined,
  liquidity: number | undefined,
  poolCount: number | undefined,
  ageMinutes: number | undefined,
  mcapToLiq: number | undefined,
): BriefSection {
  const lines: BriefLine[] = []

  const moves = [
    pair.priceChange?.h1 !== undefined ? `${formatPercent(pair.priceChange.h1)} in the last hour` : '',
    pair.priceChange?.h24 !== undefined ? `${formatPercent(pair.priceChange.h24)} over 24h` : '',
  ].filter(Boolean)

  lines.push({
    label: 'Price',
    value: formatUsdPrice(price),
    ...(moves.length > 0 ? { meaning: moves.join(', ') } : {}),
  })

  if (mcap !== undefined) {
    lines.push({
      label: pair.marketCap === undefined ? 'Market cap (FDV)' : 'Market cap',
      value: formatCompactUsd(mcap),
      ...(pair.marketCap === undefined
        ? { meaning: 'fully diluted - counts tokens that are not circulating yet' }
        : {}),
    })
  }

  if (liquidity !== undefined) {
    const spread = poolCount !== undefined && poolCount > 1 ? ` across ${poolCount} pools` : ''
    lines.push({
      label: 'Liquidity',
      value: `${formatCompactUsd(liquidity)}${spread}`,
      meaning:
        mcapToLiq === undefined
          ? 'the money actually available to sell into'
          : `market cap is ${round(mcapToLiq)}x that, ${depthPhrase(mcapToLiq)}`,
    })
  }

  if (ageMinutes !== undefined) {
    lines.push({ label: 'Age', value: humanAge(ageMinutes), meaning: agePhrase(ageMinutes) })
  }

  return { title: '💰 Price and market', lines }
}

function activitySection(
  pair: DexPair,
  liquidity: number | undefined,
  totalVolume24h: number | undefined,
  poolCount: number | undefined,
): BriefSection {
  const lines: BriefLine[] = []
  const vol24 = totalVolume24h ?? pair.volume?.h24
  const vol1 = pair.volume?.h1

  if (vol24 !== undefined) {
    lines.push({
      label: 'Volume 24h',
      value: formatCompactUsd(vol24),
      ...(liquidity && liquidity > 0 ? { meaning: turnoverPhrase(vol24 / liquidity) } : {}),
    })
  }

  // Trade counts are per-pool - DexScreener does not aggregate them - so on a
  // token with several pools they are labelled rather than quietly presented as
  // the whole picture.
  const scope = poolCount !== undefined && poolCount > 1 ? ' in the main pool' : ''

  const h1 = pair.txns?.h1
  if (h1) {
    lines.push({
      label: `Last hour${scope}`,
      value: `${trades(h1)}${vol1 !== undefined ? ` · ${formatCompactUsd(vol1)}` : ''}`,
      meaning: flowPhrase(h1.buys, h1.sells),
    })
  }

  const h24 = pair.txns?.h24
  if (h24) {
    lines.push({
      label: `Last 24h${scope}`,
      value: trades(h24),
      meaning: flowPhrase(h24.buys, h24.sells),
    })
  }

  return { title: '📊 Trading activity', lines }
}

function holdersSection(holders: HolderProfile): BriefSection {
  const lines: BriefLine[] = []

  if (holders.totalHolders !== undefined) {
    lines.push({
      label: 'Holders',
      value: holders.totalHolders.toLocaleString(),
      meaning: holderCountPhrase(holders.totalHolders),
    })
  }

  const top = holders.wallets.slice(0, 5)
  if (top.length > 0) {
    const combined = holders.top5Pct ?? 0
    lines.push({
      label: `Top ${top.length} wallets`,
      value: `${pct(combined)} combined (${top.map((w) => pct(w.pct)).join(' · ')})`,
      meaning: concentrationPhrase(combined, top[0]!.pct),
    })
  }

  if (holders.creatorPct !== undefined) {
    lines.push({
      label: 'Creator wallet',
      value: pct(holders.creatorPct),
      meaning:
        holders.creatorPct < 0.5
          ? 'nothing left to dump, though it may have been sold already'
          : 'held by the deployer, and it can be sold at any time',
    })
  }

  if (holders.insiderPct !== undefined && holders.sampleSize !== undefined) {
    lines.push({
      label: 'Insider-linked',
      value: pct(holders.insiderPct),
      meaning: `of the ${holders.sampleSize} wallets checked, flagged by RugCheck as connected to the launch`,
    })
  }

  return { title: '👥 Who holds it', lines }
}

function safetySection(report: RiskReport, holders: HolderProfile): BriefSection {
  const lines: BriefLine[] = []

  lines.push({
    label: 'Contract check',
    value:
      report.level === 'unknown'
        ? 'no rating'
        : `${report.score}/100 ${LEVEL_WORD[report.level]}`,
    meaning:
      report.level === 'unknown'
        ? (report.note ?? 'the provider had no answer')
        : `via ${vendor(report.source)}`,
  })

  const m = report.metrics
  if (m.lpLockedPct !== undefined) {
    lines.push({
      label: 'LP locked or burned',
      value: pct(m.lpLockedPct),
      meaning:
        m.lpLockedPct >= 90
          ? 'liquidity cannot simply be walked away with'
          : 'unlocked liquidity can be pulled by whoever holds it',
    })
  }
  if (m.buyTaxPct !== undefined || m.sellTaxPct !== undefined) {
    lines.push({
      label: 'Tax',
      value: `${pct(m.buyTaxPct ?? 0)} buy / ${pct(m.sellTaxPct ?? 0)} sell`,
      meaning: 'taken by the contract on every trade',
    })
  }
  if (holders.mutableMetadata === true) {
    lines.push({
      label: 'Metadata',
      value: 'still mutable',
      meaning: 'the name, symbol and image can be rewritten after you buy',
    })
  }

  // The vendor's own words, worst first. Ours live in `concerns`.
  const bullets = [
    ...report.flags.filter((f) => f.severity === 'danger').map((f) => `🔴 ${f.label}`),
    ...report.flags.filter((f) => f.severity === 'warn').map((f) => `🟡 ${f.label}`),
  ].slice(0, 6)

  if (bullets.length === 0 && report.level !== 'unknown') {
    bullets.push('✅ The provider returned no contract-level findings')
  }

  return { title: '🛡️ Safety checks', lines, bullets }
}

// --- judgement calls, all tied to a number --------------------------------

function concerns(
  pair: DexPair,
  report: RiskReport,
  holders: HolderProfile,
  mcapToLiq: number | undefined,
  ageMinutes: number | undefined,
): Weighted[] {
  const out: Weighted[] = []

  // Pool facts the vendors do not look at, phrased by assessMarket() already.
  // Its age warning is dropped: we say the same thing below with the reason
  // attached, and the same point twice in one list reads as two problems.
  for (const flag of report.tradability?.flags ?? []) {
    if (/\bold$/.test(flag.label)) continue
    out.push({
      weight: flag.severity === 'danger' ? 95 : 45,
      text: sentence(`${flag.label}${flag.detail ? `. ${flag.detail}` : ''}`),
    })
  }

  if (holders.rugged === true) {
    out.push({ weight: 100, text: 'RugCheck has this token marked as already rugged.' })
  }

  if (mcapToLiq !== undefined && mcapToLiq >= 10) {
    out.push({
      weight: mcapToLiq >= 25 ? 75 : 60,
      text: `Market cap is ${round(mcapToLiq)}x the liquidity backing it, so the paper valuation is far ahead of the money anyone could actually take out.`,
    })
  }

  const largest = holders.wallets[0]
  if (largest && largest.pct >= 10) {
    out.push({
      weight: largest.pct >= 20 ? 80 : 60,
      text: `The largest wallet holds ${pct(largest.pct)} of supply - enough to move the price on its own.`,
    })
  }

  if (holders.top5Pct !== undefined && holders.top5Pct >= 25) {
    out.push({
      weight: holders.top5Pct >= 40 ? 70 : 50,
      text: `The top ${Math.min(5, holders.wallets.length)} wallets hold ${pct(holders.top5Pct)} between them.`,
    })
  }

  if (holders.creatorPct !== undefined && holders.creatorPct >= 5) {
    out.push({
      weight: holders.creatorPct >= 10 ? 65 : 45,
      text: `The creator still holds ${pct(holders.creatorPct)} of supply.`,
    })
  }

  if (holders.insiderPct !== undefined && holders.insiderPct >= 10) {
    out.push({
      weight: 55,
      text: `${pct(holders.insiderPct)} sits in wallets RugCheck links back to the launch.`,
    })
  }

  const h1 = pair.txns?.h1
  if (h1 && h1.sells > h1.buys * 1.3 && h1.sells >= 20) {
    out.push({
      weight: 45,
      text: `${h1.sells.toLocaleString()} sells against ${h1.buys.toLocaleString()} buys in the last hour - that is distribution, not accumulation.`,
    })
  }

  const change24 = pair.priceChange?.h24
  if (change24 !== undefined && change24 <= -40) {
    out.push({ weight: 55, text: `Down ${Math.abs(change24).toFixed(0)}% over the last 24 hours.` })
  }

  if (holders.totalHolders !== undefined && holders.totalHolders < 500) {
    out.push({
      weight: holders.totalHolders < 100 ? 50 : 30,
      text: `Only ${holders.totalHolders.toLocaleString()} wallets hold it, so a handful of exits is the whole market.`,
    })
  }

  if (ageMinutes !== undefined && ageMinutes < 60) {
    out.push({
      weight: 40,
      text: `The pool is ${formatAge(ageMinutes)} old - there is no trading history to judge it by.`,
    })
  }

  return out
}

function inFavour(
  pair: DexPair,
  report: RiskReport,
  holders: HolderProfile,
  liquidity: number | undefined,
  mcapToLiq: number | undefined,
  ageMinutes: number | undefined,
): Weighted[] {
  const out: Weighted[] = []

  if (holders.top5Pct !== undefined && holders.top5Pct < 10 && holders.wallets.length >= 5) {
    out.push({
      weight: 70,
      text: `The five largest wallets hold only ${pct(holders.top5Pct)} between them - no one holder can dump this.`,
    })
  }

  if (holders.creatorPct !== undefined && holders.creatorPct < 0.5) {
    out.push({ weight: 55, text: 'The creator wallet is empty.' })
  }

  if (mcapToLiq !== undefined && mcapToLiq < 5 && liquidity !== undefined && liquidity >= 50_000) {
    out.push({
      weight: 60,
      text: `${formatCompactUsd(liquidity)} of liquidity against a ${round(mcapToLiq)}x market cap - deep enough to trade size.`,
    })
  }

  if (report.metrics.lpLockedPct !== undefined && report.metrics.lpLockedPct >= 90) {
    out.push({ weight: 50, text: `${pct(report.metrics.lpLockedPct)} of the LP is locked or burned.` })
  }

  if (report.level === 'low' && report.flags.length === 0) {
    out.push({ weight: 45, text: `${vendor(report.source)} found nothing wrong with the contract.` })
  }

  if (ageMinutes !== undefined && ageMinutes > 60 * 24 * 30) {
    out.push({
      weight: 40,
      text: `It has been trading for ${humanAge(ageMinutes)} - not a launch-day token.`,
    })
  }

  const h1 = pair.txns?.h1
  if (h1 && h1.buys > h1.sells * 1.3 && h1.buys >= 20) {
    out.push({
      weight: 30,
      text: `${h1.buys.toLocaleString()} buys against ${h1.sells.toLocaleString()} sells in the last hour.`,
    })
  }

  if (holders.totalHolders !== undefined && holders.totalHolders >= 5_000) {
    out.push({ weight: 35, text: `${holders.totalHolders.toLocaleString()} wallets hold it.` })
  }

  return out
}

function notChecked(report: RiskReport, holders: HolderProfile, chainLabel: string): string[] {
  const out: string[] = []

  if (holders.source === 'none') {
    out.push(sentence(`Holder distribution - ${trim(holders.note) ?? `no provider covers ${chainLabel}`}`))
  }
  if (report.level === 'unknown') {
    out.push(sentence(`Contract safety - ${trim(report.note) ?? 'no provider returned a verdict'}`))
  }
  if (report.metrics.dataCoveragePct !== undefined && report.metrics.dataCoveragePct < 85) {
    out.push(
      `The provider answered only ${report.metrics.dataCoveragePct}% of its own safety checklist, usually because the contract is too new.`,
    )
  }

  // Rick and similar bots report this; our providers do not, and guessing at it
  // would be exactly the kind of invented number this bot refuses to print.
  out.push('How new the holder wallets are, and whether the launch was sniped or bundled.')

  return out
}

function sources(report: RiskReport, holders: HolderProfile): string[] {
  const out = new Set(['DexScreener'])
  for (const source of [report.source, holders.source]) {
    if (source === 'none') continue
    for (const name of vendorNames(source)) out.add(name)
  }
  return [...out]
}

// --- phrasing -------------------------------------------------------------

/**
 * `formatAge` is tuned for launch-scanner output, where everything is hours old
 * and "995.5d" never comes up. A brief can land on a three-year-old token.
 */
function humanAge(minutes: number): string {
  const days = minutes / (60 * 24)
  if (days < 60) return formatAge(minutes)
  if (days < 365) return `${Math.round(days / 30)} months`
  return `${(days / 365).toFixed(1)} years`
}

const trades = (t: { buys: number; sells: number }): string =>
  `${t.buys.toLocaleString()} ${t.buys === 1 ? 'buy' : 'buys'} / ${t.sells.toLocaleString()} ${t.sells === 1 ? 'sell' : 'sells'}`

function turnoverPhrase(ratio: number): string {
  if (ratio >= 1) return `${round(ratio)}x the pooled liquidity changed hands`
  if (ratio >= 0.1) return `about ${Math.round(ratio * 100)}% of the pooled liquidity changed hands`
  return 'barely a fraction of the pooled liquidity changed hands'
}

function depthPhrase(ratio: number): string {
  if (ratio >= 25) return 'so even a modest sell moves the price hard'
  if (ratio >= 10) return 'which is thin for the valuation'
  if (ratio >= 4) return 'which is normal for a small cap'
  return 'which is unusually well backed'
}

function agePhrase(minutes: number): string {
  if (minutes < 60) return 'minted within the hour, and most tokens this age do not last the day'
  if (minutes < 60 * 24) return 'launched today'
  if (minutes < 60 * 24 * 7) return 'launched this week'
  if (minutes < 60 * 24 * 90) return 'has survived a few weeks of trading'
  return 'an established pool by memecoin standards'
}

function flowPhrase(buys: number, sells: number): string {
  if (buys + sells < 10) return 'barely trading'
  if (sells > buys * 1.3) return 'sellers well ahead of buyers'
  if (buys > sells * 1.3) return 'buyers well ahead of sellers'
  return 'buyers and sellers roughly matched'
}

function holderCountPhrase(count: number): string {
  if (count < 100) return 'a very small base - a few wallets are the entire market'
  if (count < 1_000) return 'a small base, typical of a fresh launch'
  if (count < 10_000) return 'a real, if young, holder base'
  return 'widely held'
}

function concentrationPhrase(combined: number, largest: number): string {
  if (largest >= 20) return 'one wallet dominates the supply'
  if (combined >= 40) return 'heavily concentrated'
  if (combined >= 20) return 'somewhat concentrated'
  if (combined >= 10) return 'reasonably spread'
  return 'cleanly distributed, with low single-wallet dump risk'
}

/** Vendor flag labels are fragments; the concern list is prose. */
const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`)

/** Vendor notes are already sentences, so drop the stop before quoting one. */
const trim = (note: string | undefined): string | undefined => note?.replace(/\.$/, '')

const round = (n: number): string => (n >= 10 ? Math.round(n).toString() : n.toFixed(1))
const pct = (n: number): string => `${n >= 10 ? n.toFixed(0) : n.toFixed(n < 1 ? 2 : 1)}%`

/** Worst first, capped - a list nobody finishes reading protects nobody. */
function rank(items: Weighted[], limit = 5): string[] {
  return [...items]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map((i) => i.text)
}
