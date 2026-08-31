/**
 * Two independent rug-signature checks for one Solana pump.fun mint -
 * docs/11-RUG-SIGNATURE.md v2 in fresh-start, plus a v3 addition. Neither is
 * folded into a vendor risk score, and neither changes which launches get
 * alerted on - both are advisory, and both are explicitly unproven forward.
 *
 * **The funding graph** (v2, fitted to 15 real pump.fun rugs): one wallet
 * (the "operator") funds a set of buyer wallets and the wallet that will
 * deploy the token, within seconds of each other, *before the token exists*.
 * The buyers hold from block zero and dump together once the price is high
 * enough. Every wallet involved is fresh and single-use, but the *shape* of
 * the funding graph repeats - so this checks the graph, not a blocklist of
 * wallets.
 *
 * v2, not v1 - two amendments matter to anyone reading this against the doc:
 *
 * A1: the holder-funder lookup is *inverted* from v1. v1 fanned out from the
 * funder and enumerated everything it ever paid - measured at 262
 * transactions on one coin, over 12 minutes on public RPC, abandoned. This
 * instead asks, for each of the (at most 20) current top holders, who funded
 * *them* - bounded by holder count, not by how busy the operator's wallet was.
 *
 * A2: holders come from the RugCheck report already fetched for the creator
 * (free), not from `getTokenLargestAccounts` (429s immediately on public RPC,
 * no burst allowance).
 *
 * A4: fail loud. A missing input returns `unknown`, never `clean` - v1 had no
 * such distinction, and during v2's own benchmarking a throttled call
 * returned nothing, the intersection came back empty, and that scored as a
 * pass. A rug-checker that fails open is worse than none, because it is
 * trusted. `unknown` verdicts are also never cached (see checkRugSignature) -
 * a mint that could not be resolved this cycle is still eligible next cycle,
 * since the input that was missing may simply not exist yet.
 *
 * **The holder-distribution flatness check** (v3, added 2026-08-25): the
 * funding graph is fitted to launches where the buyer wallets are fresh and
 * single-use. NINE1NINE (mint `V6hhzCkoBqaiw5E8bdKoaMo7VrS1f29tGBn7LC1pump`)
 * defeated it with aged, reused wallets - every one of its top 20 holders
 * came back `not-fresh` (1,000+ signatures each), so the funding graph
 * returned `unknown`. What it could not hide was its *distribution*: eleven
 * wallets holding between 1.448% and 1.508% of supply, a spread of six
 * hundredths of a percentage point. Organic holders follow a power law; a
 * flat line is a script. `computeDistributionSignal` measures the
 * coefficient of variation (population stdev / mean) of the top 10 non-pool
 * holders' `pct`, which costs zero RPC calls - it reads the same holder list
 * the funding graph already has, from a report `getHolderProfile` already
 * fetched. That is the whole argument for running it always, not as a
 * fallback: the funding graph costs 75-80 RPC calls and returns `unknown`
 * roughly 87% of the time on real launches, so a free, independent test running
 * unconditionally alongside it is close to free coverage.
 *
 * `DISTRIBUTION_CV_FLAG_THRESHOLD` was calibrated against a live-fetched
 * control set of 60 recently-graduated pump.fun coins (57 scored; 3 had too
 * few resolvable non-pool holders), not guessed - see the threshold's own
 * comment for the numbers and for two things that surprised the
 * investigation: a cluster of exact-zero-CV controls turned out to be real
 * (independently corroborated by RugCheck's own "High holder correlation"
 * risk flag) rather than a data artifact, and the signal decays fast enough
 * that the control set itself measures the wrong regime - see that comment
 * for what this means for the threshold's precision.
 *
 * Combined verdict: `flag` if *either* test flags, `clean` only if at least
 * one test ran to completion and neither flagged, `unknown` if both were
 * inconclusive. `unknown` is never conflated with `clean` for either test on
 * its own, same as the funding graph's own A4 rule - a distribution that
 * could not be measured (too few resolvable non-pool holders) is `unknown`,
 * never read as "checked and flat" or "checked and organic".
 */
