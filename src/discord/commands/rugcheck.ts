import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js'
import { config } from '../../config.js'
import { checkRugSignature } from '../../risk/rugSignature.js'
import type { Command } from '../command.js'
import { errorEmbed, rugCheckResultEmbed } from '../embeds.js'

/**
 * Same base58 shape used to spot addresses in free text (token-extract.ts) -
 * checked here so a typo'd input fails instantly rather than spending a
 * ~1-minute RPC-heavy check to find out the mint doesn't exist.
 */
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

/**
 * On-demand rug-signature check (docs/11-RUG-SIGNATURE.md) for one Solana
 * mint, posted in the calling channel. Solana/pump.fun only, matching the
 * automatic check the launch scanner runs - this is the same
 * `checkRugSignature`, so a mint it already checked (automatically or by a
 * previous `/rugcheck`) returns the cached verdict instantly instead of
 * spending RPC budget again.
 *
 * Deliberately ungated and open to anyone - it costs shared RPC budget, but
 * that budget is already protected bot-wide by `solanaRpcLimiter`, the same
 * as every other caller.
 */
export const rugcheckCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('rugcheck')
    .setDescription('Run the rug-signature check against a Solana pump.fun token')
    .addStringOption((opt) =>
      opt
        .setName('token')
        .setDescription('Solana token contract address (mint)')
        .setRequired(true)
        .setMaxLength(44),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!config.ENABLE_RUG_SIGNATURE_CHECK) {
      await interaction.reply({
        embeds: [errorEmbed('The rug-signature check is turned off on this deployment right now.')],
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    const mint = interaction.options.getString('token', true).trim()

    if (!SOLANA_ADDRESS_RE.test(mint)) {
      await interaction.reply({
        embeds: [errorEmbed('That does not look like a Solana contract address.')],
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    await interaction.deferReply()

    const result = await checkRugSignature(mint)

    await interaction.editReply({
      content: `<@${interaction.user.id}> requested this check.`,
      embeds: [rugCheckResultEmbed(mint, result)],
    })
  },
}
