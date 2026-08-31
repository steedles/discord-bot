import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js'
import { getCollections } from '../../db/mongo.js'
import type { TrackedWallet } from '../../db/models.js'
import type { Command } from '../command.js'
import { errorEmbed, trackedWalletEmbed } from '../embeds.js'

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

const EVM_CHOICES = [
  { name: 'Ethereum', value: 'ethereum' },
  { name: 'BSC', value: 'bsc' },
  { name: 'Base', value: 'base' },
  { name: 'Robinhood Chain', value: 'robinhood' },
]

/**
 * Tracked Wallets lookup, read-only against an imported list (see
 * `pnpm import:wallets` / `src/scripts/import-tracked-wallets.ts`). No chain
 * option is required: a Solana address only ever matches one row, but the
 * same EVM address can be tracked under several EVM chains at once (it is
 * the same account everywhere, see HOLDINGS_EVM_WALLET's own comment in
 * config.ts) - so an omitted chain searches every chain and returns every
 * match, rather than guessing which one the caller meant.
 */
export const walletCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('wallet')
    .setDescription("Look up a wallet's Tracked Wallets entry (Solana or EVM)")
    .addStringOption((opt) =>
      opt.setName('address').setDescription('Wallet address').setRequired(true).setMaxLength(64),
    )
    .addStringOption((opt) =>
      opt
        .setName('chain')
        .setDescription('Only for an EVM address tracked on more than one chain - omit to check all')
        .setRequired(false)
        .addChoices(...EVM_CHOICES),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const raw = interaction.options.getString('address', true).trim()
    // Safe to narrow: the option only ever carries one of EVM_CHOICES' values.
    const chain = interaction.options.getString('chain') as TrackedWallet['chainId'] | null

    const isEvm = EVM_ADDRESS_RE.test(raw)
    if (!isEvm && !SOLANA_ADDRESS_RE.test(raw)) {
      await interaction.reply({ embeds: [errorEmbed('That does not look like a Solana or EVM wallet address.')] })
      return
    }

    // Lowercased for EVM only - Solana base58 is case-sensitive, EVM checksummed
    // casing is not, and the import script stores EVM addresses lowercased for
    // exactly this reason (see CLAUDE.md: "Solana pool addresses are
    // case-sensitive").
    const wallet = isEvm ? raw.toLowerCase() : raw

    await interaction.deferReply()

    const { trackedWallets } = getCollections()
    const rows = await trackedWallets
      .find(chain ? { wallet, chainId: chain } : { wallet })
      .toArray()

    if (rows.length === 0) {
      await interaction.editReply({ embeds: [trackedWalletEmbed(wallet, null)] })
      return
    }

    await interaction.editReply({ embeds: rows.slice(0, 10).map((row) => trackedWalletEmbed(wallet, row)) })
  },
}
