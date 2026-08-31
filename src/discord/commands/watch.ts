import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js'
import { config } from '../../config.js'
import { CHAIN_CHOICES, getChain } from '../../market/chains.js'
import { formatCompactUsd, formatUsdPrice } from '../../market/format.js'
import { resolveToken, TokenNotFoundError } from '../../market/resolve.js'
import { fetchSnapshots } from '../../monitor/providers/dexscreener-source.js'
import { addToken, countTokens, listAll, removeToken } from '../../monitor/watchlist.js'
import type { Command } from '../command.js'
import { errorEmbed, noticeEmbed, successEmbed } from '../embeds.js'

/**
 * Watchlist management.
 *
 * Deliberately **not** gated through `gate()`. The watchlist is one shared,
 * capped, bot-wide resource that feeds all three monitor features at once, so
 * tying it to any single feature's per-channel switch would mean turning off
 * volume spikes in one channel stopped anyone managing the tokens whale alerts
 * depend on. It is guarded by a Discord permission instead: adding to a capped
 * list that costs API budget is an admin action, while reading it is not.
 */
export const watchCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('watch')
    .setDescription('Manage the tokens the volume monitor polls')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Watch a token for volume spikes, whale buys and momentum')
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
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Stop watching a token')
        .addStringOption((opt) =>
          opt.setName('token').setDescription('Which token').setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Show the watchlist')),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        embeds: [errorEmbed('The watchlist is managed inside a server, not in DMs.')],
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    const sub = interaction.options.getSubcommand()
    if (sub === 'list') return listWatched(interaction)

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            'You need **Manage Server** to change the watchlist.\nIt is capped and shared by every monitor channel, so one person filling it stops everyone else adding to it.',
          ),
        ],
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    return sub === 'add' ? addWatched(interaction) : removeWatched(interaction)
  },

  async autocomplete(interaction: AutocompleteInteraction) {
    if (!interaction.inGuild()) return await interaction.respond([])

    const focused = interaction.options.getFocused().toLowerCase()
    const all = await listAll()

    const choices = all
      .map((t) => ({
        name: `${t.symbol} (${getChain(t.chainId)?.label ?? t.chainId})${t.source === 'discovered' ? ' · auto' : ''}`.slice(0, 100),
        value: `${t.chainId}:${t.tokenAddress}`,
      }))
      .filter((c) => c.name.toLowerCase().includes(focused))

    await interaction.respond(choices.slice(0, 25))
  },
}

async function addWatched(interaction: ChatInputCommandInteraction): Promise<void> {
  const query = interaction.options.getString('token', true)
  const chain = interaction.options.getString('chain') ?? undefined

  await interaction.deferReply()

  let pair
  let verified = false
  try {
    ;({ pair, verified } = await resolveToken(query, chain))
  } catch (err) {
    const message =
      err instanceof TokenNotFoundError ? err.message : 'Could not reach the price feed. Try again shortly.'
    await interaction.editReply({ embeds: [errorEmbed(message)] })
    if (!(err instanceof TokenNotFoundError)) throw err
    return
  }

  // Re-read through the monitor's own market source so the stored pair address
  // is the pool it will actually poll, not the one used to price the lookup.
  const [snapshot] = await fetchSnapshots(pair.chainId, [
    {
      chainId: pair.chainId,
      tokenAddress: pair.baseToken.address,
      pairAddress: pair.pairAddress,
      symbol: pair.baseToken.symbol,
    },
  ])

  if (!snapshot) {
    await interaction.editReply({
      embeds: [errorEmbed(`No usable pool data came back for ${pair.baseToken.symbol}.`)],
    })
    return
  }

  const result = await addToken(snapshot, interaction.user.id, interaction.guildId!)

  if (!result.ok) {
    await interaction.editReply({ embeds: [errorEmbed(result.reason ?? 'Could not add that token.')] })
    return
  }

  const total = await countTokens()
  const chainLabel = getChain(snapshot.chainId)?.label ?? snapshot.chainId

  await interaction.editReply({
    embeds: [
      successEmbed(
        [
          result.existing
            ? `**${snapshot.symbol}** is already on the watchlist.`
            : `Watching **${snapshot.symbol}** on ${chainLabel} at ${formatUsdPrice(snapshot.priceUsd)}.`,
          '',
          `Liquidity ${formatCompactUsd(snapshot.liquidityUsd)} · 24h volume ${formatCompactUsd(snapshot.volume.h24)}`,
          `Watchlist is now ${total}/${config.MONITOR_MAX_TOKENS} tokens.`,
          '',
          // Tickers are not unique. Bind the eye to the exact contract.
          `Watching \`${snapshot.tokenAddress}\``,
          verified ? '' : '⚠️ Matched by ticker, not verified. Check that address is the token you meant.',
          '',
          'Momentum alerts need a run of recorded readings, so they cannot fire for this token until it has been watched for a while.',
        ]
          .filter(Boolean)
          .join('\n'),
      ),
    ],
  })
}

async function removeWatched(interaction: ChatInputCommandInteraction): Promise<void> {
  const value = interaction.options.getString('token', true)
  const separator = value.indexOf(':')

  if (separator < 1) {
    await interaction.reply({
      embeds: [errorEmbed('Pick a token from the dropdown rather than typing one.')],
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const chainId = value.slice(0, separator)
  const tokenAddress = value.slice(separator + 1)
  const removed = await removeToken(chainId, tokenAddress)

  await interaction.reply({
    embeds: [
      removed
        ? successEmbed('Removed that token from the watchlist.')
        : errorEmbed('That token is not on the watchlist.'),
    ],
    flags: MessageFlags.Ephemeral,
  })
}

async function listWatched(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const all = await listAll()

  if (all.length === 0) {
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          'The watchlist is empty, so the monitor has nothing to poll.\nAdd a token with `/watch add`, or let auto-discovery fill it from the boosted-listing feed.',
        ),
      ],
    })
    return
  }

  const lines = all.map((t, i) => {
    const chainLabel = getChain(t.chainId)?.label ?? t.chainId
    const tags: string[] = []
    if (t.source === 'discovered') tags.push('auto')
    if (t.errorCount > 0) tags.push(`${t.errorCount} failed polls`)
    const suffix = tags.length > 0 ? ` — _${tags.join(', ')}_` : ''
    return `**${i + 1}.** ${t.symbol} (${chainLabel})${suffix}`
  })

  await interaction.editReply({
    embeds: [
      noticeEmbed(
        [
          `**Watchlist (${all.length}/${config.MONITOR_MAX_TOKENS})**`,
          '',
          ...lines,
          '',
          '_auto_ entries came from discovery and expire within 24 hours unless re-found.',
        ]
          .join('\n')
          .slice(0, 4000),
      ),
    ],
  })
}