import type { RugCheck } from '../db/models.js'
import { getCollections } from '../db/mongo.js'
import { log } from '../logger.js'
import { mapWithConcurrency } from '../market/http.js'
import { oldestSignaturesIfFresh, transactionBalanceChanges } from '../market/solana-rpc.js'
import { getHolderProfile, type OwnedHolder } from './holders.js'

/** doc §2 step 3: holder set is bounded at 20 - that is what makes step 4 cheap. */
const MAX_HOLDERS = 20
/** doc §8: below this the holder set is too thin to say anything. */
const MIN_HOLDERS = 5
/** doc §8: a partial resolution is not scored - it is `unknown`. */
const MIN_RESOLVED_FRACTION = 0.6
/** doc §2 step 4: "parallel at width 4". */
const HOLDER_FUNDING_CONCURRENCY = 4
/** doc §5: this alone is the finding. */
const TIGHT_COHORT_THRESHOLD = 3
/** doc §5: "funded within 60 seconds of the creator". */
const TIGHT_WINDOW_SECONDS = 60
/**
 * doc §3: nine of fifteen creator wallets were funded with an amount whose
 * last five lamport digits were this tail, from nine different funders - a
 * cheap corroborator, logged and shown, never a gate on its own. Expected to
 * rot the moment the operator changes one constant.
 */
const LAUNCHER_TAILS = new Set([39280])

/**
 * Below this, the distribution measurement is too thin to say anything - same
 * discipline as MIN_HOLDERS above: absence of data is `unknown`, never
 * `clean`. Explicit in the v3 investigation notes: "fewer than ~8 resolvable
 * non-pool holders means unknown, never clean."
 */
const MIN_DISTRIBUTION_HOLDERS = 8
/** "Top 10 non-pool holders" - the fixed sample the CV is computed over. */
const DISTRIBUTION_SAMPLE_SIZE = 10

/**
 * Below this coefficient of variation, a top-10 holder distribution is
 * scripted-flat rather than organic. Calibrated 2026-08-25 against a
 * live-fetched control set (`coins?complete=true&sort=created_timestamp`,
 * 60 fetched / 57 scored - 3 had fewer than `MIN_DISTRIBUTION_HOLDERS`
 * resolvable non-pool holders):
 *
 *   min 0.0000 | p25 0.365 | median 0.974 | p75 1.681 | max 2.556
 *
 * Five of those 57 read exactly ~0.0000 CV - investigated rather than
 * assumed. They are not a data artifact: RugCheck's own report on each one
 * independently carries a "High holder correlation" risk flag ("the top
 * users hold similar supply amounts"), with a count matching this test's own
 * cohort size. So the near-zero cluster is corroborated real flatness, not
 * five broken readings - but it is also a base rate: roughly 1 in 11 ordinary
 * pump.fun graduates in this sample already looks bot-sniped-flat by this
 * measure, before any funding-graph signal is considered. That, plus the
 * point below, is why the threshold sits low rather than being pulled up to
 * meet the control set's low-end cluster.
 *
 * The harder problem: `coins?complete=true` only returns already-graduated
 * tokens, and every control-set reading above is therefore *post*-decay -
 * this bot's own production check runs *pre*-graduation, while the cohort is
 * still intact (see `maybeRugCheck` in launch-scanner.ts, and the doc note
 * that the check must never move later). NINE1NINE itself demonstrates the
 * gap directly: 0.066 CV the morning it was measured pre-graduation, 0.594 CV
 * hours later once re-checked here as part of this same control-set run - a
 * roughly 9x move from ordinary post-launch selling, not from anything wrong
 * with the metric. So this control set describes what an *already-traded*
 * distribution looks like, not what this check will actually see in
 * production, and there was no practical way to build a clean pre-graduation
 * control set instead - a bonding-curve-stage token rarely has
 * `MIN_DISTRIBUTION_HOLDERS` resolvable holders yet, and pump.fun's own
 * listing API does not reliably surface fresh, still-curving mints by filter.
 *
 * Given that mismatch, the threshold is set low and inside the one clean gap
 * this sample actually has - nothing scored between 0.015 and 0.108 across
 * all 57 - rather than reaching up toward the control set's p25 (0.365),
 * which would risk flagging ordinary decayed-but-organic launches. 0.10
 * comfortably clears NINE1NINE's own real pre-graduation reading (0.066) and
 * where LOKI's would sit (0.034, also caught by the funding graph, so no
 * signal is lost if the funding graph alone would have caught it) with
 * margin, while staying under the next organic cluster in-sample
 * (MoonLai/MEOWCAT/GTA6 Coin, 0.108-0.116). The one plausible false positive
 * in-sample is DUCKSON at 0.015 - no RugCheck correlation flag, but also not
 * provably organic, since RugCheck's own detector likely runs on a larger
 * holder set with different math and cannot be treated as ground truth
 * either. Biasing toward under-flagging is deliberate: this is one advisory
 * signal among several a human or downstream system weighs, and a missed
 * bundle costs nothing this check did not already cost before it existed,
 * while a wrongly-flagged organic launch would unfairly taint a real coin.
 */
