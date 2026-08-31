import { compareTriggers, type Trigger } from './types.js'

export interface RateConfig {
  /** How long one token stays quiet after alerting, per alert type. */
  cooldownMinutes: number
  /** Ceiling on how much one channel hears in a rolling hour. */
  maxAlertsPerHour: number
}

/** An alert already posted to this channel for this feature. */
export interface PostedAlert {
  /** `chainId:tokenAddress`, lowercased. */
  tokenKey: string
  /** Epoch ms. */
  postedAt: number
}

export interface Candidate {
  tokenKey: string
  trigger: Trigger
}

export interface Selection<T extends Candidate> {
  posting: T[]
  dropped: { candidate: T; reason: string }[]
}

const HOUR_MS = 60 * 60_000

/**
 * Decides what a channel actually hears this cycle.
 *
 * Two separate jobs, in this order:
 *
 * 1. **Cooldown.** A token that already alerted stays quiet for a while. Without
 *    it a token whose volume sits at 6x its baseline for twenty minutes posts
 *    on every single poll, which is the failure mode that gets a monitor muted
 *    rather than tuned.
 *
 * 2. **Hourly cap.** Even across different tokens there is a limit to how much
 *    a channel can absorb. When more qualify than fit, the ones that go are the
 *    *weakest* - high priority first, then furthest past its threshold. Dropping
 *    by arrival order instead would mean a quiet hour of 3x prints could use up
 *    the budget and silence the 40x that landed a minute later.
 *
 * Dropped candidates are returned rather than discarded so the caller can log
 * what was suppressed. A cap that silently eats alerts is indistinguishable from
 * a monitor that is not working.
 */
export function selectAlerts<T extends Candidate>(
  candidates: T[],
  recent: PostedAlert[],
  config: RateConfig,
  now = Date.now(),
): Selection<T> {
  const dropped: Selection<T>['dropped'] = []

  const cooldownMs = Math.max(0, config.cooldownMinutes) * 60_000
  const lastPostedByToken = new Map<string, number>()
  for (const alert of recent) {
    const previous = lastPostedByToken.get(alert.tokenKey)
    if (previous === undefined || alert.postedAt > previous) {
      lastPostedByToken.set(alert.tokenKey, alert.postedAt)
    }
  }

  const eligible: T[] = []
  // Two candidates for the same token in one cycle are the same news twice.
  const seenThisCycle = new Set<string>()

  for (const candidate of [...candidates].sort((a, b) => compareTriggers(a.trigger, b.trigger))) {
    const lastPosted = lastPostedByToken.get(candidate.tokenKey)

    if (lastPosted !== undefined && now - lastPosted < cooldownMs) {
      const minutesLeft = Math.ceil((cooldownMs - (now - lastPosted)) / 60_000)
      dropped.push({ candidate, reason: `cooling down for another ${minutesLeft}m` })
      continue
    }

    if (seenThisCycle.has(candidate.tokenKey)) {
      dropped.push({ candidate, reason: 'already selected this cycle' })
      continue
    }

    seenThisCycle.add(candidate.tokenKey)
    eligible.push(candidate)
  }

  const postedThisHour = recent.filter((a) => now - a.postedAt < HOUR_MS).length
  const room = Math.max(0, config.maxAlertsPerHour - postedThisHour)

  // Already sorted strongest-first, so the tail is what loses.
  const posting = eligible.slice(0, room)
  for (const candidate of eligible.slice(room)) {
    dropped.push({
      candidate,
      reason: `channel hourly cap of ${config.maxAlertsPerHour} reached`,
    })
  }

  return { posting, dropped }
}

export function tokenKey(chainId: string, tokenAddress: string): string {
  return `${chainId}:${tokenAddress.toLowerCase()}`
}
