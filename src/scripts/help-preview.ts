/**
 * Renders `/help` as terminal text.
 *
 * Help is a wall of prose in an embed, and the only way to know whether it
 * reads well - or fits Discord's limits - is to look at one. Needs no Discord
 * connection and no Mongo: the feature state a real reply resolves from the
 * database is faked here, because what is being checked is the layout.
 *
 *   pnpm help-preview            # the overview
 *   pnpm help-preview vamp-watch # one feature
 *   pnpm help-preview all        # every feature, back to back
 */
import { featureEmbed, overviewEmbed } from '../discord/commands/help.js'
import type { ResolvedFeature } from '../db/features.js'
import { FEATURES, getFeature } from '../features/registry.js'
import { defaultSettings, readSettings, type FeatureDescriptor } from '../features/types.js'

/** A feature as it would resolve in a channel that has never configured it. */
function asDefault(feature: FeatureDescriptor): ResolvedFeature {
  const settings = defaultSettings(feature)
  return { feature, enabled: feature.defaultEnabled, settings, read: readSettings(settings) }
}

function show(embed: ReturnType<typeof overviewEmbed>): void {
  const data = embed.toJSON()
  console.log(`\n${'─'.repeat(64)}`)
  console.log(data.description)
  for (const field of data.fields ?? []) console.log(`\n${field.name}\n${field.value}`)

  const size =
    (data.description?.length ?? 0) +
    (data.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0)
  console.log(`\n[${size} characters]`)
}

const target = process.argv[2]
const resolved = FEATURES.map(asDefault)

if (!target) {
  show(overviewEmbed(resolved))
} else if (target === 'all') {
  for (const feature of FEATURES) show(featureEmbed(feature, asDefault(feature)))
} else {
  const feature = getFeature(target)
  if (!feature) {
    console.error(`No such feature: ${target}\nTry one of: ${FEATURES.map((f) => f.id).join(', ')}`)
    process.exit(1)
  }
  show(featureEmbed(feature, asDefault(feature)))
}
