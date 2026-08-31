import { ObjectId } from 'mongodb'
import {
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js'
import type { CoinTracker } from '../../db/models.js'
import { getCollections } from '../../db/mongo.js'
import { COIN_TRACKER } from '../../features/registry.js'
import { CHAIN_CHOICES, getChain } from '../../market/chains.js'
import { formatCompactUsd, formatUsdPrice } from '../../market/format.js'
import { busiestPair, getPairsForToken } from '../../market/dexscreener.js'
import { CandleRateLimitError, getMinuteCandles, supportsCandles } from '../../market/geckoterminal.js'
import { cadence, MAX_GAP_RATIO, MIN_CANDLES } from '../../analysis/trend.js'
import { resolveToken, TokenNotFoundError } from '../../market/resolve.js'
import type { Command } from '../command.js'
import { errorEmbed, noticeEmbed, successEmbed } from '../embeds.js'
import { chainAllowed, chainRejectionMessage, gate } from '../gate.js'

export const trackCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('track')
    .setDescription('Watch a coin and get pinged when its 1-minute trend turns')
    .addSubcommand((sub) =>
      sub
        .setName('add')
        .setDescription('Start tracking a coin')
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
    .addSubcommand((sub) => sub.setName('list').setDescription('Show the coins you are tracking'))
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Stop tracking a coin')
        .addStringOption((opt) =>
          opt.setName('tracker').setDescription('Which coin').setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('clear').setDescription('Stop tracking every coin you have in this server'),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    const sub = interaction.options.getSubcommand()

    // Listing and removing your own trackers stays available even where the
    // feature is off, so nobody is stuck with pings they cannot cancel.
    if (sub === 'list') return listTrackers(interaction)
    if (sub === 'remove') return removeTracker(interaction)
    if (sub === 'clear') return clearTrackers(interaction)

    const resolved = await gate(interaction, COIN_TRACKER.id)
    if (!resolved) return

    return addTracker(interaction, resolved)
  },

  async autocomplete(interaction: AutocompleteInteraction) {
    if (!interaction.inGuild()) return await interaction.respond([])

    const { coinTrackers } = getCollections()
    const focused = interaction.options.getFocused().toLowerCase()

    const mine = await coinTrackers
      .find({ guildId: interaction.guildId, userId: interaction.user.id, active: true })
      .sort({ createdAt: -1 })
      .limit(25)
      .toArray()

    const choices = mine
      .map((t) => ({
        name: `${t.symbol} (${getChain(t.chainId)?.label ?? t.chainId})`.slice(0, 100),
        value: t._id!.toHexString(),
      }))
      .filter((c) => c.name.toLowerCase().includes(focused))

    await interaction.respond(choices.slice(0, 25))
  },
}

type Resolved = NonNullable<Awaited<ReturnType<typeof gate>>>

async function addTracker(interaction: ChatInputCommandInteraction, resolved: Resolved): Promise<void> {
  const query = interaction.options.getString('token', true)
  const chain = interaction.options.getString('chain') ?? undefined

  if (chain && !chainAllowed(resolved, chain)) {
    await interaction.reply({
      embeds: [errorEmbed(chainRejectionMessage(resolved, chain))],
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await interaction.deferReply()

  const { coinTrackers } = getCollections()
  const maxTrackers = resolved.read.num('maxTrackersPerUser', 5)

  const existing = await coinTrackers.countDocuments({
    guildId: interaction.guildId!,
    userId: interaction.user.id,
    active: true,
  })
  if (existing >= maxTrackers) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          `You are already tracking ${maxTrackers} coins. Drop one with \`/track remove\` first.\nEach tracked coin costs a chart request every minute, which is why there is a cap.`,
        ),
      ],
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

  if (!supportsCandles(pair.chainId)) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          `There is no minute-candle feed for ${getChain(pair.chainId)?.label ?? pair.chainId}, so the trend cannot be read. Nothing to track.`,
        ),
      ],
    })
    return
  }

  const minLiquidity = resolved.read.num('minLiquidityUsd', 10_000)
  const liquidity = pair.liquidity?.usd ?? 0
  if (minLiquidity > 0 && liquidity < minLiquidity) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          `${pair.baseToken.symbol} has ${formatCompactUsd(liquidity)} liquidity, below this channel's ${formatCompactUsd(minLiquidity)} minimum.\nOn a pool that thin the chart is two traders, not a trend.`,
        ),
      ],
    })
    return
  }

  const price = pair.priceUsd ? Number(pair.priceUsd) : undefined
  if (price === undefined || !Number.isFinite(price)) {
    await interaction.editReply({
      embeds: [errorEmbed(`No USD price available for ${pair.baseToken.symbol} right now.`)],
    })
    return
  }

  // The chart comes from the busiest pool, which is often not the deepest one
  // resolveToken picked for pricing. See busiestPair().
  const chartPair =
    busiestPair(await getPairsForToken(pair.baseToken.address), pair.chainId) ?? pair

  // Check the chart is actually readable before promising to watch it. A pool
  // with a handful of candles will silently never signal, and finding that out
  // an hour later is worse than being told now.
  let candles
  try {
    candles = await getMinuteCandles(chartPair.chainId, chartPair.pairAddress)
  } catch (err) {
    if (err instanceof CandleRateLimitError) {
      await interaction.editReply({
        embeds: [
          errorEmbed('The chart feed is rate limited right now. Try again in a minute.'),
        ],
      })
      return
    }
    throw err
  }

  if (candles.length === 0) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          'No candle data came back for this pool - it is probably too new to have a chart yet.',
        ),
      ],
    })
    return
  }

  const tracker: CoinTracker = {
    guildId: interaction.guildId!,
    userId: interaction.user.id,
    channelId: interaction.channelId,
    chainId: pair.chainId,
    tokenAddress: pair.baseToken.address,
    pairAddress: chartPair.pairAddress,
    symbol: pair.baseToken.symbol,
    active: true,
    createdAt: new Date(),
    priceAtCreate: price,
    signalCount: 0,
    errorCount: 0,
  }

  try {
    await coinTrackers.insertOne(tracker)
  } catch (err) {
    // The unique index on (guild, user, chain, pool) means "already tracking".
    if (isDuplicateKey(err)) {
      await coinTrackers.updateOne(
        {
          guildId: tracker.guildId,
          userId: tracker.userId,
          chainId: tracker.chainId,
          pairAddress: tracker.pairAddress,
        },
        { $set: { active: true, channelId: tracker.channelId, errorCount: 0 } },
      )
      await interaction.editReply({
        embeds: [
          successEmbed(
            `Already tracking **${pair.baseToken.symbol}** - reactivated it and pointed it at this channel.`,
          ),
        ],
      })
      return
    }
    throw err
  }

  const warmup = candles.length < MIN_CANDLES
  const density = cadence(candles)
  const sparse = density !== undefined && density.gapRatio > MAX_GAP_RATIO
  const confirmations = resolved.read.num('confirmations', 2)

  await interaction.editReply({
    embeds: [
      successEmbed(
        [
          `Tracking **${pair.baseToken.symbol}** at ${formatUsdPrice(price)} on ${getChain(pair.chainId)?.label ?? pair.chainId}.`,
          '',
          `You will be pinged here when the 1-minute trend turns and **${confirmations} of 3** signals agree (EMA 9/21, MACD, RSI).`,
          warmup
            ? `⏳ Only ${candles.length} candles exist so far. Nothing will fire until there are ${MIN_CANDLES} - the indicators are still converging before that.`
            : sparse
              ? `⚠️ This pool only trades every ${density!.gapRatio.toFixed(1)} minutes or so, so there is no real minute-by-minute trend to read. Nothing will fire until it gets busier.`
              : `The chart has ${candles.length} candles of history, so it is ready now.`,
          '',
          // Tickers are not unique. Bind the eye to the exact contract.
          `Watching \`${pair.baseToken.address}\``,
          verified ? '' : '⚠️ Matched by ticker, not verified. Check that address is the token you meant.',
        ]
          .filter(Boolean)
          .join('\n'),
      ),
    ],
  })
}

