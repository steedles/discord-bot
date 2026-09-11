import { describe, expect, it, vi } from 'vitest'
import type { FomoAlert } from '../../../db/models.js'
import { fomoStream, type FomoStreamEvent } from '../stream.js'

/**
 * The fan-out only. Everything else in the Fomo alert path needs Mongo, and
 * this suite is deliberately network- and database-free.
 */

const alert = (eventId: string): FomoAlert => ({
  eventId,
  kind: 'BUY',
  traderVerified: false,
  createdAt: new Date(),
  receivedAt: new Date(),
})

/** Leave the module singleton as clean as we found it. */
function withSubscribers<T>(run: (unsubscribes: (() => void)[]) => T): T {
  const unsubscribes: (() => void)[] = []
  try {
    return run(unsubscribes)
  } finally {
    for (const off of unsubscribes) off()
  }
}

describe('fomoStream', () => {
  it('delivers an event to every subscriber', () => {
    withSubscribers((offs) => {
      const a = vi.fn()
      const b = vi.fn()
      offs.push(fomoStream.subscribe(a)!, fomoStream.subscribe(b)!)

      const event: FomoStreamEvent = { type: 'alert', alert: alert('e1') }
      fomoStream.publish(event)

      expect(a).toHaveBeenCalledWith(event)
      expect(b).toHaveBeenCalledWith(event)
    })
  })

  it('stops delivering once unsubscribed', () => {
    const seen = vi.fn()
    const off = fomoStream.subscribe(seen)
    expect(off).toBeDefined()
    off?.()

    fomoStream.publish({ type: 'alert', alert: alert('e2') })
    expect(seen).not.toHaveBeenCalled()
  })

  it('keeps going when one subscriber throws', () => {
    // The whole point: this runs on the ingest path, so one wedged response
    // must not cost the other tabs their update - or the alert its delivery.
    withSubscribers((offs) => {
      const bad = vi.fn(() => {
        throw new Error('this listener is broken')
      })
      const good = vi.fn()
      offs.push(fomoStream.subscribe(bad)!, fomoStream.subscribe(good)!)

      expect(() => fomoStream.publish({ type: 'alert', alert: alert('e3') })).not.toThrow()
      expect(good).toHaveBeenCalledOnce()
    })
  })

  it('refuses subscribers past the cap rather than leaking them', () => {
    withSubscribers((offs) => {
      // Fill it. Each subscriber is an open HTTP response in production, which
      // is why the cap exists at all.
      for (let i = 0; i < 50; i++) {
        const off = fomoStream.subscribe(() => {})
        expect(off).toBeDefined()
        offs.push(off!)
      }
      expect(fomoStream.subscriberCount).toBe(50)
      // The 51st is refused, and refused visibly - undefined, not a no-op
      // unsubscribe that would look like it had worked.
      expect(fomoStream.subscribe(() => {})).toBeUndefined()
    })

    expect(fomoStream.subscriberCount).toBe(0)
  })
})
