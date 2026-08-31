import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js'
import { MARKET_LOOKUP } from '../../features/registry.js'
import { CHAIN_CHOICES } from '../../market/chains.js'
import { formatCompactUsd, truncateAddress } from '../../market/format.js'
import { resolveToken, TokenNotFoundError } from '../../market/resolve.js'
import { LEVEL_EMOJI } from '../../risk/index.js'
import { assessToken } from '../../risk/assess.js'
import type { Command } from '../command.js'
import { errorEmbed, priceEmbed } from '../embeds.js'
import { chainAllowed, chainRejectionMessage, gate } from '../gate.js'

export const priceCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('price')
    .setDescription('Look up the live price of a token by symbol or contract address')
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
      const { pair, alternatives, bySymbol, verified } = await resolveToken(query, chain)

      if (!chainAllowed(resolved, pair.chainId)) {
        await interaction.editReply({ embeds: [errorEmbed(chainRejectionMessage(resolved, pair.chainId))] })
        return
      }

      const embed = priceEmbed(pair)

      if (resolved.read.bool('showRiskOnPrice')) {
        const report = await assessToken(pair)
        embed.addFields({
          name: 'Risk',
          value:
            report.level === 'unknown'
              ? `${LEVEL_EMOJI.unknown} Unknown — ${report.note ?? 'no data'}`
              : `${LEVEL_EMOJI[report.level]} ${report.level} (${report.score}/100)` +
                (report.flags.length > 0 ? ` · ${report.flags.slice(0, 3).map((f) => f.label).join(', ')}` : ''),
        })
      }

      if (bySymbol && !verified && resolved.read.bool('warnUnverified', true)) {
        embed.addFields({
          name: '⚠️ Matched by ticker',
          value: [
            'Tickers are not unique and this one is not in the verified list, so this may not be the token you meant.',
            `Check the address: \`${pair.baseToken.address}\``,
            ...alternatives.map(
              (m) =>
                `Also matched: ${m.symbol} · ${m.chainId} · ${formatCompactUsd(m.liquidityUsd)} liq · \`${truncateAddress(m.address)}\``,
            ),
          ].join('\n'),
        })
      }

      await interaction.editReply({ embeds: [embed] })
    } catch (err) {
      const message =
        err instanceof TokenNotFoundError
          ? err.message
          : 'Could not reach the price feed. Try again in a moment.'
      await interaction.editReply({ embeds: [errorEmbed(message)] })
      if (!(err instanceof TokenNotFoundError)) throw err
    }
  },
}
