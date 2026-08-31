import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js'
import { MARKET_LOOKUP } from '../../features/registry.js'
import { CHAIN_CHOICES } from '../../market/chains.js'
import { resolveToken, TokenNotFoundError } from '../../market/resolve.js'
import { assessToken } from '../../risk/assess.js'
import type { Command } from '../command.js'
import { errorEmbed, riskEmbed } from '../embeds.js'
import { chainAllowed, chainRejectionMessage, gate } from '../gate.js'

export const scanCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('scan')
    .setDescription('Run a rug/risk check on a token (RugCheck for Solana, GoPlus for EVM)')
    .addStringOption((opt) =>
      opt
        .setName('token')
        .setDescription('Symbol (e.g. WIF) or contract address')
        .setRequired(true)
        .setMaxLength(64),
    )
    .addStringOption((opt) =>
      opt
        .setName('chain')
        .setDescription('Restrict to one chain (defaults to the deepest-liquidity match)')
        .setRequired(false)
        .addChoices(...CHAIN_CHOICES),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const resolved = await gate(interaction, MARKET_LOOKUP.id)
    if (!resolved) return

    const query = interaction.options.getString('token', true)
    const chain = interaction.options.getString('chain') ?? undefined

    if (chain && !chainAllowed(resolved, chain)) {
      await interaction.reply({
        embeds: [errorEmbed(chainRejectionMessage(resolved, chain))],
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    const ephemeral = resolved.read.bool('ephemeral')
    await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {})

    try {
      const { pair, bySymbol, verified } = await resolveToken(query, chain)

      if (!chainAllowed(resolved, pair.chainId)) {
        await interaction.editReply({ embeds: [errorEmbed(chainRejectionMessage(resolved, pair.chainId))] })
        return
      }

      const report = await assessToken(pair)
      const embed = riskEmbed(pair, report)

      if (bySymbol && !verified && resolved.read.bool('warnUnverified', true)) {
        embed.addFields({
          name: '⚠️ Matched by ticker',
          value: `This token was matched by ticker, not verified. Confirm the address is the one you meant: \`${pair.baseToken.address}\``,
        })
      }

      await interaction.editReply({ embeds: [embed] })
    } catch (err) {
      const message =
        err instanceof TokenNotFoundError
          ? err.message
          : 'Could not complete the scan. Try again in a moment.'
      await interaction.editReply({ embeds: [errorEmbed(message)] })
      if (!(err instanceof TokenNotFoundError)) throw err
    }
  },
}
