import { describe, expect, it } from 'vitest'
import { selectAlerts, tokenKey, type Candidate, type RateConfig } from '../detect/dedupe.js'
import type { Priority, Trigger } from '../detect/types.js'
import { MINUTE, NOW } from './fixtures.js'

const config: RateConfig = { cooldownMinutes: 120, maxAlertsPerHour: 12 }

function candidate(key: string, score: number, priority: Priority = 'normal'): Candidate {
  const trigger: Trigger = {
    kind: 'spike',
    headline: `${key} at ${score}x`,
    value: score,
    threshold: 1,
    priority,
    score,
    detail: [],
  }
  return { tokenKey: key, trigger }
}

describe('selectAlerts', () => {
  it('posts a token nobody has heard about yet', () => {
    const { posting, dropped } = selectAlerts([candidate('solana:a', 3)], [], config, NOW)

    expect(posting).toHaveLength(1)
    expect(dropped).toHaveLength(0)
  })

  it('holds a token that alerted inside the cooldown', () => {
    const recent = [{ tokenKey: 'solana:a', postedAt: NOW - 30 * MINUTE }]
    const { posting, dropped } = selectAlerts([candidate('solana:a', 3)], recent, config, NOW)

    expect(posting).toHaveLength(0)
    expect(dropped[0]!.reason).toContain('cooling down')
  })

  it('lets a token back in once the cooldown expires', () => {
    const recent = [{ tokenKey: 'solana:a', postedAt: NOW - 121 * MINUTE }]
    const { posting } = selectAlerts([candidate('solana:a', 3)], recent, config, NOW)

    expect(posting).toHaveLength(1)
  })

  it('measures the cooldown from the most recent post, not the oldest', () => {
    const recent = [
      { tokenKey: 'solana:a', postedAt: NOW - 300 * MINUTE },
      { tokenKey: 'solana:a', postedAt: NOW - 10 * MINUTE },
    ]
    const { posting } = selectAlerts([candidate('solana:a', 3)], recent, config, NOW)

    expect(posting).toHaveLength(0)
  })

  it('cools tokens down independently of each other', () => {
    const recent = [{ tokenKey: 'solana:a', postedAt: NOW - 10 * MINUTE }]
    const { posting } = selectAlerts(
      [candidate('solana:a', 3), candidate('solana:b', 3)],
      recent,
      config,
      NOW,
    )

    expect(posting.map((p) => p.tokenKey)).toEqual(['solana:b'])
  })

  it('posts one token once even if two triggers arrive in the same cycle', () => {
    const { posting, dropped } = selectAlerts(
      [candidate('solana:a', 3), candidate('solana:a', 9)],
      [],
      config,
      NOW,
    )

    expect(posting).toHaveLength(1)
    // The stronger of the two is the one kept.
    expect(posting[0]!.trigger.score).toBe(9)
    expect(dropped[0]!.reason).toBe('already selected this cycle')
  })

  it('drops the weakest first when the hourly cap bites', () => {
    const tight: RateConfig = { cooldownMinutes: 120, maxAlertsPerHour: 2 }
    const { posting, dropped } = selectAlerts(
      [candidate('solana:a', 3), candidate('solana:b', 40), candidate('solana:c', 12)],
      [],
      tight,
      NOW,
    )

    expect(posting.map((p) => p.tokenKey)).toEqual(['solana:b', 'solana:c'])
    expect(dropped).toHaveLength(1)
    expect(dropped[0]!.candidate.tokenKey).toBe('solana:a')
    expect(dropped[0]!.reason).toContain('hourly cap')
  })

  it('lets a high-priority alert outrank a bigger normal one', () => {
    const tight: RateConfig = { cooldownMinutes: 120, maxAlertsPerHour: 1 }
    const { posting } = selectAlerts(
      [candidate('solana:big', 50), candidate('solana:urgent', 6, 'high')],
      [],
      tight,
      NOW,
    )

    expect(posting.map((p) => p.tokenKey)).toEqual(['solana:urgent'])
  })

  it('counts what the channel already heard this hour against the cap', () => {
    const tight: RateConfig = { cooldownMinutes: 120, maxAlertsPerHour: 3 }
    const recent = [
      { tokenKey: 'solana:x', postedAt: NOW - 5 * MINUTE },
      { tokenKey: 'solana:y', postedAt: NOW - 20 * MINUTE },
    ]
    const { posting, dropped } = selectAlerts(
      [candidate('solana:a', 3), candidate('solana:b', 4)],
      recent,
      tight,
      NOW,
    )

    expect(posting).toHaveLength(1)
    expect(dropped).toHaveLength(1)
  })

  it('does not count alerts that have aged out of the hour', () => {
    const tight: RateConfig = { cooldownMinutes: 5, maxAlertsPerHour: 1 }
    const recent = [{ tokenKey: 'solana:x', postedAt: NOW - 61 * MINUTE }]
    const { posting } = selectAlerts([candidate('solana:a', 3)], recent, tight, NOW)

    expect(posting).toHaveLength(1)
  })

  it('accounts for every alert it suppressed, so a silent channel is explainable', () => {
    // One alert a minute ago, against a cap of one an hour: the budget is spent
    // and `a` is also still cooling down. Nothing posts, and all three say why.
    const tight: RateConfig = { cooldownMinutes: 120, maxAlertsPerHour: 1 }
    const recent = [{ tokenKey: 'solana:a', postedAt: NOW - MINUTE }]
    const { posting, dropped } = selectAlerts(
      [candidate('solana:a', 3), candidate('solana:b', 4), candidate('solana:c', 5)],
      recent,
      tight,
      NOW,
    )

    expect(posting).toHaveLength(0)
    expect(dropped).toHaveLength(3)
    expect(dropped.filter((d) => d.reason.includes('cooling down'))).toHaveLength(1)
    expect(dropped.filter((d) => d.reason.includes('hourly cap'))).toHaveLength(2)
  })
})

describe('tokenKey', () => {
  it('is case insensitive, because EVM addresses are written both ways', () => {
    expect(tokenKey('ethereum', '0xAbC')).toBe(tokenKey('ethereum', '0xabc'))
  })
})
