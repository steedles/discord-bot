import type { MarketSnapshot } from '../providers/types.js'

/**
 * Quality gates every alert passes before anyone sees it.
 *
 * These are the product. A monitor that posts every 5x volume print is a monitor
 * nobody reads by the second day: most of those prints are a $3k pool that saw
 * two trades, or a pair that was created eleven minutes ago and exists to be
 * exited. The gates are what separate "unusual activity" from "activity".
 */
export interface QualityGates {
  minLiquidityUsd: number
  /** Pools younger than this are excluded. Most rugs happen inside a day. */
  minPairAgeMinutes: number
  /** Buys + sells in the trailing 5 minutes. Two trades is not a market. */
  minTxns5m: number
  minVolume24hUsd: number
  /** Empty means every supported chain. */
  chains: string[]
}

export interface GateResult {
  ok: boolean
  /** Why it was rejected, for the debug log. Never shown to a channel. */
  reason?: string
}

const PASS: GateResult = { ok: true }

/**
 * Applies the cheap gates - the ones answerable from a snapshot alone.
 *
 * Age is checked against the *busiest* pool, which is the conservative reading:
 * a token whose volume has just moved into a fresh pool reads as young and is
 * held back, which is exactly the case the age filter exists for.
 */
export function passesGates(
  snapshot: MarketSnapshot,
  gates: QualityGates,
  now = Date.now(),
): GateResult {
  if (gates.chains.length > 0 && !gates.chains.includes(snapshot.chainId)) {
    return { ok: false, reason: `chain ${snapshot.chainId} not enabled` }
  }

  const liquidity = snapshot.liquidityUsd ?? 0
  if (liquidity < gates.minLiquidityUsd) {
    return { ok: false, reason: `liquidity ${Math.round(liquidity)} below ${gates.minLiquidityUsd}` }
  }

  const volume24h = snapshot.volume.h24 ?? 0
  if (volume24h < gates.minVolume24hUsd) {
    return { ok: false, reason: `24h volume ${Math.round(volume24h)} below ${gates.minVolume24hUsd}` }
  }

  if (gates.minTxns5m > 0) {
    const txns = snapshot.txns.m5
    // No transaction data is not zero transactions, but it is also not proof of
    // activity, and this gate exists to require proof.
    const count = txns ? txns.buys + txns.sells : undefined
    if (count === undefined) return { ok: false, reason: 'no 5m transaction data' }
    if (count < gates.minTxns5m) {
      return { ok: false, reason: `${count} txns in 5m, below ${gates.minTxns5m}` }
    }
  }

  if (gates.minPairAgeMinutes > 0) {
    const age = pairAgeMinutes(snapshot, now)
    if (age === undefined) return { ok: false, reason: 'pool age unknown' }
    if (age < gates.minPairAgeMinutes) {
      return { ok: false, reason: `pool is ${Math.round(age)}m old, below ${gates.minPairAgeMinutes}m` }
    }
  }

  return PASS
}

export function pairAgeMinutes(snapshot: MarketSnapshot, now = Date.now()): number | undefined {
  if (!snapshot.pairCreatedAt) return undefined
  return Math.max(0, (now - snapshot.pairCreatedAt) / 60_000)
}

/**
 * The holder-count gate, kept separate because it costs a vendor request.
 *
 * Applied only to alerts that have already cleared everything else, so the cost
 * scales with how much gets posted rather than with the watchlist. A vendor that
 * does not answer fails the gate: an unknown holder count is unknown, and this
 * gate exists precisely to refuse tokens that cannot show one.
 */
export function passesHolderGate(
  totalHolders: number | undefined,
  minHolders: number,
): GateResult {
  if (minHolders <= 0) return PASS
  if (totalHolders === undefined) return { ok: false, reason: 'holder count unavailable' }
  if (totalHolders < minHolders) {
    return { ok: false, reason: `${totalHolders} holders, below ${minHolders}` }
  }
  return PASS
}
