import { describe, expect, it } from 'vitest'
import { ENV_KEYS, validateEnvValues } from '../env-keys.js'

/**
 * The allowlist is the security boundary between a dashboard form and the
 * file that holds the Discord token. What is pinned here is the refusal
 * behaviour, not the happy path.
 */
describe('validateEnvValues', () => {
  it('refuses any key outside the allowlist, by name', () => {
    // A route that accepted DISCORD_TOKEN would be a route that replaced it.
    const result = validateEnvValues({ DISCORD_TOKEN: 'x', HELIUS_API_KEY: 'abcdef1234567890abcd' })
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual(['DISCORD_TOKEN cannot be set from here.'])
    // Nothing is queued while anything is refused.
    expect(result.values).toEqual({ HELIUS_API_KEY: 'abcdef1234567890abcd' })
  })

  it('treats a blank field as "leave it alone", not as a value', () => {
    // The form sends every field. Empty must never clear a key on the homelab.
    const result = validateEnvValues({ HELIUS_API_KEY: '', ETHEREUM_RPC_URL: '   ' })
    expect(result.ok).toBe(true)
    expect(result.values).toEqual({})
  })

  it('holds RPC URLs to https and websocket URLs to wss', () => {
    const bad = validateEnvValues({
      ETHEREUM_RPC_URL: 'http://eth-mainnet.g.alchemy.com/v2/key',
      ETHEREUM_WS_URL: 'https://eth-mainnet.g.alchemy.com/v2/key',
    })
    expect(bad.ok).toBe(false)
    expect(bad.errors).toHaveLength(2)
    expect(bad.errors[0]).toContain('https://')
    expect(bad.errors[1]).toContain('wss://')

    const good = validateEnvValues({
      ETHEREUM_RPC_URL: ' https://eth-mainnet.g.alchemy.com/v2/key ',
      ETHEREUM_WS_URL: 'wss://eth-mainnet.g.alchemy.com/v2/key',
    })
    expect(good.ok).toBe(true)
    expect(good.values.ETHEREUM_RPC_URL).toBe('https://eth-mainnet.g.alchemy.com/v2/key')
  })

  it('refuses a Helius key that could break the env file line format', () => {
    // A newline or a quote in a value is what turns "set one key" into
    // "rewrite the next line too".
    for (const value of ['abc', 'has space in it 123456', 'quote"1234567890abcdef', 'line\nbreak1234567890']) {
      expect(validateEnvValues({ HELIUS_API_KEY: value }).ok).toBe(false)
    }
    expect(validateEnvValues({ HELIUS_API_KEY: '2f1c3d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f' }).ok).toBe(true)
  })

  it('rejects non-string values rather than coercing them', () => {
    const result = validateEnvValues({ HELIUS_API_KEY: 12345678901234567890 })
    expect(result.ok).toBe(false)
  })

  it('ships exactly the seven keys the setup guide asks for', () => {
    expect(ENV_KEYS.map((s) => s.key).sort()).toEqual(
      ['BASE_RPC_URL', 'BASE_WS_URL', 'BSC_RPC_URL', 'BSC_WS_URL', 'ETHEREUM_RPC_URL', 'ETHEREUM_WS_URL', 'HELIUS_API_KEY'].sort(),
    )
  })
})
