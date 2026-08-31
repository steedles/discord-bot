import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'

/**
 * Email + password sign-in, as a second door beside Discord OAuth.
 *
 * It exists because the people who need to tune thresholds are not always the
 * people who hold Manage Server on the guild the bot sits in - the OAuth path
 * can only ever admit the latter. This one is deliberately small: accounts live
 * in an environment variable, there is no registration, no reset flow and no
 * user table to get out of step with anything.
 *
 * Passwords are stored as scrypt hashes, never as plaintext, so a leaked `.env`
 * hands over a work factor rather than a login. Generate an entry with
 * `pnpm dashboard:hash <password>`.
 *
 * Fail-closed, exactly as the rest of the dashboard is: an empty or unparseable
 * `DASHBOARD_USERS` means the route rejects everything rather than admitting
 * anyone.
 */

/** scrypt output length. 64 bytes is node's own documented example size. */
const KEY_LENGTH = 64

export interface Account {
  email: string
  saltHex: string
  hashHex: string
}

/**
 * `name:scrypt.<saltHex>.<hashHex>`, entries separated by commas or newlines.
 * The name is whatever someone types to sign in - an email or a bare username,
 * since these accounts are handed out rather than registered.
 *
 * Dots rather than the conventional `$`: this value travels through a shell -
 * `deploy.sh` sources the env file - and an unquoted `$abc` there expands to
 * nothing, or under `set -u` fails the deploy outright. Hex and dots survive
 * every layer between here and the container.
 */
export function parseAccounts(raw: string): Account[] {
  const out: Account[] = []

  for (const entry of raw.split(/[\s,]+/).filter(Boolean)) {
    const colon = entry.indexOf(':')
    if (colon <= 0) continue

    // Split on the first colon only: neither an email nor a username contains
    // one, and the hash half is delimited by `$`.
    const email = entry.slice(0, colon).trim().toLowerCase()
    const [scheme, saltHex, hashHex] = entry.slice(colon + 1).split('.')

    if (scheme !== 'scrypt' || !saltHex || !hashHex) continue
    out.push({ email, saltHex, hashHex })
  }

  return out
}

export function accounts(): Account[] {
  return parseAccounts(config.DASHBOARD_USERS)
}

/** Produces a `DASHBOARD_USERS` entry. Used by `pnpm dashboard:hash`. */
export function hashPassword(email: string, password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEY_LENGTH)
  return `${email.trim().toLowerCase()}:scrypt.${salt.toString('hex')}.${hash.toString('hex')}`
}

/**
 * Checks a password against the configured accounts.
 *
 * Always runs a scrypt derivation, even when the email is unknown, so that
 * "no such account" and "wrong password" take the same time to answer. Without
 * that, the response time alone enumerates who has a login.
 */
export function verifyPassword(email: string, password: string): Account | undefined {
  const wanted = email.trim().toLowerCase()
  const all = accounts()

  const account = all.find((a) => a.email === wanted)
  const saltHex = account?.saltHex ?? '00'.repeat(16)
  const expected = Buffer.from(account?.hashHex ?? '00'.repeat(KEY_LENGTH), 'hex')

  const derived = scryptSync(password, Buffer.from(saltHex, 'hex'), KEY_LENGTH)

  if (expected.length !== derived.length) return undefined
  const matches = timingSafeEqual(derived, expected)

  return account && matches ? account : undefined
}

// --- brute-force throttle --------------------------------------------------

/**
 * A password form on a public URL will be found and hammered. This is not a
 * general rate limiter - it only remembers failures, in memory, per client, and
 * a restart forgets them. That is proportionate for a handful of accounts, and
 * it turns an online guessing attack into one that takes years rather than
 * hours.
 */
const MAX_FAILURES = 8
const WINDOW_MS = 15 * 60_000

const failures = new Map<string, { count: number; resetAt: number }>()

export function isLockedOut(key: string, now = Date.now()): boolean {
  const record = failures.get(key)
  if (!record) return false
  if (record.resetAt <= now) {
    failures.delete(key)
    return false
  }
  return record.count >= MAX_FAILURES
}

export function recordFailure(key: string, now = Date.now()): void {
  const record = failures.get(key)
  if (!record || record.resetAt <= now) {
    failures.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return
  }
  record.count += 1
}

export function clearFailures(key: string): void {
  failures.delete(key)
}
