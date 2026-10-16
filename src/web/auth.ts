import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import type { Session } from '../db/models.js'
import { getCollections } from '../db/mongo.js'
import { log } from '../logger.js'
import { verifyPassword } from './password.js'
import { guildIdsForSession } from './access.js'

const COOKIE_NAME = 'dbsession'
const DISCORD_API = 'https://discord.com/api/v10'

/** Discord's MANAGE_GUILD bit. Anyone with it can configure the bot. */
const MANAGE_GUILD = 1n << 5n

export interface DiscordUser {
  id: string
  username: string
  global_name?: string | null
  avatar?: string | null
}

interface DiscordPartialGuild {
  id: string
  name: string
  icon?: string | null
  owner?: boolean
  permissions?: string
}

// --- cookie signing --------------------------------------------------------

function sign(value: string): string {
  return createHmac('sha256', config.SESSION_SECRET ?? '').update(value).digest('base64url')
}

function signedCookie(sessionId: string): string {
  return `${sessionId}.${sign(sessionId)}`
}

/** Constant-time verification so a signature cannot be brute-forced by timing. */
function readSignedCookie(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const dot = raw.lastIndexOf('.')
  if (dot <= 0) return undefined

  const sessionId = raw.slice(0, dot)
  const provided = Buffer.from(raw.slice(dot + 1))
  const expected = Buffer.from(sign(sessionId))

  if (provided.length !== expected.length) return undefined
  return timingSafeEqual(provided, expected) ? sessionId : undefined
}

// --- OAuth flow ------------------------------------------------------------

export function redirectUri(): string {
  return `${config.DASHBOARD_URL}/auth/callback`
}

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.DISCORD_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'identify guilds',
    state,
    prompt: 'none',
  })
  return `https://discord.com/oauth2/authorize?${params}`
}

export function newState(): string {
  return randomBytes(16).toString('hex')
}

async function exchangeCode(code: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: config.DISCORD_CLIENT_ID,
    client_secret: config.DISCORD_CLIENT_SECRET ?? '',
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
  })

  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })

  if (!res.ok) throw new Error(`Discord token exchange failed: ${res.status} ${await res.text()}`)
  const json = (await res.json()) as { access_token?: string }
  if (!json.access_token) throw new Error('Discord token exchange returned no access token')
  return json.access_token
}

async function fetchDiscord<T>(path: string, accessToken: string): Promise<T> {
  const res = await fetch(`${DISCORD_API}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Discord ${path} failed: ${res.status}`)
  return (await res.json()) as T
}

/**
 * Completes the OAuth exchange and stores a session.
 *
 * `botGuildIds` is the set of guilds the bot is actually in. Intersecting it
 * with the user's manageable guilds means the dashboard only ever offers
 * servers where changes would do something.
 */
export async function completeLogin(code: string, botGuildIds: Set<string>): Promise<string> {
  const accessToken = await exchangeCode(code)

  const user = await fetchDiscord<DiscordUser>('/users/@me', accessToken)
  const guilds = await fetchDiscord<DiscordPartialGuild[]>('/users/@me/guilds', accessToken)

  const manageable = guilds
    .filter((g) => {
      if (!botGuildIds.has(g.id)) return false
      if (g.owner) return true
      const perms = BigInt(g.permissions ?? '0')
      return (perms & MANAGE_GUILD) === MANAGE_GUILD
    })
    .map((g) => g.id)

  const sessionId = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + config.SESSION_DAYS * 86_400_000)

  const { sessions } = getCollections()
  await sessions.insertOne({
    sessionId,
    userId: user.id,
    username: user.global_name || user.username,
    ...(user.avatar ? { avatar: user.avatar } : {}),
    guildIds: manageable,
    createdAt: new Date(),
    expiresAt,
  })

  log.bot.info({ userId: user.id, guilds: manageable.length }, 'dashboard login')
  return sessionId
}

/**
 * Signs in with email + password and stores a session.
 *
 * Unlike the OAuth path there is no per-guild permission to read. With no
 * access row saved, the session may open every guild the bot is in. A row
 * from the Access tab narrows that, and `requireGuildAccess` reads it on
 * each request so a change applies without a new login. `local` marks the
 * session so that check uses the live guild list rather than a snapshot.
 */
export async function completePasswordLogin(
  email: string,
  password: string,
  botGuildIds: Set<string>,
): Promise<string | undefined> {
  const account = verifyPassword(email, password)
  if (!account) return undefined

  const sessionId = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + config.SESSION_DAYS * 86_400_000)
  const guildIds = await guildIdsForSession(
    { local: true, username: account.email, guildIds: [] },
    botGuildIds,
  )

  const { sessions } = getCollections()
  await sessions.insertOne({
    sessionId,
    userId: `local:${account.email}`,
    username: account.email,
    guildIds,
    local: true,
    createdAt: new Date(),
    expiresAt,
  })

  log.bot.info({ email: account.email, guilds: guildIds.length }, 'dashboard password login')
  return sessionId
}

// --- session handling ------------------------------------------------------

export function setSessionCookie(reply: FastifyReply, sessionId: string): void {
  reply.setCookie(COOKIE_NAME, signedCookie(sessionId), {
    httpOnly: true,
    sameSite: 'lax',
    // The dashboard is expected behind HTTPS in production; over plain HTTP on
    // a LAN a Secure cookie would never be sent back.
    secure: config.DASHBOARD_URL.startsWith('https://'),
    path: '/',
    maxAge: config.SESSION_DAYS * 86_400,
  })
}

export async function clearSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const sessionId = readSignedCookie(request.cookies[COOKIE_NAME])
  if (sessionId) {
    const { sessions } = getCollections()
    await sessions.deleteOne({ sessionId })
  }
  reply.clearCookie(COOKIE_NAME, { path: '/' })
}

export async function getSession(request: FastifyRequest): Promise<Session | undefined> {
  const sessionId = readSignedCookie(request.cookies[COOKIE_NAME])
  if (!sessionId) return undefined

  const { sessions } = getCollections()
  const session = await sessions.findOne({ sessionId })
  if (!session) return undefined

  // The TTL index reaps these eventually; check explicitly so an expired
  // session is never honoured in the window before Mongo gets to it.
  if (session.expiresAt.getTime() < Date.now()) {
    await sessions.deleteOne({ sessionId })
    return undefined
  }

  return session
}

/** Replies 401 and returns undefined when there is no valid session. */
export async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Session | undefined> {
  const session = await getSession(request)
  if (!session) {
    await reply.code(401).send({ error: 'Not signed in' })
    return undefined
  }
  return session
}

/**
 * Replies 401/403 unless the session may administer `guildId`.
 *
 * A Discord session is limited to the guilds it held Manage Server on when it
 * signed in. A password session is every guild the bot is in, unless the
 * Access tab has limited that login. Omitting `botGuildIds` falls back to
 * the list stored on the session, so a caller that forgets it can only ever
 * be more restrictive, never less.
 */
export async function requireGuildAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  guildId: string,
  botGuildIds?: Set<string>,
): Promise<Session | undefined> {
  const session = await requireSession(request, reply)
  if (!session) return undefined

  const allowed = await guildIdsForSession(session, botGuildIds)
  if (!allowed.includes(guildId)) {
    await reply.code(403).send({ error: 'You do not have access to that server' })
    return undefined
  }

  return session
}
