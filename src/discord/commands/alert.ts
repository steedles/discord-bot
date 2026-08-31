import { ObjectId } from 'mongodb'
import {
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js'
import type { Alert } from '../../db/models.js'
import { getCollections } from '../../db/mongo.js'
import { PRICE_ALERTS } from '../../features/registry.js'
import { CHAIN_CHOICES, getChain } from '../../market/chains.js'
import { formatCompactUsd, formatUsdPrice, parseAmount } from '../../market/format.js'
import { resolveToken, TokenNotFoundError } from '../../market/resolve.js'
import type { Command } from '../command.js'
import { errorEmbed, noticeEmbed, successEmbed } from '../embeds.js'
import { chainAllowed, chainRejectionMessage, gate } from '../gate.js'

export const alertCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('alert')
    .setDescription('Price alerts - get pinged when a token crosses your target')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Create a price alert')
        .addStringOption((opt) =>
          opt
            .setName('token')
            .setDescription('Symbol (e.g. WIF) or contract address')
            .setRequired(true)
            .setMaxLength(64),
        )
        .addStringOption((opt) =>
          opt
            .setName('direction')
            .setDescription('Fire when price goes above or below the target')
            .setRequired(true)
            .addChoices({ name: 'above', value: 'above' }, { name: 'below', value: 'below' }),
        )
        .addStringOption((opt) =>
          opt
            .setName('price')
            .setDescription('Target price in USD. Accepts 0.0042, 1.5k, 2m')
            .setRequired(true)
            .setMaxLength(24),
        )
        .addStringOption((opt) =>
          opt
            .setName('chain')
            .setDescription('Restrict to one chain (defaults to the deepest-liquidity match)')
            .setRequired(false)
            .addChoices(...CHAIN_CHOICES),
        )
        .addBooleanOption((opt) =>
          opt
            .setName('repeat')
            .setDescription('Keep the alert active after it fires (default: false)')
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('Show your active alerts'))
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Delete one of your alerts')
        .addStringOption((opt) =>
          opt
            .setName('alert')
            .setDescription('Which alert to delete')
            .setRequired(true)
            .setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) => sub.setName('clear').setDescription('Delete all of your alerts in this server')),

  async execute(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand()

    // Listing and deleting your own alerts stays available even where the
    // feature is off, so nobody is locked out of alerts they already own.
    if (sub === 'list') return listAlerts(interaction)
    if (sub === 'remove') return removeAlert(interaction)
    if (sub === 'clear') return clearAlerts(interaction)

    const resolved = await gate(interaction, PRICE_ALERTS.id)
    if (!resolved) return

    return addAlert(interaction, resolved)
  },

  async autocomplete(interaction: AutocompleteInteraction) {
    if (!interaction.inGuild()) return await interaction.respond([])

    const { alerts } = getCollections()
    const focused = interaction.options.getFocused().toLowerCase()

    const mine = await alerts
      .find({ guildId: interaction.guildId, userId: interaction.user.id, active: true })
      .sort({ createdAt: -1 })
      .limit(25)
      .toArray()

    const choices = mine
      .map((a) => ({
        name: `${a.symbol} ${a.direction} ${formatUsdPrice(a.target)} (${getChain(a.chainId)?.label ?? a.chainId})`.slice(0, 100),
        value: a._id!.toHexString(),
      }))
      .filter((c) => c.name.toLowerCase().includes(focused))

    await interaction.respond(choices.slice(0, 25))
  },
}

type Resolved = NonNullable<Awaited<ReturnType<typeof gate>>>

