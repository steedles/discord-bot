/**
 * Feature descriptors.
 *
 * A feature declares its own settings as data rather than as code. The
 * dashboard renders its form straight from this schema and the API validates
 * against it, so adding a feature - or a setting to one - never means editing
 * the dashboard, the API, or the database layer. Everything downstream is
 * generic over these types.
 */

/**
 * One row of a banded threshold: everything up to `upTo` takes `value`.
 *
 * `upTo: null` is the catch-all top band. Exactly one exists and it is always
 * last, so every input lands in some band - a threshold with a hole in it reads
 * as "no limit here" and silently stops filtering.
 */
export interface Band {
  upTo: number | null
  value: number
}

export type SettingValue = boolean | number | string | string[] | Band[]

/**
 * Discord snowflakes are 17-20 digits. Anchored, unlike the scanning regex the
 * ping parser uses: a stored role id is the whole value or it is not an id.
 */
const SNOWFLAKE_ID = /^\d{17,20}$/

interface FieldBase {
  key: string
  label: string
  /** Shown under the field in the dashboard. Explain the trade-off, not the type. */
  description?: string
  /** Hides the field until the named boolean setting is true. */
  showWhen?: { key: string; equals: SettingValue }
}

export interface BooleanField extends FieldBase {
  type: 'boolean'
  default: boolean
}

export interface NumberField extends FieldBase {
  type: 'number'
  default: number
  min?: number
  max?: number
  step?: number
  /** Rendered next to the input, e.g. "USD" or "minutes". */
  unit?: string
}

export interface StringField extends FieldBase {
  type: 'string'
  default: string
  maxLength?: number
  placeholder?: string
}

export interface SelectField extends FieldBase {
  type: 'select'
  default: string
  options: { value: string; label: string }[]
}

export interface MultiSelectField extends FieldBase {
  type: 'multiselect'
  default: string[]
  options: { value: string; label: string }[]
  /** Empty selection means "all options" rather than "none". */
  emptyMeansAll?: boolean
}

/**
 * Discord roles to mention, chosen from the guild's own role list.
 *
 * The options are not declared here because they are not knowable here: they
 * are whatever roles the server has right now. The dashboard fills them from
 * `/api/guilds/:guildId/roles` and the validator checks only the shape - a
 * feature descriptor cannot name a role that a guild may not have, and a role
 * deleted after it was picked has to fail as "nobody to ping" rather than as a
 * rejected settings save.
 */
export interface RolesField extends FieldBase {
  type: 'roles'
  default: string[]
  /** Ceiling on how many roles one alert may ping. */
  maxRoles?: number
}

/**
 * A threshold that varies by size.
 *
 * A single number cannot express "$1k of volume means dead for a $30k coin but
 * nothing at all for a $5m one". Rather than special-casing that inside one
 * feature, the schema carries the shape and the dashboard renders it - so any
 * later "it depends how big it is" setting gets the same editor for free.
 */
export interface BandsField extends FieldBase {
  type: 'bands'
  default: Band[]
  /** Column heading for the band edge, e.g. "Market cap up to". */
  edgeLabel: string
  /** Column heading for the threshold, e.g. "Minimum 5m volume". */
  valueLabel: string
  edgeUnit?: string
  valueUnit?: string
  /** Bounds applied to the value column. */
  min?: number
  max?: number
  maxRows?: number
}

export type SettingField =
  | BooleanField
  | NumberField
  | StringField
  | SelectField
  | MultiSelectField
  | RolesField
  | BandsField

export type FeatureSettings = Record<string, SettingValue>

/**
 * How a feature relates to channels.
 *
 * - `push`     sends messages on its own schedule, so every instance names a
 *              channel - each row is a destination, not an override.
 * - `command`  answers slash commands.
 * - `listener` reacts to messages in whatever channel they appear in.
 *
 * `command` and `listener` both run guild-wide with optional per-channel
 * overrides; they differ only in what triggers them, which the dashboard shows
 * so an admin can tell why a feature might speak.
 */
export type FeatureKind = 'push' | 'command' | 'listener'

/** Whether every instance of this kind must name a channel. */
export function requiresChannel(kind: FeatureKind): boolean {
  return kind === 'push'
}

