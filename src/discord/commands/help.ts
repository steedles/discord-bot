/**
 * `/help` - what this bot does, and what any one part of it does in detail.
 *
 * Generic over the registry, like everything else that talks about features.
 * There is no per-feature code here and none may be added: a feature explains
 * itself through the optional `help` block on its descriptor, alongside the
 * settings schema that already drives the dashboard and `/feature`. A feature
 * that has not filled one in still appears in both views - it falls back to its
 * one-line `description` rather than being missing.
 *
 * Two deliberate choices about what it shows:
 *
 *  - **Ephemeral.** Help is for the person who asked. A dozen people running
 *    `/help` in a trading channel should not push the alerts off the screen.
 *  - **Where things stand *here*.** Every feature is listed with whether it is
 *    on in this channel, because "the bot is not doing anything" is almost
 *    always a feature that was never switched on. That answer is resolved from
 *    one query, through the same precedence `gate()` uses - there is no second
 *    definition of "is this on".
 */
import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js'
import { config } from '../../config.js'
import { resolveAllFeatures, type ResolvedFeature } from '../../db/features.js'
import { FEATURES, getFeature } from '../../features/registry.js'
import {
  defaultSettings,
  requiresChannel,
  type FeatureDescriptor,
  type FeatureSettings,
  type SettingField,
} from '../../features/types.js'
import type { Command } from '../command.js'
import { errorEmbed, noticeEmbed } from '../embeds.js'

const FEATURE_CHOICES = FEATURES.map((f) => ({ name: f.name, value: f.id }))

/**
 * Settings listed before the rest are summarised away.
 *
 * A monitor feature carries around twenty, most of them the shared quality
 * gates, and printing all of them turns help into a wall nobody reads - the
 * dashboard is the place to go through them one by one. The ones a feature
 * declares *first* are its own, because the shared gates are appended last by
 * `monitorGateFields`, so taking from the top shows what makes the feature
 * itself rather than what it has in common with the other six.
 */
const SETTINGS_SHOWN = 8

const KIND_LABEL: Record<FeatureDescriptor['kind'], string> = {
  push: 'posts on its own',
  command: 'answers slash commands',
  listener: 'reacts to messages in the channel',
}

