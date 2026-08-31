import { beforeEach, describe, expect, it, vi } from 'vitest'

// The module reads accounts through config, so the env has to be in place
// before it is imported.
vi.stubEnv('DISCORD_TOKEN', 'test-token')
vi.stubEnv('DISCORD_CLIENT_ID', '000000000000000000')

const { clearFailures, hashPassword, isLockedOut, parseAccounts, recordFailure, verifyPassword } =
  await import('../password.js')

const { config } = await import('../../config.js')

const ENTRY = hashPassword('Wayne@Example.com ', 'correct horse')

describe('parseAccounts', () => {
  it('reads several entries and lowercases the email', () => {
    const other = hashPassword('ash@example.com', 'another')
    const parsed = parseAccounts(`${ENTRY}, ${other}`)

    expect(parsed.map((a) => a.email)).toEqual(['wayne@example.com', 'ash@example.com'])
  })

  it('drops anything that is not a scrypt entry', () => {
    expect(parseAccounts('')).toEqual([])
    expect(parseAccounts('not-an-entry')).toEqual([])
    expect(parseAccounts('someone@example.com:plaintext')).toEqual([])
    expect(parseAccounts('someone@example.com:scrypt.onlysalt')).toEqual([])
  })
})

describe('verifyPassword', () => {
  beforeEach(() => {
    // config is frozen at import, so the accounts list is swapped in directly.
    ;(config as { DASHBOARD_USERS: string }).DASHBOARD_USERS = ENTRY
  })

  it('accepts the right password, ignoring case and padding in the email', () => {
    expect(verifyPassword('wayne@example.com', 'correct horse')?.email).toBe('wayne@example.com')
    expect(verifyPassword('  WAYNE@Example.com ', 'correct horse')).toBeDefined()
  })

  it('rejects a wrong password and an unknown email alike', () => {
    expect(verifyPassword('wayne@example.com', 'correct hors')).toBeUndefined()
    expect(verifyPassword('nobody@example.com', 'correct horse')).toBeUndefined()
  })

  it('admits nobody when no accounts are configured', () => {
    ;(config as { DASHBOARD_USERS: string }).DASHBOARD_USERS = ''

    expect(verifyPassword('wayne@example.com', 'correct horse')).toBeUndefined()
    expect(verifyPassword('', '')).toBeUndefined()
  })
})

describe('lockout', () => {
  const NOW = Date.UTC(2026, 0, 15, 12, 0, 0)

  beforeEach(() => clearFailures('1.2.3.4'))

  it('locks a client out only after the eighth failure', () => {
    for (let i = 0; i < 7; i += 1) recordFailure('1.2.3.4', NOW)
    expect(isLockedOut('1.2.3.4', NOW)).toBe(false)

    recordFailure('1.2.3.4', NOW)
    expect(isLockedOut('1.2.3.4', NOW)).toBe(true)
  })

  it('forgets failures once the window passes', () => {
    for (let i = 0; i < 8; i += 1) recordFailure('1.2.3.4', NOW)

    expect(isLockedOut('1.2.3.4', NOW + 14 * 60_000)).toBe(true)
    expect(isLockedOut('1.2.3.4', NOW + 16 * 60_000)).toBe(false)
  })

  it('keeps clients separate', () => {
    for (let i = 0; i < 8; i += 1) recordFailure('1.2.3.4', NOW)

    expect(isLockedOut('5.6.7.8', NOW)).toBe(false)
  })
})
