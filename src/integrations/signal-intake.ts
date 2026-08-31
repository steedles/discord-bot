import { config } from '../config.js'
import type { RugCheck } from '../db/models.js'
import { log } from '../logger.js'
import type { DexPair } from '../market/dexscreener.js'
import type { RiskLevel, RiskReport } from '../risk/types.js'

/**
 * Outbound hand-off to fresh-start's signal intake, which queues a buy from it.
 *
 * This is a personal side-channel, not a product feature: it is **off unless
 * configured** - no URL or no token means nothing is ever sent, which is what
 * keeps it out of a deployment that only sets the Discord and Mongo variables.
 *
 * Three properties matter more than delivery:
 *
 * - **It can never cost or delay an alert.** It is fired in parallel with the
 *   Discord post and never awaited; every failure is caught and logged.
 * - **It is time-critical.** The receiver refuses a signal older than 120
 *   seconds by the time its worker picks it up, so this is sent the moment the
 *   figures exist rather than after the posting loop. Nothing here may queue or
 *   batch.
 * - **A 202 means "recorded", not "bought".** The receiver independently
 *   declines thin pools, mints it already holds and anything stale, so a signal
 *   that never becomes a trade is not a fault on this side.
 */

/** The intake's 202 body. `accepted` means queued, never that a buy happened. */
interface IntakeAccepted {
  accepted?: boolean
  intakeId?: number
  correlationId?: string
  address?: string
  receivedAt?: string
}

const TIMEOUT_MS = 5_000
/**
 * Attempts after the first, for 5xx and connection errors only.
 *
 * 400, 401 and 429 are never retried: a bad body and a bad token fail
 * identically the second time, and a 429 means the pace was already wrong, so
 * asking again spends another of the 60 requests a minute to learn the same
 * thing - the same rule `fetchJson` runs on.
 */
const RETRIES = 2
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Tokens already sent, so one launch is one signal.
 *
 * The scanner's own dedupe is per *channel* - two channels with different
 * filters both get a shot at the same token - which is right for Discord and
 * wrong for a buy queue.
 */
const sent = new Set<string>()
const SENT_MAX = 5_000

export function signalIntakeEnabled(): boolean {
  return Boolean(config.SIGNAL_INTAKE_URL && config.SIGNAL_INTAKE_TOKEN)
}

/**
 * Posts one launch to the intake. Resolves either way - callers do not check,
 * and must not await it.
 */
