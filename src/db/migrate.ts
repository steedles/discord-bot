import { log } from '../logger.js'
import { LAUNCH_SCANNER } from '../features/registry.js'
import { defaultSettings } from '../features/types.js'
import type { FeatureInstance } from './models.js'
import { getCollections } from './mongo.js'

/**
 * Moves pre-feature-registry scanner config into feature instances.
 *
 * Runs on every startup and is idempotent: it only writes rows that do not
 * already exist. The old `guilds` collection is left untouched rather than
 * dropped, so a bad migration can be inspected and re-run.
 */
export async function migrateScannerConfig(): Promise<void> {
  const { guilds, featureInstances } = getCollections()

  const legacy = await guilds.find({ 'scanner.channelId': { $exists: true } }).toArray()
  if (legacy.length === 0) return

  let migrated = 0

  for (const old of legacy) {
    const channelId = old.scanner?.channelId
    if (!channelId) continue

    const filter = { guildId: old.guildId, featureId: LAUNCH_SCANNER.id, channelId }
    if (await featureInstances.findOne(filter)) continue

    const f = old.scanner.filters
    const now = new Date()

    const instance: FeatureInstance = {
      ...filter,
      enabled: old.scanner.enabled ?? false,
      label: 'Migrated from /scanner',
      settings: {
        ...defaultSettings(LAUNCH_SCANNER),
        chains: f?.chains ?? [],
        minLiquidityUsd: f?.minLiquidityUsd ?? 15_000,
        minVolume24hUsd: f?.minVolume24hUsd ?? 25_000,
        maxAgeMinutes: f?.maxAgeMinutes ?? 720,
        maxRiskScore: f?.maxRiskScore ?? 45,
        requireSocials: f?.requireSocials ?? true,
      },
      createdAt: old.createdAt ?? now,
      updatedAt: now,
    }

    await featureInstances.insertOne(instance)
    migrated += 1
  }

  if (migrated > 0) {
    log.db.info({ migrated }, 'migrated legacy scanner config into feature instances')
  }
}
