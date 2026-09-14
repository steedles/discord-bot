import { describe, expect, it } from 'vitest'
import { isTransientSendError } from '../../../workers/fomo-watch.js'

/**
 * Which send failures are worth another attempt.
 *
 * Three alerts were lost between 2026-09-11 and 09-14 to `getaddrinfo EAI_AGAIN
 * discord.com` - a DNS blip lasting seconds, with no retry behind it. The risk
 * in adding one is the opposite mistake: retrying a permission error turns one
 * misconfigured channel into rate-limit pressure on every other channel, so the
 * classifier has to be right in both directions.
 */

describe('isTransientSendError', () => {
  it('retries the DNS failure that actually lost the alerts', () => {
    const err = Object.assign(new Error('getaddrinfo EAI_AGAIN discord.com'), {
      code: 'EAI_AGAIN',
      errno: -3001,
      syscall: 'getaddrinfo',
    })
    expect(isTransientSendError(err)).toBe(true)
  })

  it('retries the other Node socket failures of the same family', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE']) {
      expect(isTransientSendError(Object.assign(new Error(code), { code })), code).toBe(true)
    }
  })

  it('does NOT retry a permission error, which will fail identically next time', () => {
    // discord.js carries a numeric code and an HTTP status. 50001 is Missing
    // Access, 50013 Missing Permissions - a channel misconfiguration, not a blip.
    for (const [code, status] of [
      [50001, 403],
      [50013, 403],
      [10003, 404],
    ] as const) {
      expect(isTransientSendError(Object.assign(new Error('discord'), { code, status })), String(code)).toBe(false)
    }
  })

  it('does not retry a bad payload', () => {
    expect(isTransientSendError(Object.assign(new Error('bad body'), { code: 50035, status: 400 }))).toBe(false)
  })

  it('retries Discord being unwell', () => {
    for (const status of [500, 502, 503]) {
      expect(isTransientSendError(Object.assign(new Error('server'), { status })), String(status)).toBe(true)
    }
  })

  it('treats an unrecognised failure as permanent', () => {
    // Retrying something we cannot classify is how one bad message becomes a loop.
    expect(isTransientSendError(new Error('who knows'))).toBe(false)
    expect(isTransientSendError(null)).toBe(false)
    expect(isTransientSendError(undefined)).toBe(false)
    expect(isTransientSendError('a string')).toBe(false)
  })
})
