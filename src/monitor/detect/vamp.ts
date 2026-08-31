/**
 * Ticker vamps: a newer token wearing an older one's name, and taking its flow.
 *
 * The trench meaning of "vamping" is narrow and it is the one implemented here:
 * somebody launches a *different* mint under a ticker that is already running,
 * and the copy starts out-trading the original. It is not the DeFi sense of a
 * vampire attack on a protocol's liquidity, and it is not a token migrating to
 * a fresh pool - that is the same mint and a different question.
 *
 * ## Same ticker is not proof of a copy, so the alert never claims one
 *
 * Tickers collide constantly and honestly. Every claim this detector makes is
 * therefore something it measured: which pool was created first, how far apart,
 * what each traded in the last hour, and whether the names match as well as the
 * tickers. Intent is not measurable and is never stated. What the reader is
 * handed is two tokens and their figures.
 *
 * Four rules keep that honest:
 *
 *  - **Both creation times must be known.** Which one is the copy rests
 *    entirely on which came second. Unknown means no alert rather than a guess.
 *  - **Same chain only.** A matching ticker on another chain is usually a
 *    bridge or an unrelated project, and comparing an hour of volume across two
 *    chains is not comparing one audience.
 *  - **The original must have traded.** The claim is a ratio, and an absent
 *    denominator cannot be told apart from a quiet one.
 *  - **Two-character tickers and shorter are ignored.** At that length a match
 *    is a collision by default.
 *
 * ## Which side the channel hears about
 *
 * Both are worth knowing and they are different trades, so `target` is a
 * setting rather than a rule - the same shape as the direction filter on volume
 * spikes. A channel holding bags wants to hear that something is draining its
 * coin; a channel trading the trenches wants the copy, because the copy is
 * often the one that runs. The alert always renders the **watched** token, so
 * whichever side fires, the contract, links and gates in the message are the
 * ones the reader is being pointed at.
 */
import { formatAge, formatCompactUsd } from '../../market/format.js'
import type { MarketSnapshot } from '../providers/types.js'
import type { Trigger } from './types.js'

export interface VampConfig {
  /** Which side of the pairing this channel wants to hear about. */
  target: 'original' | 'copycat' | 'both'
  /** How many times the older token's 1h volume the newer one must be doing. */
  minVolumeRatio: number
  /** Absolute floor on the newer token's 1h volume. */
  minCopycatVolume1hUsd: number
  /** Depth behind the copy. A pool nobody can trade out of is not taking flow. */
  minCopycatLiquidityUsd: number
  /** Trades in the copy's last hour. Volume from four wallets is a wash. */
  minCopycatTrades1h: number
  /** Older than this and a shared ticker is not vamping anything any more. */
  maxCopycatAgeMinutes: number
  /** At or above this ratio the alert may ping a role. */
  highPriorityRatio: number
}

/**
 * Tickers compared as the market says them, not as they are spelled.
 *
 * `$WIF`, `wif` and `W.I.F` are one ticker to everybody reading a chat. Returns
 * undefined for anything too short to be a match rather than a coincidence.
 */