async function addAlert(interaction: ChatInputCommandInteraction, resolved: Resolved): Promise<void> {
  const query = interaction.options.getString('token', true)
  const direction = interaction.options.getString('direction', true) as 'above' | 'below'
  const rawPrice = interaction.options.getString('price', true)
  const chain = interaction.options.getString('chain') ?? undefined
  const requestedRepeat = interaction.options.getBoolean('repeat') ?? false

  const target = parseAmount(rawPrice)
  if (target === undefined) {
    await interaction.reply({
      embeds: [errorEmbed(`"${rawPrice}" is not a valid price. Try \`0.0042\`, \`1.5k\` or \`250\`.`)],
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  if (requestedRepeat && !resolved.read.bool('allowRepeat', true)) {
    await interaction.reply({
      embeds: [errorEmbed('Repeating alerts are switched off in this channel.')],
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  if (chain && !chainAllowed(resolved, chain)) {
    await interaction.reply({
      embeds: [errorEmbed(chainRejectionMessage(resolved, chain))],
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await interaction.deferReply()

  const { alerts } = getCollections()
  const maxAlerts = resolved.read.num('maxAlertsPerUser', 25)

  const existing = await alerts.countDocuments({
    guildId: interaction.guildId!,
    userId: interaction.user.id,
    active: true,
  })
  if (existing >= maxAlerts) {
    await interaction.editReply({
      embeds: [errorEmbed(`You already have ${maxAlerts} active alerts. Remove one with \`/alert remove\`.`)],
    })
    return
  }

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

  if (!chainAllowed(resolved, pair.chainId)) {
    await interaction.editReply({ embeds: [errorEmbed(chainRejectionMessage(resolved, pair.chainId))] })
    return
  }

  if (!verified && resolved.read.bool('requireVerifiedToken')) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          'This channel only allows alerts on verified tokens, and that ticker was matched by guess.\nPaste the contract address instead - that is always exact.',
        ),
      ],
    })
    return
  }

  const minLiquidity = resolved.read.num('minLiquidityUsd', 0)
  const liquidity = pair.liquidity?.usd ?? 0
  if (minLiquidity > 0 && liquidity < minLiquidity) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          `${pair.baseToken.symbol} has ${formatCompactUsd(liquidity)} liquidity, below this channel's ${formatCompactUsd(minLiquidity)} minimum.`,
        ),
      ],
    })
    return
  }

  const current = pair.priceUsd ? Number(pair.priceUsd) : undefined
  if (current === undefined || !Number.isFinite(current)) {
    await interaction.editReply({
      embeds: [errorEmbed(`No USD price available for ${pair.baseToken.symbol} right now.`)],
    })
    return
  }

  // An alert that is already true would fire on the next poll, which is noise.
  const alreadyTrue = direction === 'above' ? current >= target : current <= target
  if (alreadyTrue) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          `${pair.baseToken.symbol} is already ${direction} ${formatUsdPrice(target)} (now ${formatUsdPrice(current)}). Pick a target on the other side of the current price.`,
        ),
      ],
    })
    return
  }

  const alert: Alert = {
    guildId: interaction.guildId!,
    userId: interaction.user.id,
    channelId: interaction.channelId,
    chainId: pair.chainId,
    tokenAddress: pair.baseToken.address,
    pairAddress: pair.pairAddress,
    symbol: pair.baseToken.symbol,
    direction,
    target,
    priceAtCreate: current,
    repeat: requestedRepeat,
    active: true,
    armed: true,
    createdAt: new Date(),
    triggerCount: 0,
    errorCount: 0,
  }

  await alerts.insertOne(alert)

  await interaction.editReply({
    embeds: [
      successEmbed(
        [
          `Alert set: **${pair.baseToken.symbol}** ${direction} **${formatUsdPrice(target)}**`,
          `Now ${formatUsdPrice(current)} on ${getChain(pair.chainId)?.label ?? pair.chainId}.`,
          requestedRepeat ? 'It will stay active after firing.' : 'It clears itself after firing once.',
          '',
          // Tickers are not unique. The alert is bound to this exact contract,
          // so show it - a member watching an impostor would never find out.
          `Watching \`${pair.baseToken.address}\``,
          verified ? '' : '⚠️ Matched by ticker, not verified. Check that address is the token you meant.',
        ]
          .filter(Boolean)
          .join('\n'),
      ),
    ],
  })
}

async function listAlerts(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({
      embeds: [errorEmbed('Alerts live per server, so run this inside your server.')],
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const { alerts } = getCollections()
  const mine = await alerts
    .find({ guildId: interaction.guildId, userId: interaction.user.id, active: true })
    .sort({ createdAt: -1 })
    .toArray()

  if (mine.length === 0) {
    await interaction.editReply({ embeds: [noticeEmbed('No active alerts. Create one with `/alert add`.')] })
    return
  }

  const lines = mine.map((a, i) => {
    const chainLabel = getChain(a.chainId)?.label ?? a.chainId
    const repeat = a.repeat ? ' · repeats' : ''
    return `**${i + 1}.** ${a.symbol} ${a.direction} ${formatUsdPrice(a.target)} — ${chainLabel}${repeat} — <#${a.channelId}>`
  })

  await interaction.editReply({
    embeds: [noticeEmbed([`**Your alerts (${mine.length})**`, '', ...lines].join('\n').slice(0, 4000))],
  })
}

async function removeAlert(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({
      embeds: [errorEmbed('Alerts live per server, so run this inside your server.')],
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const id = interaction.options.getString('alert', true)

  if (!ObjectId.isValid(id)) {
    await interaction.reply({
      embeds: [errorEmbed('Pick an alert from the dropdown rather than typing an id.')],
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const { alerts } = getCollections()
  const result = await alerts.deleteOne({
    _id: new ObjectId(id),
    guildId: interaction.guildId,
    userId: interaction.user.id,
  })

  await interaction.reply({
    embeds: [
      result.deletedCount === 1
        ? successEmbed('Alert deleted.')
        : errorEmbed('That alert no longer exists, or it is not yours.'),
    ],
    flags: MessageFlags.Ephemeral,
  })
}

async function clearAlerts(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({
      embeds: [errorEmbed('Alerts live per server, so run this inside your server.')],
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const { alerts } = getCollections()
  const result = await alerts.deleteMany({
    guildId: interaction.guildId,
    userId: interaction.user.id,
  })

  await interaction.reply({
    embeds: [successEmbed(`Deleted ${result.deletedCount} alert${result.deletedCount === 1 ? '' : 's'}.`)],
    flags: MessageFlags.Ephemeral,
  })
}
