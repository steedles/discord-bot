import { describe, expect, it } from 'vitest'
import { featureEmbed, overviewEmbed } from '../../discord/commands/help.js'
import type { ResolvedFeature } from '../../db/features.js'
import { FEATURES } from '../registry.js'
import { defaultSettings, readSettings, type FeatureDescriptor } from '../types.js'

/**
 * Discord's own caps. Exceeding one is a 400 at send time rather than a
 * truncated message, so a feature whose help grew too long would break `/help`
 * for every feature, not just its own.
 */
const MAX_DESCRIPTION = 4096
const MAX_FIELD_VALUE = 1024
const MAX_FIELD_NAME = 256
const MAX_EMBED_TOTAL = 6000

function resolved(feature: FeatureDescriptor): ResolvedFeature {
  const settings = defaultSettings(feature)
  return { feature, enabled: feature.defaultEnabled, settings, read: readSettings(settings) }
}

function assertFits(embed: ReturnType<typeof overviewEmbed>, label: string): void {
  const data = embed.toJSON()
  let total = (data.description ?? '').length + (data.title ?? '').length

  expect(data.description?.length ?? 0, `${label}: description`).toBeLessThanOrEqual(MAX_DESCRIPTION)

  for (const field of data.fields ?? []) {
    expect(field.name.length, `${label}: field name "${field.name}"`).toBeLessThanOrEqual(MAX_FIELD_NAME)
    expect(field.value.length, `${label}: field "${field.name}"`).toBeLessThanOrEqual(MAX_FIELD_VALUE)
    total += field.name.length + field.value.length
  }

  expect(total, `${label}: total`).toBeLessThanOrEqual(MAX_EMBED_TOTAL)
}

describe('/help', () => {
  it('explains every feature in the registry', () => {
    // Not optional in practice, only in the type: a feature with no help block
    // falls back to its one-line description, which is what the dashboard card
    // already says and is not an explanation.
    for (const feature of FEATURES) {
      expect(feature.help?.detail?.length ?? 0, `${feature.id} has no help`).toBeGreaterThan(0)
    }
  })

  it('fits the overview inside Discord\'s limits', () => {
    assertFits(overviewEmbed(FEATURES.map(resolved)), 'overview')
    assertFits(overviewEmbed(undefined), 'overview in a DM')
  })

  it('fits every feature\'s detail inside Discord\'s limits', () => {
    for (const feature of FEATURES) {
      assertFits(featureEmbed(feature, resolved(feature)), feature.id)
      assertFits(featureEmbed(feature, undefined), `${feature.id} in a DM`)
    }
  })

  it('shows a setting as what it is set to, not as raw JSON', () => {
    const data = featureEmbed(FEATURES.find((f) => f.id === 'vamp-watch')!, undefined).toJSON()
    const settings = data.fields?.find((f) => f.name.startsWith('Settings'))?.value ?? ''

    expect(settings).toContain('**Volume ratio to fire** — 1.5x')
    expect(settings).toContain('**Minimum volume on the copy** — 50,000 USD')
    expect(settings).toContain('**Which side to hear about** — Both sides')
    expect(settings).toContain('**Chains** — all')
  })
})