const DISTRIBUTION_CV_FLAG_THRESHOLD = 0.1

export type RugVerdict = 'flag' | 'clean' | 'unknown'

export interface RugCheckResult {
  verdict: RugVerdict
  fundingVerdict: RugVerdict
  cohortSize: number
  tightCohortSize: number
  checkedHolders: number
  totalHolders: number
  cohortSharePct?: number
  funderWallet?: string
  creatorWallet?: string
  tailMatch: boolean
  distributionVerdict: RugVerdict
  /** Population CV of the top-10 non-pool holders' pct. `null` when unknown. */
  distributionCv: number | null
  /** How many holders fed the CV - up to `DISTRIBUTION_SAMPLE_SIZE`. `null` when unknown. */
  distributionCohort: number | null
  reason: string
}

/**
 * `flag` and `clean` are cached forever - the funding graph a real verdict
 * reads is permanent on-chain history, so it never changes, and a cached row
 * short-circuits here without spending another RPC call.
 *
 * `unknown` is never treated as cached: whatever input was missing (a fresh
 * mint's holder set not settled yet, a throttled call) may simply not exist
 * yet, so a mint last seen `unknown` always gets a fresh attempt. The result
 * is still *written* - upserted over any previous `unknown` row - purely so a
 * different reader (the launch alert, the signal intake) can see "checked,
 * inconclusive" instead of nothing at all. See `RugCheck` in db/models.ts.
 */
export async function checkRugSignature(mint: string): Promise<RugCheckResult> {
  const { rugChecks } = getCollections()

  const cached = await rugChecks.findOne({ chainId: 'solana', mint })
  if (cached && cached.verdict !== 'unknown') return toResult(cached)

  const result = await computeRugSignature(mint)
  try {
    await rugChecks.updateOne(
      { chainId: 'solana', mint },
      { $set: { chainId: 'solana', mint, checkedAt: new Date(), ...result } },
      { upsert: true },
    )
  } catch (err) {
    log.risk.warn({ err: String(err), mint }, 'could not persist rug check')
  }

  return result
}

function toResult(row: RugCheck): RugCheckResult {
  return {
    verdict: row.verdict,
    // `?? 'unknown'` covers rows cached before the v3 distribution check
    // existed - a stale row genuinely never ran it, which is what `unknown`
    // means here, not a guess dressed up as one.
    fundingVerdict: row.fundingVerdict ?? 'unknown',
    cohortSize: row.cohortSize,
    tightCohortSize: row.tightCohortSize,
    checkedHolders: row.checkedHolders,
    totalHolders: row.totalHolders,
    ...(row.cohortSharePct !== undefined ? { cohortSharePct: row.cohortSharePct } : {}),
    ...(row.funderWallet ? { funderWallet: row.funderWallet } : {}),
    ...(row.creatorWallet ? { creatorWallet: row.creatorWallet } : {}),
    tailMatch: row.tailMatch,
    distributionVerdict: row.distributionVerdict ?? 'unknown',
    distributionCv: row.distributionCv ?? null,
    distributionCohort: row.distributionCohort ?? null,
    reason: row.reason,
  }
}

