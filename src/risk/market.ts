import { formatAge, formatCompactUsd } from '../market/format.js'
import { pairAgeMinutes, type DexPair } from '../market/dexscreener.js'
import type { RiskFlag } from './types.js'

/**
 * Tradability facts about the pool, kept deliberately separate from the risk
 * score.
 *
 * RugCheck, GoPlus and honeypot.is answer "is this contract malicious". None of
 * them answers "is there anything in the pool right now". A clean contract on a
 * drained pool is untradeable, which for a holder is as bad as a honeypot - but
 * folding that into a vendor's score would mean overwriting their judgement
 * with ours. So these are reported as plain statements of fact alongside the
 * score, never blended into it.
 */
export interface MarketWarnings {
  flags: RiskFlag[]
  /** True when the pool is effectively empty - the headline case. */
  untradeable: boolean
}

const DEAD_LIQUIDITY_USD = 500
const VERY_LOW_LIQUIDITY_USD = 5_000
const LOW_LIQUIDITY_USD = 25_000

const VOLUME_RATIO_ALARM = 10
const RATIO_CHECK_MAX_LIQUIDITY = 250_000

export function assessMarket(pair: DexPair): MarketWarnings {
  const flags: RiskFlag[] = []

  /*
   * Not reported is not zero, and the difference is the whole section.
   *
   * DexScreener returns `liquidity: null` for pools it cannot value - every
   * pump.fun bonding curve before graduation, among others. Reading that as `0`
   * turned "nobody told us" into the strongest claim this file can make: a
   * Solana token seven minutes old, $69k traded, 588 holders and 1,069 buys was
   * headlined **POOL IS EMPTY - you would not be able to sell**. It was the same
   * failure as scoring a token "low risk" off absent GoPlus fields, in the
   * opposite direction.
   *
   * A real drain reports `{usd: 0}`, which is a measurement and still caught.
   */
  const reported = pair.liquidity?.usd
  const liquidity =
    typeof reported === 'number' && Number.isFinite(reported) ? reported : undefined
  const volume24h = pair.volume?.h24 ?? 0
  const age = pairAgeMinutes(pair)
  const untradeable = liquidity !== undefined && liquidity < DEAD_LIQUIDITY_USD

  if (liquidity === undefined) {
    flags.push({
      label: 'Liquidity not reported for this pool',
      severity: 'warn',
      // Named where it can be named. `dexId` is a fact from the same response,
      // so a bonding curve is stated as one rather than guessed at from the
      // shape of the mint.
      detail:
        pair.dexId === 'pumpfun'
          ? 'DexScreener does not publish a figure for a pump.fun bonding curve. It is not evidence that the pool is empty - the depth here has not been checked either way.'
          : 'DexScreener returned no figure for this pool, so the depth has not been checked either way.',
    })
  } else if (untradeable) {
    flags.push({
      label: `POOL IS EMPTY — ${formatCompactUsd(liquidity)} liquidity`,
      severity: 'danger',
      detail: 'You would not be able to sell. Liquidity may have been pulled.',
    })
  } else if (liquidity < VERY_LOW_LIQUIDITY_USD) {
    flags.push({
      label: `Very low liquidity (${formatCompactUsd(liquidity)})`,
      severity: 'danger',
      detail: 'Even a small sell would move the price hard.',
    })
  } else if (liquidity < LOW_LIQUIDITY_USD) {
    flags.push({ label: `Low liquidity (${formatCompactUsd(liquidity)})`, severity: 'warn' })
  }

  // Both of these compare volume against the liquidity figure, so an unmeasured
  // pool skips them rather than dividing by an assumption.
  if (liquidity !== undefined) {
    // Heavy volume against a thin pool is the signature of a pull: the trades
    // happened while liquidity was there, and it is not there now.
    if (untradeable && volume24h > 10_000) {
      flags.push({
        label: `${formatCompactUsd(volume24h)} traded in 24h, yet the pool is now empty`,
        severity: 'danger',
        detail: 'Strongly suggests liquidity was pulled.',
      })
    } else if (
      liquidity > 0 &&
      liquidity < RATIO_CHECK_MAX_LIQUIDITY &&
      volume24h > liquidity * VOLUME_RATIO_ALARM
    ) {
      flags.push({
        label: `24h volume is ${Math.round(volume24h / liquidity)}× liquidity`,
        severity: 'danger',
        detail: 'Consistent with liquidity having been removed, or with wash trading.',
      })
    }
  }

  if (age !== undefined && age < 60) {
    flags.push({ label: `Only ${formatAge(age)} old`, severity: 'warn' })
  }

  return { flags, untradeable }
}
