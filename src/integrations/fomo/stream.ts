import type { FomoAlert, FomoAlertTrade } from '../../db/models.js'
import { log } from '../../logger.js'

/**
 * The live fan-out behind the dashboard's Fomo page.
 *
 * In-process and deliberately not durable: an SSE subscriber is a browser tab
 * that is either attached now or is not, and a tab that reconnects backfills
 * over `/api/fomo/alerts` rather than replaying a buffer. Anything that must
 * survive a restart is in Mongo already - this only carries the "and it just
 * happened" half.
 *
 * One process publishes (the ingest route, via the worker) and every subscriber
 * is a response stream on the same listener, so there is no broker here and no
 * need for one. If the bot is ever run as more than one replica this becomes a
 * lie, and the fix is Mongo change streams, not a bigger Set.
 */

export type FomoStreamEvent =
  | { type: 'alert'; alert: FomoAlert }
  | { type: 'trade'; trade: FomoAlertTrade }
  /**
   * An Axiom link that arrived after its alert did.
   *
   * The pool behind it takes a DexScreener lookup, which must not sit in front
   * of the Discord post - the whole value of this path is that it is fast. So
   * the alert is delivered first and its link follows a moment later, and an
   * open page upgrades the row in place rather than waiting or reloading.
   */
  | { type: 'links'; eventId: string; axiomUrl: string }

type Listener = (event: FomoStreamEvent) => void

/**
 * A cap, because every subscriber is an open HTTP response holding a socket.
 *
 * Without one, a page that reconnects in a loop - which is exactly what a
 * broken deploy looks like - accumulates responses until the process runs out
 * of handles. Refusing the 51st connection is a visible failure; leaking is not.
 */
const MAX_SUBSCRIBERS = 50

class FomoStream {
  private readonly listeners = new Set<Listener>()

  /** Returns an unsubscribe function, or undefined when the cap is reached. */
  subscribe(fn: Listener): (() => void) | undefined {
    if (this.listeners.size >= MAX_SUBSCRIBERS) {
      log.fomo.warn({ cap: MAX_SUBSCRIBERS }, 'refused a fomo stream subscriber - at cap')
      return undefined
    }
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  get subscriberCount(): number {
    return this.listeners.size
  }

  /**
   * Hand an event to every subscriber.
   *
   * A throwing listener is logged and skipped rather than allowed to abort the
   * loop: one wedged response must not stop the other tabs from updating, and
   * this runs on the ingest path where an exception would be a dropped alert.
   */
  publish(event: FomoStreamEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event)
      } catch (err) {
        log.fomo.warn({ err }, 'fomo stream listener threw')
      }
    }
  }
}

export const fomoStream = new FomoStream()
