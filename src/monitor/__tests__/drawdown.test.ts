import { describe, expect, it } from 'vitest'
import {
  detectDrawdown,
  detectRecovery,
  windowHigh,
  type ArmedDip,
  type DipConfig,
} from '../detect/drawdown.js'
import { MINUTE, NOW, readings, snapshot } from './fixtures.js'

const config: DipConfig = {
  drawdownPct: 50,
  highWindowMinutes: 180,
  recoveryPct: 10,
  minCoverageMinutes: 45,
  highPriorityDrawdownPct: 70,
}

/** A run to 4 and back down, recorded every 5 minutes across three hours. */
function ranAndFell(current: number) {
  return {
    snapshot: snapshot({ priceUsd: current }),
    // 36 readings, 5 minutes apart: oldest 180m back, newest 5m back.
    history: readings(36, { stepMinutes: 5, priceUsd: (i) => (i === 12 ? 4 : 1) }),
  }
}

describe('windowHigh', () => {
  it('takes the peak from recorded readings, not from the current price', () => {
    const { snapshot: s, history } = ranAndFell(1.5)
    const high = windowHigh(s, history, 180 * MINUTE)

    expect(high?.priceUsd).toBe(4)
    expect(high?.samples).toBe(37)
  })

  it('ignores readings older than the window', () => {
    const s = snapshot({ priceUsd: 1 })
    // The 4 sits 200 minutes back, outside a 180-minute window.
    const history = readings(40, { stepMinutes: 5, priceUsd: (i) => (i === 0 ? 4 : 1) })

    expect(windowHigh(s, history, 180 * MINUTE)?.priceUsd).toBe(1)
  })

  it('counts the current price, so a token at a new high is not in drawdown', () => {
    const s = snapshot({ priceUsd: 9 })
    const high = windowHigh(s, readings(10, { stepMinutes: 5, priceUsd: 1 }), 180 * MINUTE)

    expect(high?.priceUsd).toBe(9)
    expect(high?.at).toBe(NOW)
  })

  it('reports how much of the window the readings actually cover', () => {
    const s = snapshot({ priceUsd: 1 })
    // Six readings 5 minutes apart is half an hour of history, not three.
    const high = windowHigh(s, readings(6, { stepMinutes: 5, priceUsd: 1 }), 180 * MINUTE)

    expect(high?.coveredMs).toBe(30 * MINUTE)
  })
})

describe('detectDrawdown', () => {
  it('fires once the fall from the recorded high passes the threshold', () => {
    const { snapshot: s, history } = ranAndFell(1.5)
    const trigger = detectDrawdown(s, history, config)

    // 4 -> 1.5 is 62.5% off the high.
    expect(trigger?.kind).toBe('drawdown')
    expect(trigger?.value).toBeCloseTo(62.5, 5)
    expect(trigger?.headline).toContain('62.5%')
  })

  it('stays quiet on a fall that has not reached the threshold', () => {
    const { snapshot: s, history } = ranAndFell(2.4)

    // 40% down. Real, but a normal breath on a runner.
    expect(detectDrawdown(s, history, config)).toBeUndefined()
  })

  it('refuses to describe a window it has not been watching', () => {
    const s = snapshot({ priceUsd: 1 })
    // Twenty minutes of history, and a genuine 75% fall inside it - but the
    // configured window is three hours and the coverage floor is 45 minutes.
    const history = readings(4, { stepMinutes: 5, priceUsd: (i) => (i === 0 ? 4 : 1) })

    expect(detectDrawdown(s, history, config)).toBeUndefined()
  })

  it('names the span it measured rather than the one configured', () => {
    const s = snapshot({ priceUsd: 1 })
    // 60 minutes of history under a 180-minute setting.
    const history = readings(12, { stepMinutes: 5, priceUsd: (i) => (i === 0 ? 4 : 1) })
    const trigger = detectDrawdown(s, history, config)

    expect(trigger?.headline).toContain('60m high')
    expect(trigger?.headline).not.toContain('180m')
  })

  it('marks the deepest flushes high priority', () => {
    const { snapshot: s, history } = ranAndFell(1.5)
    const shallow = detectDrawdown(s, history, config)
    const deep = detectDrawdown(snapshot({ priceUsd: 0.8 }), history, config)

    expect(shallow?.priority).toBe('normal')
    expect(deep?.priority).toBe('high')
  })

  it('has nothing to say about a token with no price', () => {
    const { history } = ranAndFell(1)

    expect(detectDrawdown(snapshot({ priceUsd: undefined }), history, config)).toBeUndefined()
  })
})

describe('detectRecovery', () => {
  const armed: ArmedDip = { alertPriceUsd: 1.5, lowPriceUsd: 1.2, armedAt: NOW - 40 * MINUTE }

  it('waits for the target, measured from the alert price', () => {
    // +9.3% from the alert price: back above the low, short of the 10% target.
    expect(detectRecovery(snapshot({ priceUsd: 1.64 }), armed, config)).toBeUndefined()

    const trigger = detectRecovery(snapshot({ priceUsd: 1.7 }), armed, config)
    expect(trigger?.kind).toBe('recovery')
    expect(trigger?.value).toBeCloseTo(13.33, 2)
  })

  it('reports the bottom it saw without measuring the target from it', () => {
    const trigger = detectRecovery(snapshot({ priceUsd: 1.8 }), armed, config)

    // 1.2 -> 1.8 is +50% off the low, but the headline is the 20% that anyone
    // acting on the dip alert would actually have made.
    expect(trigger?.headline).toContain('20.0%')
    expect(trigger?.detail.join(' ')).toContain('Post-alert low')
    expect(trigger?.detail.join(' ')).toContain('50.0%')
  })

  it('fires at the alert price when no recovery margin is asked for', () => {
    const flat: DipConfig = { ...config, recoveryPct: 0 }

    expect(detectRecovery(snapshot({ priceUsd: 1.5 }), armed, flat)?.kind).toBe('recovery')
    expect(detectRecovery(snapshot({ priceUsd: 1.49 }), armed, flat)).toBeUndefined()
  })
})