export const helpCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('What this bot does, and how to use any part of it')
    .addStringOption((opt) =>
      opt
        .setName('feature')
        .setDescription('Get the detail on one feature instead of the overview')
        .setRequired(false)
        .addChoices(...FEATURE_CHOICES),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const featureId = interaction.options.getString('feature')

    // Resolved once, for both views. In a DM there is no guild to resolve
    // against, so the reply talks about defaults and says so rather than
    // implying a channel's configuration it cannot see.
    const resolved = interaction.inGuild()
      ? await resolveAllFeatures(interaction.guildId, interaction.channelId)
      : undefined

    if (featureId) {
      const feature = getFeature(featureId)
      if (!feature) {
        await interaction.reply({
          embeds: [errorEmbed('That feature is not available on this bot version.')],
          flags: MessageFlags.Ephemeral,
        })
        return
      }

      await interaction.reply({
        embeds: [featureEmbed(feature, resolved?.find((r) => r.feature.id === featureId))],
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    await interaction.reply({
      embeds: [overviewEmbed(resolved)],
      flags: MessageFlags.Ephemeral,
    })
  },
}

/** The whole bot, one line per feature, grouped by what makes each one speak. */
export function overviewEmbed(resolved: ResolvedFeature[] | undefined) {
  const byId = new Map((resolved ?? []).map((r) => [r.feature.id, r]))

  const group = (kind: FeatureDescriptor['kind']): string[] =>
    FEATURES.filter((f) => f.kind === kind).map((f) => {
      const state = byId.get(f.id)
      const mark = state === undefined ? '·' : state.enabled ? '🟢' : '⚪'
      return `${mark} ${f.icon} **${f.name}** — ${f.description}`
    })

  return noticeEmbed(
    [
      '**A crypto trading bot for this server.** Every feature is switched on per *channel*, so the same one can run with strict rules in one place and loose rules in another.',
      '',
      '**Ask it something**',
      ...group('command'),
      '',
      '**Watches the channel**',
      ...group('listener'),
      '',
      '**Posts on its own**',
      ...group('push'),
      '',
      resolved === undefined
        ? '_Run this inside a server to see which of these are switched on there._'
        : '🟢 on in this channel · ⚪ off here',
      '',
      '**Getting anywhere**',
      '• `/help <feature>` — what one of these actually does, and how to use it',
      '• `/feature enable <feature>` — turn one on here (needs Manage Server)',
      '• `/watch add <token>` — put a coin on the watchlist the alert features read',
      config.DASHBOARD_URL
        ? `• [The dashboard](${config.DASHBOARD_URL}) — every threshold, per channel`
        : '• `/feature settings <feature>` — what a feature is set to here',
      '',
      'Automated on-chain data, not financial advice. Memecoins are extremely high risk — verify everything yourself.',
    ]
      .join('\n')
      .slice(0, 4000),
  )
}

/** One feature in full: what it does, how to use it, and how it is set here. */
export function featureEmbed(feature: FeatureDescriptor, state: ResolvedFeature | undefined) {
  const detail = feature.help?.detail ?? [feature.description]
  const seeAlso = feature.help?.seeAlso ?? []

  // A command the feature owns is listed bare unless `seeAlso` already spells
  // out how to use it - "`/alert`" above "`/alert add <token> above <price>`"
  // is the same command twice, with the useless half first.
  const owned = feature.commands
    .filter((name) => !seeAlso.some((line) => line.includes(`\`/${name}`)))
    .map((name) => `• \`/${name}\``)

  const embed = noticeEmbed(
    [
      `${feature.icon} **${feature.name}** — ${KIND_LABEL[feature.kind]}`,
      '',
      ...detail.flatMap((paragraph) => [paragraph, '']),
      status(feature, state),
    ]
      .join('\n')
      .slice(0, 4000),
  )

  if (owned.length > 0 || seeAlso.length > 0) {
    embed.addFields({
      name: 'Commands',
      value: clamp([...owned, ...seeAlso.map((line) => `• ${line}`)].join('\n')),
    })
  }

  embed.addFields({
    name: 'Turning it on',
    value: clamp(
      [
        requiresChannel(feature.kind)
          ? `\`/feature enable ${feature.id} channel:#somewhere\` — this one posts, so it needs a channel`
          : `\`/feature enable ${feature.id}\` — omit the channel for the whole server`,
        'Needs **Manage Server**.',
        feature.help?.firstStep && `Then: ${feature.help.firstStep}`,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  })

  const values = state?.settings ?? defaultSettings(feature)
  const shown = feature.settings.slice(0, SETTINGS_SHOWN)
  const remaining = feature.settings.length - shown.length

  embed.addFields({
    name: state ? `Settings here (${feature.settings.length})` : `Settings (${feature.settings.length})`,
    value: clamp(
      [
        ...shown.map((field) => `• **${field.label}** — ${describe(field, values)}`),
        remaining > 0 && `• …and ${remaining} more`,
        config.DASHBOARD_URL
          ? `Edit them in [the dashboard](${config.DASHBOARD_URL}) or with \`/feature settings ${feature.id}\`.`
          : `See them all with \`/feature settings ${feature.id}\`.`,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  })

  return embed
}

/** Where the feature stands in the channel the command was run in. */
function status(feature: FeatureDescriptor, state: ResolvedFeature | undefined): string {
  if (state === undefined) {
    return `_Run this inside a server to see whether it is switched on there. It is ${feature.defaultEnabled ? 'on' : 'off'} until somebody configures it._`
  }

  if (!state.enabled) {
    return '⚪ **Off in this channel.** Nothing below is happening yet.'
  }

  // A push feature resolved from a guild-wide row is not actually posting
  // anywhere - it needs a channel named on the row - so saying "on" without
  // that distinction would send someone looking for a bug that is a setting.
  const viaChannel = state.instance?.channelId != null
  return requiresChannel(feature.kind) && !viaChannel
    ? '🟡 **Enabled server-wide, but it posts and no channel is set.** Re-run `/feature enable` with a channel.'
    : '🟢 **On in this channel.**'
}

/**
 * One setting as a line of help: what it is, and what it is set to.
 *
 * Values come from the resolved settings so the reader sees this channel's
 * numbers rather than the shipped defaults - the difference between the two is
 * exactly what someone reading help is usually trying to establish.
 */
function describe(field: SettingField, values: FeatureSettings): string {
  const value = values[field.key]
  // Symbols attach to the number, words do not: "1.5x" and "1,440 minutes" are
  // both how a person writes it, "1.5 x" is neither.
  const suffix = 'unit' in field && field.unit ? field.unit : ''
  const unit = suffix === '' ? '' : /^[a-z]/i.test(suffix) && suffix.length > 1 ? ` ${suffix}` : suffix

  if (field.type === 'select') {
    const chosen = field.options.find((o) => o.value === value)
    return chosen?.label ?? String(value ?? field.default)
  }

  if (field.type === 'multiselect') {
    const list = Array.isArray(value) ? (value as string[]) : []
    if (list.length === 0) return field.emptyMeansAll ? 'all' : 'none'
    return list
      .map((v) => field.options.find((o) => o.value === v)?.label ?? v)
      .join(', ')
  }

  if (field.type === 'bands') {
    return `${Array.isArray(value) ? value.length : 0} bands by size`
  }

  if (field.type === 'boolean') return value === true ? 'on' : 'off'

  if (field.type === 'number') {
    const n = typeof value === 'number' ? value : field.default
    return `${n.toLocaleString()}${unit}`
  }

  const text = typeof value === 'string' ? value : ''
  return text.length > 0 ? text : 'not set'
}

/** Embed fields cap at 1024 characters, and a truncated field is not an error. */
function clamp(value: string): string {
  return value.length > 1024 ? `${value.slice(0, 1021)}...` : value
}
