import { getCollections } from '../../db/mongo.js'
import type { FomoServerRoute } from '../../db/models.js'

/**
 * A Fomo handle as we store and compare it.
 *
 * Lowercase, no leading @. Letters, digits, underscore, dot and hyphen —
 * the characters Fomo handles actually use. Anything else is a typo, and
 * storing it would create a checkbox that can never match an incoming event.
 */
const HANDLE = /^[a-z0-9][a-z0-9_.-]{0,79}$/

export function normaliseHandle(raw: string): string | null {
  const handle = raw.trim().replace(/^@+/, '').toLowerCase()
  if (!HANDLE.test(handle)) return null
  return handle
}

export interface PreparedRoute {
  restricted: boolean
  handles: string[]
}

/**
 * Turn a dashboard save into the row we store.
 *
 * Invalid handles fail the whole save. Silently dropping one would let an
 * admin believe a server was subscribed to an account it will never hear.
 */
export function prepareRoute(
  restricted: boolean,
  rawHandles: string[],
): { ok: true; route: PreparedRoute } | { ok: false; invalid: string[] } {
  const handles: string[] = []
  const invalid: string[] = []
  const seen = new Set<string>()

  for (const raw of rawHandles) {
    const handle = normaliseHandle(raw)
    if (!handle) {
      const shown = raw.trim()
      if (shown) invalid.push(shown)
      continue
    }
    if (seen.has(handle)) continue
    seen.add(handle)
    handles.push(handle)
  }

  if (invalid.length > 0) return { ok: false, invalid }
  handles.sort()
  return { ok: true, route: { restricted, handles } }
}

/**
 * Does this server get this trader?
 *
 * No row, or a row that is not restricted, means yes — every server that
 * has not been configured keeps the whole feed. A restricted row is an
 * allow-list: a missing handle, including an event we could not name,
 * does not pass.
 */
export function routeAllows(
  route: Pick<FomoServerRoute, 'restricted' | 'handles'> | undefined,
  traderHandle: string | undefined,
): boolean {
  if (!route?.restricted) return true
  const handle = traderHandle ? normaliseHandle(traderHandle) : null
  if (!handle) return false
  return route.handles.includes(handle)
}

export async function routesByGuild(): Promise<Map<string, FomoServerRoute>> {
  const rows = await getCollections().fomoRoutes.find({}).toArray()
  return new Map(rows.map((row) => [row.guildId, row]))
}

export interface KnownFomoAccount {
  handle: string
  name?: string
  lastSeen?: Date
}

/**
 * Accounts we have actually seen on the feed, newest activity first within
 * each handle, then sorted by handle for a stable checkbox list.
 *
 * This is the follow list as far as the bot can know it. Fomo does not hand
 * us "who this login follows" as a directory; a handle shows up here the
 * first time that account buys, sells, or posts a thesis.
 */
export async function listKnownAccounts(): Promise<KnownFomoAccount[]> {
  const rows = await getCollections()
    .fomoAlerts.aggregate<{ _id: string; name?: string; lastSeen?: Date }>([
      { $match: { traderHandle: { $type: 'string', $ne: '' } } },
      { $sort: { receivedAt: -1 } },
      {
        $group: {
          _id: { $toLower: '$traderHandle' },
          name: { $first: '$traderName' },
          lastSeen: { $first: '$receivedAt' },
        },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray()

  return rows
    .map((row) => {
      const handle = normaliseHandle(row._id)
      if (!handle) return null
      const account: KnownFomoAccount = { handle }
      if (row.name && row.name.toLowerCase() !== handle) account.name = row.name
      if (row.lastSeen) account.lastSeen = row.lastSeen
      return account
    })
    .filter((account): account is KnownFomoAccount => account !== null)
}

export async function saveRoute(
  guildId: string,
  route: PreparedRoute,
  updatedBy: string,
): Promise<FomoServerRoute> {
  const updatedAt = new Date()
  await getCollections().fomoRoutes.updateOne(
    { guildId },
    {
      $set: {
        guildId,
        restricted: route.restricted,
        handles: route.handles,
        updatedAt,
        updatedBy,
      },
    },
    { upsert: true },
  )
  return { guildId, restricted: route.restricted, handles: route.handles, updatedAt, updatedBy }
}