function unresolved(reason: string, extra: Partial<RugCheckResult> = {}): RugCheckResult {
  return {
    verdict: 'unknown',
    fundingVerdict: 'unknown',
    cohortSize: 0,
    tightCohortSize: 0,
    checkedHolders: 0,
    totalHolders: 0,
    tailMatch: false,
    distributionVerdict: 'unknown',
    distributionCv: null,
    distributionCohort: null,
    reason,
    ...extra,
  }
}

interface Funding {
  funder: string
  lamports: number
  ts: number
}

/**
 * A wallet's first-ever funding: its oldest transaction, whoever's balance
 * dropped in it. `undefined` when the wallet has more history than fits in
 * one page (not fresh - doc §2 step 2) or the funding could not be resolved.
 */
/**
 * Why a funding lookup produced nothing.
 *
 * `not-fresh` is not a failure - it is the answer "this wallet has thousands of
 * transactions", which the signature's own premise (doc §1: every wallet fresh and
 * single-use) makes meaningful on its own. It used to be indistinguishable from a
 * dead RPC call, so half of all checks reported ignorance about coins they had
 * actually learned something definite about.
 */
type FundingMiss = 'not-fresh' | 'no-history' | 'no-funder-in-first-tx'
type FundingLookup = { ok: true; funding: Funding } | { ok: false; miss: FundingMiss; atLeast?: number }

async function firstFunding(wallet: string): Promise<FundingLookup> {
  const history = await oldestSignaturesIfFresh(wallet)
  if (history.kind === 'not-fresh') return { ok: false, miss: 'not-fresh', atLeast: history.atLeast }

  const sigs = history.signatures
  if (sigs.length === 0) return { ok: false, miss: 'no-history' }

  const oldest = sigs[0]!
  const tx = await transactionBalanceChanges(oldest.signature)
  if (!tx) return { ok: false, miss: 'no-funder-in-first-tx' }

  const walletChange = tx.changes.find((c) => c.account === wallet)
  const funderChange = tx.changes
    .filter((c) => c.account !== wallet && c.deltaLamports < 0)
    .sort((a, b) => a.deltaLamports - b.deltaLamports)[0]
  const ts = tx.blockTime ?? oldest.blockTime

  if (!walletChange || walletChange.deltaLamports <= 0 || !funderChange || ts === null) {
    return { ok: false, miss: 'no-funder-in-first-tx' }
  }

  return { ok: true, funding: { funder: funderChange.account, lamports: walletChange.deltaLamports, ts } }
}

interface FundingSignal {
  verdict: RugVerdict
  cohortSize: number
  tightCohortSize: number
  checkedHolders: number
  cohortSharePct?: number
  funderWallet?: string
  tailMatch: boolean
  reason: string
}

/**
 * Steps 2-5 of the funding graph (doc §2), against an already-resolved
 * creator and holder set. Pulled out of `computeRugSignature` so it can run
 * as one independent signal alongside the distribution check rather than the
 * two being interleaved - `computeDistributionSignal` needs none of this.
 */