/**
 * The long-form explanation `/help <feature>` prints.
 *
 * Declared here as data for the same reason settings are: `/help` is generic
 * over the registry and contains no per-feature code, so a new feature explains
 * itself by filling this in rather than by an edit to the help command. A
 * feature without it still appears everywhere - the help simply falls back to
 * its one-line `description`.
 */
export interface FeatureHelp {
  /**
   * What it does and, where it matters, what it refuses to claim. Paragraphs,
   * because the honest version of most of these needs a sentence of "and here
   * is what that number is not".
   */
  detail: string[]
  /**
   * Commands worth knowing that this feature does not itself gate - `/watch`
   * for anything on the monitor, say. The commands it *owns* are already in
   * `commands` and are listed without being repeated here.
   */
  seeAlso?: string[]
  /** One line on what to do first, after switching it on. */
  firstStep?: string
}

export interface FeatureDescriptor {
  id: string
  name: string
  /** One line, shown on the dashboard card. */
  description: string
  /** Emoji used as the card icon. */
  icon: string
  kind: FeatureKind
  /**
   * Whether the feature is on when a guild has never configured it. Push
   * features default off - nobody wants a bot posting somewhere unasked.
   */
  defaultEnabled: boolean
  /** Slash commands this feature gates, for display and channel checks. */
  commands: string[]
  settings: SettingField[]
  /** Long-form help. Optional: a feature without it falls back to `description`. */
  help?: FeatureHelp
}

export function defaultSettings(feature: FeatureDescriptor): FeatureSettings {
  const out: FeatureSettings = {}
  for (const field of feature.settings) {
    out[field.key] = copyValue(field.default)
  }
  return out
}

/** Arrays are copied, and band rows copied one level deeper, so a stored value
 * can never alias a descriptor's default and mutate it. */
function copyValue(value: SettingValue): SettingValue {
  if (!Array.isArray(value)) return value
  return value.map((entry) => (typeof entry === 'object' && entry !== null ? { ...entry } : entry)) as SettingValue
}

export interface ValidationResult {
  ok: boolean
  settings: FeatureSettings
  errors: string[]
}

/**
 * Coerces and validates a settings patch against a feature's schema.
 *
 * Unknown keys are dropped rather than rejected, so a dashboard running an
 * older schema cannot write junk into the database. Missing keys fall back to
 * the current value, then the default.
 */
export function validateSettings(
  feature: FeatureDescriptor,
  input: Record<string, unknown>,
  current: FeatureSettings = {},
): ValidationResult {
  const errors: string[] = []
  const settings: FeatureSettings = {}

  for (const field of feature.settings) {
    const provided = Object.hasOwn(input, field.key) ? input[field.key] : undefined
    const fallback = Object.hasOwn(current, field.key) ? current[field.key]! : field.default

    if (provided === undefined) {
      settings[field.key] = copyValue(fallback)
      continue
    }

    const result = coerceField(field, provided)
    if (result.error) {
      errors.push(`${field.label}: ${result.error}`)
      settings[field.key] = copyValue(fallback)
    } else {
      settings[field.key] = result.value!
    }
  }

  return { ok: errors.length === 0, settings, errors }
}

