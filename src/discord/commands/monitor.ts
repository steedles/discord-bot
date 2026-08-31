import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js'
import { config } from '../../config.js'
import { MONITOR_FEATURES } from '../../features/registry.js'
import { getChain } from '../../market/chains.js'
import { dexDiscoveryLimiter, dexPairsLimiter, geckoCandlesLimiter } from '../../market/limiter.js'
import { latestAlerts } from '../../monitor/cooldown.js'
import { countTokens } from '../../monitor/watchlist.js'
import { activeMonitor } from '../../monitor/worker.js'
import type { Command } from '../command.js'
import { errorEmbed, noticeEmbed } from '../embeds.js'

/**
 * Operational read-out for the volume monitor.
 *
 * Read-only on purpose. Thresholds are declared in each feature's settings
 * schema, which means the dashboard renders a form for them and `/feature`
 * edits them per channel - all of it generic over the registry. A second,
 * hand-written config command would be a parallel way to write the same rows
 * that has to be kept in step with the schema by hand, and would drift.
 *
 * What this answers instead is the question the dashboard cannot: whether the
 * data sources behind those settings are actually working.
 */
export const monitorCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('monitor')
    .setDescription('Volume monitor health and configuration')
    .addSubcommand((sub) =>
      sub.setName('status').setDescription('Show data source health, watchlist size and recent alerts'),
    )
    .addSubcommand((sub) =>
      sub.setName('config').setDescription('Show where the monitor thresholds are configured'),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        embeds: [errorEmbed('This command only works inside a server, not in DMs.')],
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        embeds: [errorEmbed('You need **Manage Server** to see the monitor status.')],
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    return interaction.options.getSubcommand() === 'config'
      ? showConfig(interaction)
      : showStatus(interaction)
  },
}

async function showStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const monitor = activeMonitor()

  if (!monitor || !config.MONITOR_ENABLED) {
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          '**Volume monitor is off.**\nSet `MONITOR_ENABLED=true` and restart the bot to turn it on.',
        ),
      ],
    })
    return
  }

  const [watchlistSize, recent] = await Promise.all([countTokens(), latestAlerts(5)])
  const health = monitor.healthReport()
  const tickers = monitor.tickerStats()

  const whaleLines = health.map((h) => {
    const label = getChain(h.chainId)?.label ?? h.chainId
    const state = h.healthy ? '🟢' : '🔴'
    const whale =
      h.whaleSupport === 'unsupported'
        ? `no whale data — ${h.whaleNote ?? 'unsupported'}`
        : `whales via ${h.whaleSupport}`
    const failures = h.consecutiveFailures > 0 ? ` · ${h.consecutiveFailures} failures in a row` : ''
    return `${state} **${label}** — ${whale}${failures}`
  })

  const pairs = dexPairsLimiter.stats()
  const discovery = dexDiscoveryLimiter.stats()
  const candles = geckoCandlesLimiter.stats()

  const alertLines =
    recent.length > 0
      ? recent.map(
          (a) =>
            `• **${a.symbol}** ${a.trigger} — <#${a.channelId}> <t:${Math.floor(a.postedAt.getTime() / 1000)}:R>`,
        )
      : ['• Nothing posted yet.']

  await interaction.editReply({
    embeds: [
      noticeEmbed(
        [
          '**Volume monitor**',
          `Polling every ${config.MONITOR_POLL_SECONDS}s · ${monitor.cycles} cycles since start`,
          `Watchlist ${watchlistSize}/${config.MONITOR_MAX_TOKENS} tokens`,
          // Absent until something has run Vamp Watch, rather than a permanent
          // "0 tickers" line on every server that never turned it on.
          ...(tickers.tickers > 0
            ? [`Ticker vamps: ${tickers.tickers} tickers searched, ${tickers.fresh} still fresh`]
            : []),
          '',
          '**Data sources**',
          ...whaleLines,
          '',
          '**Request budget**',
          budgetLine('Pairs', pairs),
          budgetLine('Discovery', discovery),
          budgetLine('Candles', candles),
          '',
          '**Recent alerts**',
          ...alertLines,
          '',
          config.MONITOR_STATUS_CHANNEL_ID
            ? `Outages are reported in <#${config.MONITOR_STATUS_CHANNEL_ID}>.`
            : 'No status channel set — outages are logged but not posted. Set `MONITOR_STATUS_CHANNEL_ID`.',
        ]
          .join('\n')
          .slice(0, 4000),
      ),
    ],
  })
}

/**
 * A bucket's line in the status embed. The throttled rate is only shown when it
 * is below the ceiling: seeing "120/min" when the configured budget is 120 says
 * nothing, while "48/min (throttled from 120)" is the whole story about why
 * alerts are arriving late.
 */
function budgetLine(
  label: string,
  s: ReturnType<typeof dexPairsLimiter.stats>,
): string {
  const rate =
    s.perMinute < s.ceiling
      ? `${s.perMinute}/min (throttled from ${s.ceiling}, ${s.rejections} refused)`
      : `${s.ceiling}/min`
  return `${label}: ${rate} · ${s.available} available, ${s.queued} queued`
}

async function showConfig(interaction: ChatInputCommandInteraction): Promise<void> {
  const dashboard = config.DASHBOARD_URL
    ? `[the dashboard](${config.DASHBOARD_URL})`
    : 'the dashboard'

  await interaction.reply({
    flags: MessageFlags.Ephemeral,
    embeds: [
      noticeEmbed(
        [
          '**Monitor thresholds live with each feature**, per channel, so a strict channel and a loose one can watch the same tokens with different rules.',
          '',
          ...MONITOR_FEATURES.map(
            (f) => `${f.icon} **${f.name}** — \`${f.id}\` · ${f.settings.length} settings`,
          ),
          '',
          `Edit them in ${dashboard}, or with \`/feature\` in the channel you want to change.`,
          '',
          'Every threshold is per channel: multipliers, USD floors, minimum liquidity and pool age, cooldown, hourly cap and the role to ping.',
          '',
          'Run `/monitor status` for data source health and the request budget.',
        ].join('\n'),
      ),
    ],
  })
}
