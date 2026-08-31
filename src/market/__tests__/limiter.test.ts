import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RateLimiter } from '../limiter.js'

/**
 * The limiter is the whole defence against a rate limit, so these tests are
 * about the two things that actually went wrong in production: a bucket that
 * kept spending at a rate the endpoint was refusing, and a queue that could be
 * jumped. Everything here runs on fake timers - a real one would make the suite
 * take minutes to say very little.
 */
describe('RateLimiter', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('lets a burst through and then paces the rest', async () => {
    const limiter = new RateLimiter('test', 60, 3)

    // The burst is free.
    await limiter.acquire()
    await limiter.acquire()
    await limiter.acquire()
    expect(limiter.stats().available).toBe(0)

    // The fourth has to wait for a refill - 60/minute is one per second.
    let granted = false
    const pending = limiter.acquire().then(() => (granted = true))

    await vi.advanceTimersByTimeAsync(500)
    expect(granted).toBe(false)

    await vi.advanceTimersByTimeAsync(600)
    await pending
    expect(granted).toBe(true)
  })

  it('serves waiters in order rather than letting a new caller jump the queue', async () => {
    const limiter = new RateLimiter('test', 60, 1)
    await limiter.acquire()

    const order: string[] = []
    const first = limiter.acquire().then(() => order.push('first'))
    const second = limiter.acquire().then(() => order.push('second'))

    await vi.advanceTimersByTimeAsync(2_500)
    await Promise.all([first, second])

    expect(order).toEqual(['first', 'second'])
  })

  describe('penalise', () => {
    it('cuts the sustained rate when the endpoint refuses', () => {
      const limiter = new RateLimiter('test', 120, 5)
      expect(limiter.stats().perMinute).toBe(120)

      limiter.penalise()
      expect(limiter.stats().perMinute).toBe(90)

      limiter.penalise()
      expect(limiter.stats().perMinute).toBe(68)

      expect(limiter.stats().rejections).toBe(2)
      expect(limiter.stats().ceiling).toBe(120)
    })

    it('never backs off to a standstill', () => {
      const limiter = new RateLimiter('test', 120, 5)
      for (let i = 0; i < 50; i++) limiter.penalise()

      // An endpoint refusing everything is an outage, not a rate to discover.
      expect(limiter.stats().perMinute).toBe(15)
    })

    it('slows the pacing, not just the bookkeeping', async () => {
      const limiter = new RateLimiter('test', 60, 1)
      await limiter.acquire()

      // Halve the rate: 60/min becomes ~34/min, so a token takes ~1.8s not 1s.
      limiter.penalise()
      limiter.penalise()

      let granted = false
      const pending = limiter.acquire().then(() => (granted = true))

      await vi.advanceTimersByTimeAsync(1_200)
      expect(granted).toBe(false)

      await vi.advanceTimersByTimeAsync(1_500)
      await pending
      expect(granted).toBe(true)
    })

    it('creeps back toward the ceiling once the endpoint goes quiet', () => {
      const limiter = new RateLimiter('test', 120, 5)
      limiter.penalise()
      expect(limiter.stats().perMinute).toBe(90)

      // Still inside the quiet period - a refusal 20 seconds ago is not history.
      vi.advanceTimersByTime(20_000)
      expect(limiter.stats().perMinute).toBe(90)

      // Past it, the rate climbs additively: 5% of the ceiling per minute.
      vi.advanceTimersByTime(60_000)
      expect(limiter.stats().perMinute).toBe(96)

      vi.advanceTimersByTime(10 * 60_000)
      expect(limiter.stats().perMinute).toBe(120)
    })

    it('does not climb past the configured ceiling', () => {
      const limiter = new RateLimiter('test', 120, 5)
      vi.advanceTimersByTime(60 * 60_000)
      expect(limiter.stats().perMinute).toBe(120)
    })
  })
})