function coerceField(
  field: SettingField,
  raw: unknown,
): { value?: SettingValue; error?: string } {
  switch (field.type) {
    case 'boolean': {
      if (typeof raw === 'boolean') return { value: raw }
      if (raw === 'true' || raw === 'false') return { value: raw === 'true' }
      return { error: 'must be true or false' }
    }

    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(raw)
      if (!Number.isFinite(n)) return { error: 'must be a number' }
      if (field.min !== undefined && n < field.min) return { error: `must be at least ${field.min}` }
      if (field.max !== undefined && n > field.max) return { error: `must be at most ${field.max}` }
      return { value: n }
    }

    case 'string': {
      if (typeof raw !== 'string') return { error: 'must be text' }
      if (field.maxLength !== undefined && raw.length > field.maxLength) {
        return { error: `must be ${field.maxLength} characters or fewer` }
      }
      return { value: raw }
    }

    case 'select': {
      if (typeof raw !== 'string') return { error: 'must be one of the listed options' }
      if (!field.options.some((o) => o.value === raw)) {
        return { error: `must be one of: ${field.options.map((o) => o.value).join(', ')}` }
      }
      return { value: raw }
    }

    case 'bands': {
      if (!Array.isArray(raw)) return { error: 'must be a list of bands' }
      if (raw.length === 0) return { error: 'needs at least one band' }
      if (field.maxRows !== undefined && raw.length > field.maxRows) {
        return { error: `must be ${field.maxRows} bands or fewer` }
      }

      const rows: Band[] = []
      for (const entry of raw) {
        if (typeof entry !== 'object' || entry === null) return { error: 'each band needs an edge and a value' }
        const { upTo, value } = entry as { upTo?: unknown; value?: unknown }

        const amount = typeof value === 'number' ? value : Number(value)
        if (!Number.isFinite(amount)) return { error: 'each band needs a number' }
        if (field.min !== undefined && amount < field.min) return { error: `values must be at least ${field.min}` }
        if (field.max !== undefined && amount > field.max) return { error: `values must be at most ${field.max}` }

        if (upTo === null || upTo === undefined || upTo === '') {
          rows.push({ upTo: null, value: amount })
          continue
        }

        const edge = typeof upTo === 'number' ? upTo : Number(upTo)
        if (!Number.isFinite(edge) || edge <= 0) return { error: 'band edges must be above zero' }
        rows.push({ upTo: edge, value: amount })
      }

      // Sorted, deduplicated, and the last row forced to the catch-all: a set of
      // bands that does not cover everything above the top edge would leave the
      // largest tokens unfiltered, which looks like the setting being ignored.
      const finite = rows.filter((r) => r.upTo !== null).sort((a, b) => a.upTo! - b.upTo!)
      const catchAll = rows.find((r) => r.upTo === null) ?? finite.pop() ?? { upTo: null, value: 0 }

      const seen = new Set<number>()
      const ordered = finite.filter((r) => !seen.has(r.upTo!) && seen.add(r.upTo!))

      return { value: [...ordered, { upTo: null, value: catchAll.value }] }
    }

    case 'roles': {
      if (!Array.isArray(raw)) return { error: 'must be a list of roles' }

      const ids = [...new Set(raw.map(String).map((v) => v.trim()).filter(Boolean))]
      const bad = ids.filter((id) => !SNOWFLAKE_ID.test(id))
      if (bad.length > 0) return { error: `not role ids: ${bad.join(', ')}` }

      const limit = field.maxRoles ?? 5
      if (ids.length > limit) return { error: `pick ${limit} roles or fewer` }
      return { value: ids }
    }

    case 'multiselect': {
      if (!Array.isArray(raw)) return { error: 'must be a list' }
      const values = raw.map(String)
      const allowed = new Set(field.options.map((o) => o.value))
      const unknown = values.filter((v) => !allowed.has(v))
      if (unknown.length > 0) return { error: `unknown option(s): ${unknown.join(', ')}` }
      return { value: [...new Set(values)] }
    }
  }
}

/** Typed reader so features can pull their own settings without casts everywhere. */
export function readSettings(settings: FeatureSettings) {
  return {
    bool: (key: string, fallback = false): boolean =>
      typeof settings[key] === 'boolean' ? (settings[key] as boolean) : fallback,
    num: (key: string, fallback = 0): number =>
      typeof settings[key] === 'number' ? (settings[key] as number) : fallback,
    str: (key: string, fallback = ''): string =>
      typeof settings[key] === 'string' ? (settings[key] as string) : fallback,
    list: (key: string, fallback: string[] = []): string[] =>
      Array.isArray(settings[key]) ? (settings[key] as string[]) : fallback,
    bands: (key: string, fallback: Band[] = []): Band[] =>
      Array.isArray(settings[key]) && isBands(settings[key]) ? (settings[key] as Band[]) : fallback,
  }
}

function isBands(value: unknown): value is Band[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'object' && entry !== null && 'value' in entry)
  )
}

/**
 * The threshold that applies at `size`, or undefined when nothing can be said.
 *
 * Bands are read low to high and the first one whose edge is above `size` wins,
 * with the catch-all answering for everything past the top edge. An unknown size
 * returns undefined rather than falling back to a band, because picking one
 * would be inventing the very fact the caller does not have.
 */
export function bandValue(bands: Band[], size: number | undefined): number | undefined {
  if (size === undefined || !Number.isFinite(size)) return undefined

  for (const band of bands) {
    if (band.upTo === null) return band.value
    if (size < band.upTo) return band.value
  }

  return bands[bands.length - 1]?.value
}