async function listTrackers(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({
      embeds: [errorEmbed('Trackers live per server, so run this inside your server.')],
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const { coinTrackers } = getCollections()
  const mine = await coinTrackers
    .find({ guildId: interaction.guildId, userId: interaction.user.id, active: true })
    .sort({ createdAt: -1 })
    .toArray()

  if (mine.length === 0) {
    await interaction.editReply({
      embeds: [noticeEmbed('You are not tracking anything. Start with `/track add`.')],
    })
    return
  }

  const lines = mine.map((t, i) => {
    const chainLabel = getChain(t.chainId)?.label ?? t.chainId
    const last = t.lastDirection
      ? ` — last turn ${t.lastDirection === 'up' ? '📈 up' : '📉 down'} <t:${Math.floor((t.lastSignalAt ?? t.createdAt).getTime() / 1000)}:R>`
      : ' — no turn reported yet'
    return `**${i + 1}.** ${t.symbol} (${chainLabel}) — <#${t.channelId}>${last}`
  })

  await interaction.editReply({
    embeds: [noticeEmbed([`**Tracking (${mine.length})**`, '', ...lines].join('\n').slice(0, 4000))],
  })
}

async function removeTracker(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({
      embeds: [errorEmbed('Trackers live per server, so run this inside your server.')],
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const id = interaction.options.getString('tracker', true)

  if (!ObjectId.isValid(id)) {
    await interaction.reply({
      embeds: [errorEmbed('Pick a coin from the dropdown rather than typing an id.')],
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const { coinTrackers } = getCollections()
  const result = await coinTrackers.deleteOne({
    _id: new ObjectId(id),
    guildId: interaction.guildId,
    userId: interaction.user.id,
  })

  await interaction.reply({
    embeds: [
      result.deletedCount === 1
        ? successEmbed('Stopped tracking that coin.')
        : errorEmbed('That tracker no longer exists, or it is not yours.'),
    ],
    flags: MessageFlags.Ephemeral,
  })
}

async function clearTrackers(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({
      embeds: [errorEmbed('Trackers live per server, so run this inside your server.')],
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const { coinTrackers } = getCollections()
  const result = await coinTrackers.deleteMany({
    guildId: interaction.guildId,
    userId: interaction.user.id,
  })

  await interaction.reply({
    embeds: [
      successEmbed(`Stopped tracking ${result.deletedCount} coin${result.deletedCount === 1 ? '' : 's'}.`),
    ],
    flags: MessageFlags.Ephemeral,
  })
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000
}
