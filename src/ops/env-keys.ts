/**
 * The env keys the Setup tab may change, and what a value for each must look
 * like. Pure - no config import - so the rules can be tested and so the runner
 * (`deploy/homelab/ops-runner/ops-runner.py`) can restate them exactly.
 *
 * This is an allowlist by design. The runner rewrites `.env.homelab` and that
 * file also holds the Discord token, the session secret and every other
 * credential the bot runs on; a route that could set any key would be a route
 * that could replace `DISCORD_TOKEN`. The seven here are the ones the setup
 * guide asks Ash for, and nothing else is reachable from the dashboard.
 *
 * Both sides check. The bot rejects a bad value before it is ever queued, and
 * the runner rejects it again before it touches the file - because the runner
 * is the thing with write access, it cannot rely on having been called
 * correctly.
 */

export type EnvKey =
  | 'HELIUS_API_KEY'
  | 'ETHEREUM_RPC_URL'
  | 'ETHEREUM_WS_URL'
  | 'BSC_RPC_URL'
  | 'BSC_WS_URL'
  | 'BASE_RPC_URL'
  | 'BASE_WS_URL'

export interface EnvKeySpec {
  key: EnvKey
  label: string
  /** Which setup-guide section asks for it. */
  group: 'helius' | 'alchemy'
  placeholder: string
  /** Returns the problem, or undefined when the value may be written. */
  validate: (value: string) => string | undefined
}

/**
 * A Helius key is a UUID. Accepting a little more than that (dashes, hex,
 * letters) costs nothing; accepting whitespace, quotes or a `#` would let a
 * value break the env file's line format, which is what actually matters.
 */
const helius = (v: string): string | undefined =>
  /^[A-Za-z0-9-]{16,128}$/.test(v) ? undefined : 'Expected the Helius API key itself - letters, digits and dashes only.'

const url =
  (scheme: 'https' | 'wss') =>
  (v: string): string | undefined => {
    let parsed: URL
    try {
      parsed = new URL(v)
    } catch {
      return `Not a URL.`
    }
    if (parsed.protocol !== `${scheme}:`) return `Must start with ${scheme}://`
    if (!parsed.hostname) return 'No hostname.'
    if (/\s/.test(v) || v.length > 512) return 'Unexpected characters.'
    return undefined
  }

export const ENV_KEYS: readonly EnvKeySpec[] = [
  {
    key: 'HELIUS_API_KEY',
    label: 'Helius API key',
    group: 'helius',
    placeholder: 'From the Helius dashboard front page',
    validate: helius,
  },
  { key: 'ETHEREUM_RPC_URL', label: 'Ethereum HTTPS', group: 'alchemy', placeholder: 'https://eth-mainnet.g.alchemy.com/v2/…', validate: url('https') },
  { key: 'ETHEREUM_WS_URL', label: 'Ethereum WebSocket', group: 'alchemy', placeholder: 'wss://eth-mainnet.g.alchemy.com/v2/…', validate: url('wss') },
  { key: 'BSC_RPC_URL', label: 'BSC HTTPS', group: 'alchemy', placeholder: 'https://bnb-mainnet.g.alchemy.com/v2/…', validate: url('https') },
  { key: 'BSC_WS_URL', label: 'BSC WebSocket', group: 'alchemy', placeholder: 'wss://bnb-mainnet.g.alchemy.com/v2/…', validate: url('wss') },
  { key: 'BASE_RPC_URL', label: 'Base HTTPS', group: 'alchemy', placeholder: 'https://base-mainnet.g.alchemy.com/v2/…', validate: url('https') },
  { key: 'BASE_WS_URL', label: 'Base WebSocket', group: 'alchemy', placeholder: 'wss://base-mainnet.g.alchemy.com/v2/…', validate: url('wss') },
]

const BY_KEY = new Map(ENV_KEYS.map((s) => [s.key as string, s]))

export const isEnvKey = (key: string): key is EnvKey => BY_KEY.has(key)

export interface EnvValidation {
  ok: boolean
  /** Trimmed, allowlisted, valid - the only thing that may be queued. */
  values: Partial<Record<EnvKey, string>>
  errors: string[]
}

/**
 * Filters a dashboard payload down to values that may be written.
 *
 * Unknown keys are an error rather than silently dropped: a typo in the
 * frontend would otherwise look like a successful save that changed nothing.
 * Blank values are skipped, not errors - the form sends every field and an
 * empty one means "leave that alone", never "clear it".
 */
export function validateEnvValues(input: Record<string, unknown>): EnvValidation {
  const values: Partial<Record<EnvKey, string>> = {}
  const errors: string[] = []

  for (const [key, raw] of Object.entries(input)) {
    const spec = BY_KEY.get(key)
    if (!spec) {
      errors.push(`${key} cannot be set from here.`)
      continue
    }
    if (typeof raw !== 'string') {
      errors.push(`${spec.label}: expected text.`)
      continue
    }
    const value = raw.trim()
    if (value === '') continue

    const problem = spec.validate(value)
    if (problem) {
      errors.push(`${spec.label}: ${problem}`)
      continue
    }
    values[spec.key] = value
  }

  return { ok: errors.length === 0, values, errors }
}