export function normaliseTicker(symbol: string | undefined): string | undefined {
  const cleaned = (symbol ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return cleaned.length >= 3 ? cleaned : undefined
}

/** Names compared the same way, so "Peanut The Squirrel" matches "peanut the squirrel". */
function normaliseName(name: string | undefined): string {
  return (name ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

interface Pairing {
  original: MarketSnapshot
  copycat: MarketSnapshot
  /** True when the watched token is the newer of the two. */
  subjectIsCopycat: boolean
  ratio: number
  gapMinutes: number
  copycatAgeMinutes: number
}

export function detectVamp(
  subject: MarketSnapshot,
  rivals: MarketSnapshot[],
  config: VampConfig,
  now = subject.fetchedAt,
): Trigger | undefined {
  const ticker = normaliseTicker(subject.symbol)
  if (ticker === undefined) return undefined

  const subjectCreated = subject.pairCreatedAt
  if (subjectCreated === undefined) return undefined

  const pairings: Pairing[] = []

  for (const rival of rivals) {
    if (rival.chainId !== subject.chainId) continue
    if (sameToken(rival, subject)) continue
    if (normaliseTicker(rival.symbol) !== ticker) continue

    const rivalCreated = rival.pairCreatedAt
    if (rivalCreated === undefined) continue
    // Launched in the same instant is not a copy of anything, and the
    // comparison has no direction to state.
    if (rivalCreated === subjectCreated) continue

    const subjectIsCopycat = subjectCreated > rivalCreated
    const copycat = subjectIsCopycat ? subject : rival
    const original = subjectIsCopycat ? rival : subject

    if (config.target === 'original' && subjectIsCopycat) continue
    if (config.target === 'copycat' && !subjectIsCopycat) continue

    const copycatAgeMinutes = (now - copycat.pairCreatedAt!) / 60_000
    if (copycatAgeMinutes > config.maxCopycatAgeMinutes) continue

    const copycatVolume = copycat.volume.h1
    const originalVolume = original.volume.h1
    if (copycatVolume === undefined || !Number.isFinite(copycatVolume)) continue
    if (originalVolume === undefined || !(originalVolume > 0)) continue

    if (!isAThreat(copycat, copycatVolume, config)) continue

    const ratio = copycatVolume / originalVolume
    if (ratio < config.minVolumeRatio) continue

    pairings.push({
      original,
      copycat,
      subjectIsCopycat,
      ratio,
      gapMinutes: (copycat.pairCreatedAt! - original.pairCreatedAt!) / 60_000,
      copycatAgeMinutes,
    })
  }

  if (pairings.length === 0) return undefined

  // The one taking the most flow is the one worth naming. A ticker with three
  // copies on it produces one alert about the biggest, not three alerts.
  const best = pairings.reduce((a, b) => (b.ratio > a.ratio ? b : a))
  const other = best.subjectIsCopycat ? best.original : best.copycat

  return {
    kind: 'vamp',
    headline: best.subjectIsCopycat
      ? `out-trading the original $${normaliseTicker(subject.symbol)} ${best.ratio.toFixed(1)}x, launched ${formatAge(best.gapMinutes)} after it`
      : `a newer $${normaliseTicker(subject.symbol)} is out-trading it ${best.ratio.toFixed(1)}x`,
    value: best.ratio,
    threshold: config.minVolumeRatio,
    priority: best.ratio >= config.highPriorityRatio ? 'high' : 'normal',
    score: best.ratio / config.minVolumeRatio,
    detail: [
      `${best.subjectIsCopycat ? 'Original' : 'Copy'}: ${other.name} - ${formatCompactUsd(other.volume.h1)} in 1h against this token's ${formatCompactUsd(subject.volume.h1)}`,
      // The copy's own standing, always - it is the whole reason this is an
      // alert rather than a shared ticker, and when the watched token is the
      // original these are the only figures about it in the message.
      `The newer one is ${formatAge(best.copycatAgeMinutes)} old with ${formatCompactUsd(best.copycat.liquidityUsd)} liquidity and ${tradeCount(best.copycat)} in 1h`,
      `Its pool was created ${formatAge(best.gapMinutes)} ${best.subjectIsCopycat ? 'before' : 'after'} this one`,
      nameLine(best.original, best.copycat),
      `\`${other.tokenAddress}\`${other.url ? ` · [chart](${other.url})` : ''}`,
    ],
  }
}

/**
 * Whether the copy is a threat or merely a mint.
 *
 * This is the gate the feature lives or dies on. Copy tickers are made
 * constantly - a running coin will have a dozen namesakes by the afternoon, and
 * nearly all of them are an empty pool and a hopeful ticker. Alerting on the
 * *existence* of one would be a feed of noise that trains the channel to ignore
 * the one that mattered.
 *
 * So three things have to be true of the copy itself, independently of how the
 * original is doing: real depth behind it, a real number of people trading it,
 * and a real hour of volume. Only then is the ratio against the original worth
 * computing, because only then is there something to compare.
 *
 * Note where these are checked. The monitor's ordinary quality gates apply to
 * the *watched* token, so a channel set to hear about its own coins being
 * drained gates the original and nothing else - the copy would arrive
 * completely unfiltered. These fill that hole, and they are the same rule as
 * everywhere else: a figure the provider did not report fails the gate rather
 * than skipping it.
 */
function isAThreat(copycat: MarketSnapshot, copycatVolume: number, config: VampConfig): boolean {
  if (copycatVolume < config.minCopycatVolume1hUsd) return false

  if (config.minCopycatLiquidityUsd > 0) {
    const liquidity = copycat.liquidityUsd
    if (liquidity === undefined || liquidity < config.minCopycatLiquidityUsd) return false
  }

  if (config.minCopycatTrades1h > 0) {
    const txns = copycat.txns.h1
    if (txns === undefined) return false
    if (txns.buys + txns.sells < config.minCopycatTrades1h) return false
  }

  return true
}

/**
 * What actually matched, said plainly.
 *
 * The reader needs this to judge the pairing for themselves: two tokens sharing
 * a ticker and nothing else is a collision far more often than it is a copy,
 * and the detector is in no position to tell which.
 */
function nameLine(original: MarketSnapshot, copycat: MarketSnapshot): string {
  return normaliseName(original.name) === normaliseName(copycat.name)
    ? 'Ticker and name both match'
    : `Ticker matches, names differ - "${original.name}" and "${copycat.name}"`
}

/** Trades in the last hour, or an honest silence when the provider did not say. */
function tradeCount(snapshot: MarketSnapshot): string {
  const txns = snapshot.txns.h1
  if (txns === undefined) return 'an unreported number of trades'
  return `${(txns.buys + txns.sells).toLocaleString()} trades`
}

function sameToken(a: MarketSnapshot, b: MarketSnapshot): boolean {
  return a.tokenAddress.toLowerCase() === b.tokenAddress.toLowerCase()
}