async function computeFundingSignal(mint: string, creator: string, holders: OwnedHolder[]): Promise<FundingSignal> {
  // Step 2 - one hop back: who funded the creator.
  let lookup: FundingLookup
  try {
    lookup = await firstFunding(creator)
  } catch (err) {
    log.risk.warn({ err: String(err), mint, creator }, 'rug check: creator funding lookup failed')
    return { verdict: 'unknown', cohortSize: 0, tightCohortSize: 0, checkedHolders: 0, tailMatch: false, reason: 'error' }
  }
  if (!lookup.ok) {
    // Each miss keeps its own reason. All three used to collapse into
    // `creator-funding-unresolved`, which read as "the check broke" for what is
    // usually "the check does not apply to a wallet shaped like this".
    //
    // Still `unknown`, not `clean`: the cohort was never computed, and doc §5's
    // fail-loud rule is explicit that "could not check" and "checked and clean"
    // must not look the same. What changes is that the caller can now tell WHY,
    // and `creator-not-fresh` is a finding rather than a shrug - a creator with
    // thousands of prior transactions is the opposite of the fresh single-use
    // wallet the whole signature is built on.
    const reason =
      lookup.miss === 'not-fresh'
        ? 'creator-not-fresh'
        : lookup.miss === 'no-history'
          ? 'creator-no-history'
          : 'creator-funding-unresolved'
    log.risk.info(
      { mint, creator, miss: lookup.miss, atLeast: lookup.atLeast },
      'rug check: creator funding not resolvable',
    )
    return { verdict: 'unknown', cohortSize: 0, tightCohortSize: 0, checkedHolders: 0, tailMatch: false, reason }
  }
  const fund = lookup.funding

  const tailMatch = LAUNCHER_TAILS.has(fund.lamports % 100_000)

  // Step 3 (v2 A1, inverted from v1) - who funded each holder, bounded by
  // holder count rather than by the funder's own transaction volume.
  let funderByHolder: (Funding | undefined)[]
  try {
    funderByHolder = await mapWithConcurrency(
      holders,
      (h) =>
        firstFunding(h.owner)
          .then((r) => (r.ok ? r.funding : undefined))
          .catch((err) => {
            log.risk.debug({ err: String(err), mint, holder: h.owner }, 'rug check: holder funding failed, skipping')
            return undefined
          }),
      HOLDER_FUNDING_CONCURRENCY,
    )
  } catch (err) {
    log.risk.warn({ err: String(err), mint }, 'rug check: holder funding lookup failed')
    return {
      verdict: 'unknown',
      cohortSize: 0,
      tightCohortSize: 0,
      checkedHolders: 0,
      funderWallet: fund.funder,
      tailMatch,
      reason: 'error',
    }
  }

  const resolved = holders
    .map((h, i) => ({ holder: h, funding: funderByHolder[i] }))
    .filter((r): r is { holder: OwnedHolder; funding: Funding } => Boolean(r.funding))

  // A partial resolution is not scored - it is unknown (doc §5 "Fail loud").
  if (resolved.length < holders.length * MIN_RESOLVED_FRACTION) {
    return {
      verdict: 'unknown',
      cohortSize: 0,
      tightCohortSize: 0,
      checkedHolders: resolved.length,
      funderWallet: fund.funder,
      tailMatch,
      reason: `only ${resolved.length}/${holders.length} holders resolved`,
    }
  }

  // Step 5 - score.
  const cohort = resolved.filter((r) => r.funding.funder === fund.funder)
  const tight = cohort.filter((r) => Math.abs(r.funding.ts - fund.ts) <= TIGHT_WINDOW_SECONDS)
  const cohortSharePct = cohort.reduce((sum, r) => sum + r.holder.pct, 0)
  const verdict: RugVerdict = tight.length >= TIGHT_COHORT_THRESHOLD ? 'flag' : 'clean'

  return {
    verdict,
    cohortSize: cohort.length,
    tightCohortSize: tight.length,
    checkedHolders: resolved.length,
    ...(cohortSharePct > 0 ? { cohortSharePct } : {}),
    funderWallet: fund.funder,
    tailMatch,
    reason: verdict === 'flag' ? 'operator-funded-holders' : 'no-shared-funder',
  }
}

export interface DistributionSignal {
  verdict: RugVerdict
  cv: number | null
  cohort: number | null
  reason: string
}

/** Population coefficient of variation: stdev / mean. */
function coefficientOfVariation(values: number[]): number {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
  return Math.sqrt(variance) / mean
}

/**
 * v3 - see the file header for what this catches that the funding graph
 * cannot, and the threshold's own comment for how it was calibrated. Zero RPC
 * calls: it reads the same holder list the funding graph already resolved.
 *
 * Insider-tagged wallets are excluded before taking the top 10. RugCheck
 * marks a wallet `insider` when it is already linked to the creator/team - a
 * flat *disclosed* allocation is a different, non-deceptive thing from a set
 * of anonymous-looking retail wallets landing on the same share, and RugCheck
 * already surfaces insider concentration on its own (`insiderPct`). Measured
 * with zero effect on the control set used to pick the threshold below - no
 * insider-tagged wallet appeared in any of its 57 top-10s - so this is a
 * correctness choice for real bundles, not one that moved the calibration.
 */
