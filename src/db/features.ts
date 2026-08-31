import { ObjectId } from 'mongodb'
import {
  defaultSettings,
  readSettings,
  requiresChannel,
  validateSettings,
  type FeatureDescriptor,
  type FeatureSettings,
} from '../features/types.js'
import { FEATURES, getFeature } from '../features/registry.js'
import type { FeatureInstance } from './models.js'
import { getCollections } from './mongo.js'

export interface ResolvedFeature {
  feature: FeatureDescriptor
  enabled: boolean
  settings: FeatureSettings
  /** Which stored row decided this, if any. */
  instance?: FeatureInstance
  /** Convenience readers over `settings`. */
  read: ReturnType<typeof readSettings>
}

/**
 * Works out whether a feature is on in one channel, and with what settings.
 * See `resolveFrom` for the precedence.
 */
export async function resolveFeature(
  featureId: string,
  guildId: string,
  channelId?: string | null,
): Promise<ResolvedFeature | undefined> {
  const feature = getFeature(featureId)
  if (!feature) return undefined

  const { featureInstances } = getCollections()

  const rows = await featureInstances
    .find({
      guildId,
      featureId,
      $or: [{ channelId: null }, ...(channelId ? [{ channelId }] : [])],
    })
    .toArray()

  return resolveFrom(feature, rows, channelId)
}

/**
 * The same question for every feature at once, off a single query.
 *
 * `/help` needs the answer for thirteen features in one reply, and calling
 * `resolveFeature` in a loop would be thirteen round trips to re-apply the same
 * precedence. The precedence itself lives in `resolveFrom` so there is still
 * exactly one implementation of "channel row, then guild row, then defaults".
 */
export async function resolveAllFeatures(
  guildId: string,
  channelId?: string | null,
): Promise<ResolvedFeature[]> {
  const { featureInstances } = getCollections()

  const rows = await featureInstances
    .find({
      guildId,
      $or: [{ channelId: null }, ...(channelId ? [{ channelId }] : [])],
    })
    .toArray()

  return FEATURES.map((feature) =>
    resolveFrom(
      feature,
      rows.filter((r) => r.featureId === feature.id),
      channelId,
    ),
  )
}

/**
 * Channel row, then guild-wide row, then the feature's own defaults.
 *
 * A channel row wins outright rather than merging field-by-field: partial
 * merging makes "why is this channel behaving like that" almost impossible to
 * reason about once a few overrides exist.
 */
function resolveFrom(
  feature: FeatureDescriptor,
  rows: FeatureInstance[],
  channelId?: string | null,
): ResolvedFeature {
  const channelRow = channelId ? rows.find((r) => r.channelId === channelId) : undefined
  const guildRow = rows.find((r) => r.channelId === null)
  const instance = channelRow ?? guildRow

  const settings = { ...defaultSettings(feature), ...(instance?.settings ?? {}) }

  return {
    feature,
    enabled: instance ? instance.enabled : feature.defaultEnabled,
    settings,
    instance,
    read: readSettings(settings),
  }
}

/** Every stored row for a guild, newest first. */
export async function listInstances(guildId: string): Promise<FeatureInstance[]> {
  const { featureInstances } = getCollections()
  return featureInstances.find({ guildId }).sort({ featureId: 1, channelId: 1 }).toArray()
}

/** Every enabled destination for a push feature, across all guilds. */
export async function listEnabledPushInstances(featureId: string): Promise<FeatureInstance[]> {
  const { featureInstances } = getCollections()
  return featureInstances
    .find({ featureId, enabled: true, channelId: { $ne: null } })
    .toArray()
}

export interface UpsertInput {
  guildId: string
  featureId: string
  channelId: string | null
  enabled?: boolean
  settings?: Record<string, unknown>
  label?: string
  updatedBy?: string
}

export interface UpsertResult {
  ok: boolean
  errors: string[]
  instance?: FeatureInstance
}

/**
 * Creates or updates one feature instance. Settings are validated against the
 * feature's schema, so a bad dashboard payload cannot write junk.
 */
export async function upsertInstance(input: UpsertInput): Promise<UpsertResult> {
  const feature = getFeature(input.featureId)
  if (!feature) return { ok: false, errors: [`Unknown feature "${input.featureId}"`] }

  if (requiresChannel(feature.kind) && !input.channelId) {
    return { ok: false, errors: [`${feature.name} posts on its own, so it needs a channel.`] }
  }

  const { featureInstances } = getCollections()
  const filter = { guildId: input.guildId, featureId: input.featureId, channelId: input.channelId }
  const existing = await featureInstances.findOne(filter)

  const current = { ...defaultSettings(feature), ...(existing?.settings ?? {}) }
  const validation = validateSettings(feature, input.settings ?? {}, current)
  if (!validation.ok) return { ok: false, errors: validation.errors }

  const now = new Date()
  await featureInstances.updateOne(
    filter,
    {
      $set: {
        enabled: input.enabled ?? existing?.enabled ?? feature.defaultEnabled,
        settings: validation.settings,
        ...(input.label !== undefined ? { label: input.label } : {}),
        updatedAt: now,
        ...(input.updatedBy ? { updatedBy: input.updatedBy } : {}),
      },
      $setOnInsert: { ...filter, createdAt: now },
    },
    { upsert: true },
  )

  const instance = await featureInstances.findOne(filter)
  return { ok: true, errors: [], instance: instance ?? undefined }
}

export async function setInstanceEnabled(
  guildId: string,
  instanceId: string,
  enabled: boolean,
  updatedBy?: string,
): Promise<FeatureInstance | undefined> {
  if (!ObjectId.isValid(instanceId)) return undefined
  const { featureInstances } = getCollections()

  await featureInstances.updateOne(
    { _id: new ObjectId(instanceId), guildId },
    { $set: { enabled, updatedAt: new Date(), ...(updatedBy ? { updatedBy } : {}) } },
  )

  return (await featureInstances.findOne({ _id: new ObjectId(instanceId), guildId })) ?? undefined
}

export async function deleteInstance(guildId: string, instanceId: string): Promise<boolean> {
  if (!ObjectId.isValid(instanceId)) return false
  const { featureInstances } = getCollections()
  const result = await featureInstances.deleteOne({ _id: new ObjectId(instanceId), guildId })
  return result.deletedCount === 1
}