export async function sendLaunchSignal(
  pair: DexPair,
  report: RiskReport,
  rugCheck: RugCheck | null,
): Promise<void> {
  const url = config.SIGNAL_INTAKE_URL
  const token = config.SIGNAL_INTAKE_TOKEN
  if (!url || !token) return

  const chain = pair.chainId.toLowerCase()
  const address = pair.baseToken.address

  // The intake accepts any chain and then declines it downstream with a reason,
  // which still spends one of the 60 requests a minute. Filtering here keeps
  // the budget for the chain its trader can actually act on.
  const chains = config.SIGNAL_INTAKE_CHAINS
  if (chains.length > 0 && !chains.includes(chain)) return

  const key = `${chain}:${address.toLowerCase()}`
  if (sent.has(key)) return
  remember(key)

  const body = JSON.stringify(signalBody(pair, report, chain, address, rugCheck))

  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await sleep(400 * 2 ** (attempt - 1))

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        /*
         * A redirect is a refusal, not a destination.
         *
         * The intake sits behind a dashboard whose middleware sends anything
         * unauthenticated to /login as a 307 - and a 307 preserves the method
         * and body, so `fetch`'s default would happily POST a buy signal into
         * an HTML login page and read the 200 back as acceptance. Following it
         * turns a misconfiguration into a silent success, which is the one
         * outcome worse than a failure.
         */
        redirect: 'manual',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body,
      })

      if (res.ok) {
        const json = (await res.json().catch(() => ({}))) as IntakeAccepted
        // The correlationId is logged beside the token it belongs to, so a
        // trade in fresh-start can be joined back to the alert that caused it.
        log.signals.info(
          {
            chain,
            symbol: pair.baseToken.symbol,
            address,
            intakeId: json.intakeId,
            correlationId: json.correlationId,
          },
          'launch recorded by signal intake',
        )
        return
      }

      const detail = await res.text().catch(() => '')

      if (res.status >= 300 && res.status < 400) {
        log.signals.warn(
          { status: res.status, location: res.headers.get('location'), url },
          'signal intake redirected - the endpoint is not the intake (stale deploy, or wrong path)',
        )
        return
      }

      if (res.status < 500) {
        // Deterministic refusal. A 429 keeps the dedupe entry too - the answer
        // to being over the cap is to send less, not to send it again.
        log.signals.warn({ status: res.status, chain, address, detail }, 'signal intake refused launch')
        return
      }

      if (attempt === RETRIES) {
        sent.delete(key)
        log.signals.warn({ status: res.status, chain, address, detail }, 'signal intake unavailable')
      }
    } catch (err) {
      if (attempt === RETRIES) {
        // A transient failure gives the token another chance if it ever alerts
        // again; by then the 120-second window has closed on this one.
        sent.delete(key)
        log.signals.warn({ err: String(err), chain, address }, 'signal intake unreachable')
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Only `address` is required, but everything measurable is sent: the two price
 * figures let the receiver measure alert-against-fill drift, and the risk pair
 * is what fills the risk line in its own alerts.
 *
 * Nothing is invented to fill a field. A figure the pair did not carry is left
 * out rather than sent as a zero - the same rule the alerts themselves run on.
 *
 * `rugCheck` is sent with its actual verdict - `flag`, `clean` or `unknown` -
 * not collapsed to a boolean the way the Discord embed and Live Charts show
 * it. Those two are human-facing and only ever display a positive flag (see
 * launch-scanner.ts); the intake is a decision-maker on the other end, and
 * needs to be able to tell three states apart: no row at all means never
 * checked, `unknown` means checked but the check could not be completed, and
 * `flag`/`clean` mean it ran to completion. Collapsing "never checked" and
 * "checked, inconclusive" into the same silence was the original gap here -
 * an automated trader cannot decide how cautious to be from an absence that
 * could mean either.
 */
function signalBody(
  pair: DexPair,
  report: RiskReport,
  chain: string,
  address: string,
  rugCheck: RugCheck | null,
): Record<string, unknown> {
  const price = pair.priceUsd === undefined ? undefined : Number(pair.priceUsd)
  const mcap = pair.marketCap ?? pair.fdv

  return {
    address,
    chain,
    source: config.SIGNAL_INTAKE_SOURCE,
    ...(usable(price) ? { priceAtSignal: price } : {}),
    ...(usable(mcap) ? { mcapAtSignal: Math.round(mcap) } : {}),
    ...(report.level === 'unknown'
      ? {}
      : { risk: intakeRisk(report.level), riskScore: Math.round(report.score) }),
    ...(rugCheck ? rugCheckFields(rugCheck) : {}),
  }
}

/**
 * Two independent checks (risk/rugSignature.ts) feed one `rugCheck` row, so
 * each sub-check's detail fields are only sent once *that* sub-check ran to
 * completion - a `distributionVerdict: 'unknown'` must not send `rugCheckCv`
 * as if it were a measured 0, the same failure as reading a missing liquidity
 * figure as zero. `rugCheckVerdict` is always the combined verdict; the
 * receiver gets both sub-verdicts too so it can tell which test actually
 * flagged.
 */
function rugCheckFields(rugCheck: RugCheck): Record<string, unknown> {
  if (rugCheck.verdict === 'unknown') {
    return { rugCheckVerdict: 'unknown', rugCheckReason: rugCheck.reason }
  }

  return {
    rugCheckVerdict: rugCheck.verdict,
    rugCheckFundingVerdict: rugCheck.fundingVerdict,
    rugCheckDistributionVerdict: rugCheck.distributionVerdict,
    ...(rugCheck.fundingVerdict !== 'unknown'
      ? {
          rugCheckCohort: rugCheck.tightCohortSize,
          ...(rugCheck.cohortSharePct !== undefined ? { rugCheckCohortSharePct: rugCheck.cohortSharePct } : {}),
          ...(rugCheck.funderWallet ? { rugCheckFunder: rugCheck.funderWallet } : {}),
          rugCheckTailMatch: rugCheck.tailMatch,
        }
      : {}),
    ...(rugCheck.distributionVerdict !== 'unknown' && rugCheck.distributionCv !== null
      ? { rugCheckDistributionCv: rugCheck.distributionCv, rugCheckDistributionCohort: rugCheck.distributionCohort }
      : {}),
  }
}

const usable = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0

/**
 * The receiver's risk line reads `low | medium | high`, and this codebase has a
 * fourth level above those. `critical` is sent as `high` rather than as a word
 * the receiver has no branch for - it is the nearest true statement, and the
 * exact score travels beside it in `riskScore` regardless.
 */
function intakeRisk(level: Exclude<RiskLevel, 'unknown'>): 'low' | 'medium' | 'high' {
  return level === 'critical' ? 'high' : level
}

function remember(key: string): void {
  if (sent.size >= SENT_MAX) {
    const oldest = sent.values().next().value
    if (oldest !== undefined) sent.delete(oldest)
  }
  sent.add(key)
}
