import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js'
import { config } from '../../config.js'
import { listInstances, resolveFeature, upsertInstance } from '../../db/features.js'
import { FEATURES, getFeature } from '../../features/registry.js'
import { requiresChannel } from '../../features/types.js'
import type { FeatureDescriptor, SettingField, SettingValue } from '../../features/types.js'
import type { Command } from '../command.js'
import { errorEmbed, noticeEmbed, successEmbed } from '../embeds.js'

const FEATURE_CHOICES = FEATURES.map((f) => ({ name: f.name, value: f.id }))

/**
 * Generic feature switchboard. It is built from the registry, so a new feature
 * appears here automatically. Detailed settings live on the dashboard - this
 * command covers the on/off and where questions that come up mid-conversation.
 */
export const featureCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('feature')
    .setDescription('Turn bot features on or off per channel (server admins)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub.setName('list').setDescription('Show every feature and where it is switched on'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('enable')
        .setDescription('Turn a feature on')
        .addStringOption((opt) =>
          opt.setName('feature').setDescription('Which feature').setRequired(true).addChoices(...FEATURE_CHOICES),
        )
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Which channel. Omit for server-wide (command features only).')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('disable')
        .setDescription('Turn a feature off')
        .addStringOption((opt) =>
          opt.setName('feature').setDescription('Which feature').setRequired(true).addChoices(...FEATURE_CHOICES),
        )
        .addChannelOption((opt) =>
          opt
            .setName('channel')
            .setDescription('Which channel. Omit for server-wide.')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('settings')
        .setDescription('Show a feature\'s current settings here')
        .addStringOption((opt) =>
          opt.setName('feature').setDescription('Which feature').setRequired(true).addChoices(...FEATURE_CHOICES),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('dashboard').setDescription('Get the link to the settings dashboard'),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        embeds: [errorEmbed('Features are configured per server, so run this inside your server.')],
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    switch (interaction.options.getSubcommand()) {
      case 'list':
        return listFeatures(interaction)
      case 'enable':
        return setEnabled(interaction, true)
      case 'disable':
        return setEnabled(interaction, false)
      case 'settings':
        return showSettings(interaction)
      case 'dashboard':
        return showDashboard(interaction)
    }
  },
}

async function listFeatures(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const instances = await listInstances(interaction.guildId!)
  const blocks: string[] = []

  for (const feature of FEATURES) {
    const rows = instances.filter((i) => i.featureId === feature.id)
    const lines: string[] = []

    const guildRow = rows.find((r) => r.channelId === null)
    if (guildRow) {
      lines.push(`  server-wide: ${guildRow.enabled ? '🟢 on' : '⚪ off'}`)
    } else if (!requiresChannel(feature.kind)) {
      lines.push(`  server-wide: ${feature.defaultEnabled ? '🟢 on (default)' : '⚪ off (default)'}`)
    }

    for (const row of rows.filter((r) => r.channelId !== null)) {
      const label = row.label ? ` — ${row.label}` : ''
      lines.push(`  <#${row.channelId}>: ${row.enabled ? '🟢 on' : '⚪ off'}${label}`)
    }

    if (lines.length === 0) lines.push('  not configured')

    blocks.push(`${feature.icon} **${feature.name}**\n${lines.join('\n')}`)
  }

  await interaction.editReply({
    embeds: [
      noticeEmbed(
        [...blocks, '', `Full settings: ${dashboardLink()}`].join('\n\n').slice(0, 4000),
      ),
    ],
  })
}

async function setEnabled(interaction: ChatInputCommandInteraction, enabled: boolean): Promise<void> {
  const featureId = interaction.options.getString('feature', true)
  const channel = interaction.options.getChannel('channel')

  const feature = getFeature(featureId)
  if (!feature) {
    await interaction.reply({ embeds: [errorEmbed('Unknown feature.')], flags: MessageFlags.Ephemeral })
    return
  }

  if (requiresChannel(feature.kind) && !channel) {
    await interaction.reply({
      embeds: [
        errorEmbed(
          `${feature.name} posts on its own, so it needs somewhere to post. Run the command again and fill in the **channel** option.`,
        ),
      ],
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const result = await upsertInstance({
    guildId: interaction.guildId!,
    featureId,
    channelId: channel?.id ?? null,
    enabled,
    updatedBy: interaction.user.id,
  })

  if (!result.ok) {
    await interaction.editReply({ embeds: [errorEmbed(result.errors.join('\n'))] })
    return
  }

  const where = channel ? `<#${channel.id}>` : 'server-wide'
  await interaction.editReply({
    embeds: [
      successEmbed(
        [
          `**${feature.name}** is now ${enabled ? '🟢 on' : '⚪ off'} ${where}.`,
          '',
          `Tune its settings at ${dashboardLink()}`,
        ].join('\n'),
      ),
    ],
  })
}

async function showSettings(interaction: ChatInputCommandInteraction): Promise<void> {
  const featureId = interaction.options.getString('feature', true)
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const resolved = await resolveFeature(featureId, interaction.guildId!, interaction.channelId)
  if (!resolved) {
    await interaction.editReply({ embeds: [errorEmbed('Unknown feature.')] })
    return
  }

  const source = resolved.instance
    ? resolved.instance.channelId
      ? `this channel's own settings`
      : 'the server-wide settings'
    : 'built-in defaults (never configured)'

  const lines = resolved.feature.settings.map(
    (field) => `**${field.label}:** ${formatValue(field, resolved.settings[field.key])}`,
  )

  await interaction.editReply({
    embeds: [
      noticeEmbed(
        [
          `${resolved.feature.icon} **${resolved.feature.name}** in <#${interaction.channelId}>`,
          `Status: ${resolved.enabled ? '🟢 on' : '⚪ off'} · using ${source}`,
          '',
          ...lines,
          '',
          `Edit at ${dashboardLink()}`,
        ].join('\n').slice(0, 4000),
      ),
    ],
  })
}

async function showDashboard(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({
    embeds: [
      noticeEmbed(
        config.DASHBOARD_URL
          ? `**Settings dashboard**\n${config.DASHBOARD_URL}\n\nSign in with Discord. You will see every server where you have Manage Server.`
          : 'No dashboard URL is configured. Set `DASHBOARD_URL` in the bot environment.',
      ),
    ],
    flags: MessageFlags.Ephemeral,
  })
}

function dashboardLink(): string {
  return config.DASHBOARD_URL || 'the dashboard (DASHBOARD_URL not set)'
}

function formatValue(field: SettingField, value: SettingValue | undefined): string {
  if (value === undefined) return '_unset_'

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return field.type === 'multiselect' && field.emptyMeansAll ? '_all_' : '_none_'
    }
    const labels = value.map((v) => {
      // Role ids are unreadable, and this reply is an embed - Discord renders a
      // role mention inside one as its name and colour without pinging anybody.
      if (field.type === 'roles') return `<@&${v}>`
      return field.type === 'multiselect' ? (field.options.find((o) => o.value === v)?.label ?? v) : v
    })
    return labels.join(', ')
  }

  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (value === '') return '_empty_'

  if (field.type === 'number' && field.unit === 'USD') {
    return `$${value.toLocaleString('en-US')}`
  }
  if (field.type === 'number' && field.unit) return `${value} ${field.unit}`

  return String(value)
}

export function describeFeature(feature: FeatureDescriptor): string {
  return `${feature.icon} ${feature.name} — ${feature.description}`
}
