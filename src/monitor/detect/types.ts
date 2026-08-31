/**
 * Detector vocabulary.
 *
 * Everything in `detect/` is a pure function over these types. No database, no
 * network, no Discord. That is what makes the part of this feature that decides
 * whether to shout at a channel testable against fixtures, which is the only way
 * to know a threshold change did what it was meant to.
 */

export type AlertKind =
  | 'spike'
  | 'whale'
  | 'momentum'
  | 'drawdown'
  | 'recovery'
  | 'call'
  | 'level'
  | 'churn'
  | 'vamp'

/** High-priority alerts are the only ones allowed to ping a role. */
export type Priority = 'normal' | 'high'

/**
 * One prior reading of a pool, reduced to what detectors need.
 *
 * Deliberately not the database's `VolumeSnapshot`: detectors take plain numbers
 * so a test can write a history by hand instead of building Mongo documents.
 */
export interface Reading {
  /** Epoch ms. */
  at: number
  priceUsd?: number
  /**
   * Depth and size at the time of the reading.
   *
   * Carried so an alert can say what a number *was* as well as what it is. Rows
   * written before this existed have neither, which is why every consumer treats
   * a missing figure as "not measured" rather than as zero.
   */
  liquidityUsd?: number
  marketCapUsd?: number
  volM5?: number
  volH1?: number
  volH6?: number
  volH24?: number
}

export interface Trigger {
  kind: AlertKind
  /**
   * Exactly what fired, in the words the alert will use: "5m volume 8.2x its
   * baseline". It names a measurement, never a conclusion about the token.
   */
  headline: string
  /** The measured quantity that was compared. */
  value: number
  /** What it had to beat. */
  threshold: number
  priority: Priority
  /**
   * Ranking within a channel, used when the hourly cap forces a choice.
   * Expressed as "how many times over the threshold", so the units of different
   * detectors stay comparable.
   */
  score: number
  /** Extra measured lines for the embed. Facts only. */
  detail: string[]
}

/** Ranks by priority first, then by how far past the threshold it went. */
export function compareTriggers(a: Trigger, b: Trigger): number {
  if (a.priority !== b.priority) return a.priority === 'high' ? -1 : 1
  return b.score - a.score
}
