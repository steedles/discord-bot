import type { DashboardAccess } from '../db/models.js'
import { getCollections } from '../db/mongo.js'

/**
 * The one password login that can decide which other logins see which
 * servers, and that cannot be limited itself. A restriction that applied
 * here would be a way to lose the only account that can undo it.
 */
export const DASHBOARD_OWNER_EMAIL = 'wayne@steedman.co.za'

export function isDashboardOwner(session: { local?: boolean; username: string }): boolean {
  return Boolean(session.local && session.username.toLowerCase() === DASHBOARD_OWNER_EMAIL)
}

export interface AccessDecision {
  local?: boolean
  username: string
  guildIds: string[]
}

/**
 * Which servers this session may open.
 *
 * A Discord login is whatever it held Manage Server on at sign-in, still
 * intersected with servers the bot is in. A password login with no saved
 * row, or a row that is not restricted, sees every server the bot is in —
 * that is how these accounts worked before this table existed. A restricted
 * row is an allow-list. The owner login ignores any row, so it cannot be
 * locked out of the page that edits the rows.
 *
 * When `botGuildIds` is omitted the universe is the session's own stored
 * list. Callers that forget the live set can only get smaller, never a
 * server the bot has left.
 */
export function allowedGuildIds(
  session: AccessDecision,
  botGuildIds: Set<string> | undefined,
  grant: Pick<DashboardAccess, 'restricted' | 'guildIds'> | null,
): string[] {
  if (!session.local) {
    return session.guildIds.filter((id) => !botGuildIds || botGuildIds.has(id))
  }

  const universe = botGuildIds ?? new Set(session.guildIds)
  if (isDashboardOwner(session)) return [...universe]
  if (!grant?.restricted) return [...universe]
  return grant.guildIds.filter((id) => universe.has(id))
}

export async function findGrant(email: string): Promise<DashboardAccess | null> {
  return getCollections().dashboardAccess.findOne({ email: email.trim().toLowerCase() })
}

export async function guildIdsForSession(
  session: AccessDecision & { local?: boolean },
  botGuildIds?: Set<string>,
): Promise<string[]> {
  const grant = session.local && !isDashboardOwner(session) ? await findGrant(session.username) : null
  return allowedGuildIds(session, botGuildIds, grant)
}

export async function saveGrant(
  email: string,
  restricted: boolean,
  guildIds: string[],
  updatedBy: string,
): Promise<DashboardAccess> {
  const updatedAt = new Date()
  const row: DashboardAccess = {
    email: email.trim().toLowerCase(),
    restricted,
    guildIds: [...new Set(guildIds)].sort(),
    updatedAt,
    updatedBy,
  }
  await getCollections().dashboardAccess.updateOne({ email: row.email }, { $set: row }, { upsert: true })
  return row
}