export function computeDistributionSignal(holders: OwnedHolder[]): DistributionSignal {
  const candidates = holders.filter((h) => !h.insider).slice(0, DISTRIBUTION_SAMPLE_SIZE)
  if (candidates.length < MIN_DISTRIBUTION_HOLDERS) {
    return {
      verdict: 'unknown',
      cv: null,
      cohort: null,
      reason: `only ${candidates.length}/${MIN_DISTRIBUTION_HOLDERS} non-pool holders resolvable`,
    }
  }

  const cv = coefficientOfVariation(candidates.map((h) => h.pct))
  const verdict: RugVerdict = cv < DISTRIBUTION_CV_FLAG_THRESHOLD ? 'flag' : 'clean'

  return {
    verdict,
    cv,
    cohort: candidates.length,
    reason: verdict === 'flag' ? 'flat-holder-distribution' : 'organic-distribution',
  }
}

/**
 * Overall verdict rules (file header): `flag` if either signal flags, `clean`
 * only if at least one ran to completion and neither flagged, `unknown` if
 * both were inconclusive.
 */
function combineSignals(
  creator: string,
  totalHolders: number,
  funding: FundingSignal,
  distribution: DistributionSignal,
): RugCheckResult {
  const verdict: RugVerdict =
    funding.verdict === 'flag' || distribution.verdict === 'flag'
      ? 'flag'
      : funding.verdict === 'unknown' && distribution.verdict === 'unknown'
        ? 'unknown'
        : 'clean'

  const reason =
    funding.verdict === 'flag' && distribution.verdict === 'flag'
      ? `${funding.reason}+${distribution.reason}`
      : funding.verdict === 'flag'
        ? funding.reason
        : distribution.verdict === 'flag'
          ? distribution.reason
          : verdict === 'unknown'
            ? `${funding.reason}; ${distribution.reason}`
            : funding.verdict === 'clean'
              ? funding.reason
              : distribution.reason

  return {
    verdict,
    fundingVerdict: funding.verdict,
    cohortSize: funding.cohortSize,
    tightCohortSize: funding.tightCohortSize,
    checkedHolders: funding.checkedHolders,
    totalHolders,
    ...(funding.cohortSharePct !== undefined ? { cohortSharePct: funding.cohortSharePct } : {}),
    ...(funding.funderWallet ? { funderWallet: funding.funderWallet } : {}),
    creatorWallet: creator,
    tailMatch: funding.tailMatch,
    distributionVerdict: distribution.verdict,
    distributionCv: distribution.cv,
    distributionCohort: distribution.cohort,
    reason,
  }
}

async function computeRugSignature(mint: string): Promise<RugCheckResult> {
  // Step 1 - resolve the creator and the current holder set from one RugCheck
  // report (0 RPC calls) - already fetched and cached 10 minutes for holder-
  // profile surfaces elsewhere, so this costs nothing extra when it has
  // already been asked for. Shared by both signals below.
  let profile
  try {
    profile = await getHolderProfile('solana', mint)
  } catch (err) {
    log.risk.warn({ err: String(err), mint }, 'rug check: holder profile failed')
    return unresolved('error')
  }

  const creator = profile.creatorAddress
  if (!creator) return unresolved('no-creator')

  const holders: OwnedHolder[] = (profile.ownedWallets ?? []).slice(0, MAX_HOLDERS)
  if (holders.length < MIN_HOLDERS) {
    return unresolved('insufficient-holder-data', { creatorWallet: creator, totalHolders: holders.length })
  }

  // Distribution costs no RPC calls, so it always runs alongside the funding
  // graph rather than only as a fallback once that one comes back unknown.
  const distribution = computeDistributionSignal(holders)
  const funding = await computeFundingSignal(mint, creator, holders)

  return combineSignals(creator, holders.length, funding, distribution)
}
