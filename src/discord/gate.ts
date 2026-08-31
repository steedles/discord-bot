import { MessageFlags, type ChatInputCommandInteraction } from 'discord.js'
import { resolveFeature, type ResolvedFeature } from '../db/features.js'
import { getChain } from '../market/chains.js'
import { errorEmbed, noticeEmbed } from './embeds.js'

/**
 * Resolves a feature for the channel a command was run in, and replies on the
 * caller's behalf if it is switched off there.
 *
 * Returns undefined when the command should stop. Every gated command goes
 * through this so "is this feature on here" is answered in exactly one place.
 */
export async function gate(
  interaction: ChatInputCommandInteraction,
  featureId: string,
): Promise<ResolvedFeature | undefined> {
  if (!interaction.inGuild()) {
    await interaction.reply({
      embeds: [errorEmbed('This command only works inside a server, not in DMs.')],
      flags: MessageFlags.Ephemeral,
    })
    return undefined
  }

  const resolved = await resolveFeature(featureId, interaction.guildId, interaction.channelId)

  if (!resolved) {
    await interaction.reply({
      embeds: [errorEmbed('That feature is not available on this bot version.')],
      flags: MessageFlags.Ephemeral,
    })
    return undefined
  }

  if (!resolved.enabled) {
    await interaction.reply({
      embeds: [
        noticeEmbed(
          `**${resolved.feature.name}** is switched off in this channel.\nA server admin can turn it on with \`/feature enable\` or from the dashboard.`,
        ),
      ],
      flags: MessageFlags.Ephemeral,
    })
    return undefined
  }

  return resolved
}

/**
 * Checks a chain against a feature's allowed list.
 * An empty list means every supported chain is allowed.
 */
export function chainAllowed(resolved: ResolvedFeature, chainId: string): boolean {
  const allowed = resolved.read.list('chains')
  return allowed.length === 0 || allowed.includes(chainId)
}

export function chainRejectionMessage(resolved: ResolvedFeature, chainId: string): string {
  const allowed = resolved.read.list('chains')
  const names = allowed.map((c) => getChain(c)?.label ?? c).join(', ')
  return `${getChain(chainId)?.label ?? chainId} is not enabled for ${resolved.feature.name} in this channel.\nAllowed: ${names || 'none'}.`
}
