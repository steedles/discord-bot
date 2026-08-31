import type { readSettings } from '../features/types.js'
import type { Priority } from '../monitor/detect/types.js'

/**
 * Who an alert should ping, from the settings of the channel it is going to.
 *
 * Shared by every surface that posts unprompted - the volume monitor, the
 * launch scanner, price alerts and Call Tracker - so that "roles to ping" means
 * the same thing wherever it is set, and a new alerting feature gets the
 * behaviour by declaring the field rather than by copying this logic.
 */

export interface Ping {
  content: string
  /**
   * Mentions are listed explicitly rather than left to Discord's parser, so the
   * message can only ever ping exactly who the settings name - never an
   * `@everyone` that found its way into the content by another route.
   */
  allowed: { users: string[]; roles: string[] }
}

/** Discord snowflakes are 17-20 digits. Anything else in the field is not an id. */
const SNOWFLAKE = /\d{17,20}/g

/** Ping targets pasted as raw ids, `<@id>` mentions, or a mix, in any separator. */
export function parseUserIds(raw: string, limit = 10): string[] {
  return [...new Set(raw.match(SNOWFLAKE) ?? [])].slice(0, limit)
}

type Read = ReturnType<typeof readSettings>

interface PingOptions {
  /**
   * The alert's priority, for features that have one. Absent means the feature
   * does not grade its alerts, so `pingOn` is not consulted - a launch is a
   * launch, and there is no "low priority" one to hold the ping back for.
   */
  priority?: Priority
  /** Pinged as well as the configured roles, e.g. the person a call belongs to. */
  extraUserIds?: string[]
}

/**
 * Builds the mention line, or nothing at all when there is nobody to ping.
 *
 * Roles come from the `mentionRoles` picker. `mentionRoleId` is still read
 * where the picker is empty: it is what channels configured before the picker
 * existed still hold, and silently dropping their ping would be a feature
 * turning itself off during an upgrade.
 */
export function pingFor(read: Read, options: PingOptions = {}): Ping | undefined {
  const mode = read.str('pingOn', 'high')
  if (mode === 'never') return undefined
  if (options.priority !== undefined && mode !== 'every' && options.priority !== 'high') {
    return undefined
  }

  const picked = read.list('mentionRoles')
  const legacy = parseUserIds(read.str('mentionRoleId'), 1)
  const roleIds = picked.length > 0 ? picked : legacy

  const userIds = [
    ...new Set([...(options.extraUserIds ?? []), ...parseUserIds(read.str('mentionUserIds'))]),
  ]

  const parts = [...roleIds.map((id) => `<@&${id}>`), ...userIds.map((id) => `<@${id}>`)]
  if (parts.length === 0) return undefined

  return { content: parts.join(' '), allowed: { users: userIds, roles: roleIds } }
}
