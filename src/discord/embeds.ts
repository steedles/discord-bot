import { EmbedBuilder } from 'discord.js'
import type { BriefLine, TokenBrief } from '../analysis/brief.js'
import type { TurnSignal } from '../analysis/trend.js'
import type { Alert, CoinTracker, RugCheck, TrackedWallet } from '../db/models.js'
import { explorerUrl, getChain } from '../market/chains.js'
import { tradeLinksMarkdown } from '../market/trade-links.js'
import { hasSocials, pairAgeMinutes as dexPairAgeMinutes, type DexPair } from '../market/dexscreener.js'
import { pairAgeMinutes } from '../monitor/detect/gates.js'
import type { AlertKind, Trigger } from '../monitor/detect/types.js'
import type { AlertContext, Movement } from '../monitor/detect/context.js'
import type { MarketSnapshot, WhaleSwap } from '../monitor/providers/types.js'
import {
  formatAge,
  formatCompactUsd,
  formatPercent,
  formatUsdPrice,
  truncateAddress,
} from '../market/format.js'
import { LEVEL_COLOR, LEVEL_EMOJI, type RiskReport } from '../risk/index.js'
import type { RugCheckResult } from '../risk/rugSignature.js'

const GREEN = 0x2ecc71
const RED = 0xe74c3c
const GREY = 0x95a5a6

function trendColor(pair: DexPair): number {
  const change = pair.priceChange?.h24
  if (change === undefined) return GREY
  return change >= 0 ? GREEN : RED
}

function tokenTitle(pair: DexPair): string {
  const chain = getChain(pair.chainId)
  return `${chain?.emoji ?? ''} ${pair.baseToken.symbol} / ${pair.quoteToken.symbol}`.trim()
}

/**
 * One `**Label**  a · b · c` line of figures.
 *
 * This replaces the three-column field layout the alerts used to carry. Columns
 * read well at desktop width and fall apart on a phone: Discord stacks inline
 * fields into one narrow column, the values wrap, and a figure ends up nowhere
 * near the heading that said what it was. Keeping every label beside its own
 * value means a wrap can only ever break *between* pairs, never inside one.
 *
 * Empty parts are dropped rather than printed as blanks, so a provider that did
 * not answer leaves no trace instead of an em dash nobody can interpret.
 */
function statLine(label: string, parts: (string | false | undefined)[]): string | undefined {
  const kept = parts.filter((part): part is string => Boolean(part))
  return kept.length > 0 ? `**${label}**  ${kept.join(' · ')}` : undefined
}

/** Joins stat lines and drops the ones that had nothing to say. */
function statBlock(...lines: (string | undefined)[]): string {
  return lines.filter((line): line is string => Boolean(line)).join('\n')
}

function linksLine(pair: DexPair): string {
  const parts: string[] = []

  // Trade venues first: the chart and the contract are both there to check
  // something, these are the ones someone actually does something with.
  parts.push(
    ...tradeLinksMarkdown(pair.chainId, pair.baseToken.address, {
      dexId: pair.dexId,
      pairAddress: pair.pairAddress,
    }),
  )

  parts.push(`[DexScreener](${pair.url})`)
  const explorer = explorerUrl(pair.chainId, pair.baseToken.address)
  if (explorer) parts.push(`[Explorer](${explorer})`)

  for (const site of pair.info?.websites?.slice(0, 2) ?? []) {
    parts.push(`[${site.label ?? 'Website'}](${site.url})`)
  }
  for (const social of pair.info?.socials?.slice(0, 3) ?? []) {
    const label = social.type ?? social.platform ?? 'Social'
    parts.push(`[${label[0]!.toUpperCase()}${label.slice(1)}](${social.url})`)
  }
  return parts.join(' • ')
}


/**
 * Pool-health warnings, rendered above everything else.
 *
 * These are facts about the pool rather than a provider's judgement, and an
 * empty pool outranks any contract detail - so they lead, and the score is
 * explicitly labelled as covering the contract only.
 */
function tradabilityField(report: RiskReport): { name: string; value: string } | undefined {
  const t = report.tradability
  if (!t || t.flags.length === 0) return undefined
  return {
    name: t.untradeable ? '🚫 Cannot be traded' : '⚠️ Pool health',
    value: t.flags
      .slice(0, 4)
      .map((f) => `${f.severity === 'danger' ? '🔴' : '🟡'} ${f.label}${f.detail ? `\n   ${f.detail}` : ''}`)
      .join('\n')
      .slice(0, 1024),
  }
}

export function priceEmbed(pair: DexPair): EmbedBuilder {
  const chain = getChain(pair.chainId)
  const price = pair.priceUsd ? Number(pair.priceUsd) : undefined
  const txns = pair.txns?.h24

  const embed = new EmbedBuilder()
    .setColor(trendColor(pair))
    .setTitle(tokenTitle(pair))
    .setURL(pair.url)
    .setDescription(
      [
        `**${formatUsdPrice(price)}**  ·  ${pair.baseToken.name}`,
        '',
        statBlock(
          statLine('Change', [
            `5m ${formatPercent(pair.priceChange?.m5)}`,
            `1h ${formatPercent(pair.priceChange?.h1)}`,
            `24h ${formatPercent(pair.priceChange?.h24)}`,
          ]),
          statLine('Market', [
            `MCap ${formatCompactUsd(pair.marketCap ?? pair.fdv)}`,
            `Liq ${formatCompactUsd(pair.liquidity?.usd)}`,
            `Vol 24h ${formatCompactUsd(pair.volume?.h24)}`,
          ]),
          statLine('Trades 24h', [
            txns && `${txns.buys.toLocaleString()} buys`,
            txns && `${txns.sells.toLocaleString()} sells`,
          ]),
          statLine('Age', [formatAge(dexPairAgeMinutes(pair))]),
        ),
      ].join('\n'),
    )
    .addFields(
      { name: 'Links', value: linksLine(pair), inline: false },
    )
    .setFooter({ text: `${chain?.label ?? pair.chainId} · ${pair.dexId} · ${truncateAddress(pair.baseToken.address)}` })
    .setTimestamp(new Date())

  if (pair.info?.imageUrl) embed.setThumbnail(pair.info.imageUrl)
  return embed
}

export function riskEmbed(pair: DexPair, report: RiskReport): EmbedBuilder {
  const chain = getChain(pair.chainId)
  const emoji = LEVEL_EMOJI[report.level]

  const headline =
    report.level === 'unknown'
      ? `${emoji} **Unknown** — ${report.note ?? 'no risk data available'}`
      : `${emoji} **${report.level.toUpperCase()}** risk — score ${report.score}/100 (lower is safer)`

  const embed = new EmbedBuilder()
    .setColor(LEVEL_COLOR[report.level])
    .setTitle(`Risk scan · ${pair.baseToken.symbol}`)
    .setURL(pair.url)
    .setDescription(headline)

  const trade = tradabilityField(report)
  if (trade) embed.addFields(trade)

  const dangers = report.flags.filter((f) => f.severity === 'danger')
  const warnings = report.flags.filter((f) => f.severity === 'warn')

  if (dangers.length > 0) {
    embed.addFields({
      name: `🔴 Critical (${dangers.length})`,
      value: dangers
        .slice(0, 8)
        .map((f) => `• ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
        .join('\n')
        .slice(0, 1024),
    })
  }
  if (warnings.length > 0) {
    embed.addFields({
      name: `🟡 Warnings (${warnings.length})`,
      value: warnings
        .slice(0, 8)
        .map((f) => `• ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
        .join('\n')
        .slice(0, 1024),
    })
  }
  if (dangers.length === 0 && warnings.length === 0 && report.level !== 'unknown') {
    embed.addFields({ name: 'Checks', value: 'No red flags returned by the provider.' })
  }

  const metrics: string[] = []
  const m = report.metrics
  if (m.lpLockedPct !== undefined) metrics.push(`LP locked ${m.lpLockedPct.toFixed(0)}%`)
  if (m.holderCount !== undefined) metrics.push(`Holders ${m.holderCount.toLocaleString()}`)
  if (m.buyTaxPct !== undefined) metrics.push(`Buy tax ${m.buyTaxPct.toFixed(1)}%`)
  if (m.sellTaxPct !== undefined) metrics.push(`Sell tax ${m.sellTaxPct.toFixed(1)}%`)
  if (m.topHolderPct !== undefined) metrics.push(`Top wallet ${m.topHolderPct.toFixed(1)}%`)
  embed.addFields(
    {
      name: 'Numbers',
      value: statBlock(
        statLine('Market', [
          `Price ${formatUsdPrice(pair.priceUsd ? Number(pair.priceUsd) : undefined)}`,
          `Liq ${formatCompactUsd(pair.liquidity?.usd)}`,
          `MCap ${formatCompactUsd(pair.marketCap ?? pair.fdv)}`,
          `Age ${formatAge(dexPairAgeMinutes(pair))}`,
        ]),
        statLine('Contract', metrics),
      ),
      inline: false,
    },
    { name: 'Links', value: linksLine(pair), inline: false },
  )

  const provider = report.source === 'none' ? 'no provider' : report.source
  embed
    .setFooter({ text: `${chain?.label ?? pair.chainId} · via ${provider} · not financial advice` })
    .setTimestamp(new Date())

  if (pair.info?.imageUrl) embed.setThumbnail(pair.info.imageUrl)
  return embed
}

/**
 * A rug-signature finding (docs/11-RUG-SIGNATURE.md), if flagged by either
 * the funding graph or the holder-distribution check (risk/rugSignature.ts).
 * This is a separate, additive signal - it never touches the embed's colour
 * or the vendor risk score above, and the caller only ever passes a *flagged*
 * result (never a checked-and-clean or never-checked one - see
 * `postToDestination` in launch-scanner.ts) so absence never reads as "safe".
 */
function rugCheckField(rugCheck: RugCheck) {
  const fundingFlagged = rugCheck.fundingVerdict === 'flag'
  const distributionFlagged = rugCheck.distributionVerdict === 'flag'
  return {
    name: '🚨 Rug Pattern Detected',
    value: [
      fundingFlagged
        ? `${rugCheck.tightCohortSize} wallet${rugCheck.tightCohortSize === 1 ? '' : 's'} funded by the same wallet that funded this coin's creator, within 60s of each other, and still holding.`
        : undefined,
      fundingFlagged && rugCheck.funderWallet ? `Funder \`${truncateAddress(rugCheck.funderWallet)}\`` : undefined,
      fundingFlagged && rugCheck.cohortSharePct !== undefined
        ? `Holding ~${rugCheck.cohortSharePct.toFixed(1)}% of supply`
        : undefined,
      fundingFlagged && rugCheck.tailMatch ? '⚠️ Also matches a known launcher fingerprint' : undefined,
      distributionFlagged && rugCheck.distributionCv !== null
        ? `Top ${rugCheck.distributionCohort} non-pool holders sit within a suspiciously flat band (CV ${rugCheck.distributionCv.toFixed(3)}) - looks scripted, not organic.`
        : undefined,
      '_Pattern match against 15 known rugs plus a holder-flatness check, both unproven forward - advisory, not a certainty._',
    ]
      .filter((line): line is string => Boolean(line))
      .join('\n')
      .slice(0, 1024),
    inline: false,
  }
}

export function launchEmbed(
  pair: DexPair,
  report: RiskReport,
  source: 'dexscreener' | 'pumpfun',
  rugCheck?: RugCheck,
): EmbedBuilder {
  const chain = getChain(pair.chainId)
  const label = source === 'pumpfun' ? 'pump.fun graduation' : 'new listing'

  const embed = new EmbedBuilder()
    .setColor(LEVEL_COLOR[report.level])
    .setTitle(`🚀 ${pair.baseToken.symbol} — ${pair.baseToken.name}`)
    .setURL(pair.url)
    .setDescription(
      [
        ...(rugCheck ? ['🚨 **Rug pattern detected - see below**'] : []),
        `${LEVEL_EMOJI[report.level]} Risk **${report.level}**${report.level === 'unknown' ? '' : ` (${report.score}/100)`}`,
        `Detected via ${label} on ${chain?.label ?? pair.chainId}`,
      ].join('\n'),
    )
    .addFields(
      ...(rugCheck ? [rugCheckField(rugCheck)] : []),
      {
        name: 'Numbers',
        value: statBlock(
          statLine('Market', [
            `Price ${formatUsdPrice(pair.priceUsd ? Number(pair.priceUsd) : undefined)}`,
            `MCap ${formatCompactUsd(pair.marketCap ?? pair.fdv)}`,
            `Liq ${formatCompactUsd(pair.liquidity?.usd)}`,
          ]),
          statLine('Traction', [
            `Vol 24h ${formatCompactUsd(pair.volume?.h24)}`,
            `${pair.txns?.h24?.buys ?? 0} buys · ${pair.txns?.h24?.sells ?? 0} sells`,
            `Age ${formatAge(dexPairAgeMinutes(pair))}`,
          ]),
        ),
        inline: false,
      },
      {
        name: 'Flags',
        value:
          report.flags.length > 0
            ? report.flags
                .slice(0, 5)
                .map((f) => `${f.severity === 'danger' ? '🔴' : '🟡'} ${f.label}`)
                .join('\n')
                .slice(0, 1024)
            : hasSocials(pair)
              ? 'None reported · has socials'
              : 'None reported · no socials',
        inline: false,
      },
      // The whole mint, in code formatting, because the point of a launch alert
      // is to go and look the token up - and the truncated address this used to
      // carry in the footer is the one thing that cannot be pasted anywhere.
      // Sits directly above the links so copy-then-click is one movement.
      { name: 'Contract', value: `\`${pair.baseToken.address}\`` },
      { name: 'Links', value: linksLine(pair), inline: false },
    )
    .setFooter({ text: 'Auto-scan, always DYOR' })
    .setTimestamp(new Date())

  if (pair.info?.imageUrl) embed.setThumbnail(pair.info.imageUrl)
  return embed
}

export function alertTriggeredEmbed(alert: Alert, price: number, pair?: DexPair): EmbedBuilder {
  const chain = getChain(alert.chainId)
  const hitAbove = alert.direction === 'above'
  const movePct =
    alert.priceAtCreate > 0 ? ((price - alert.priceAtCreate) / alert.priceAtCreate) * 100 : undefined

  const embed = new EmbedBuilder()
    .setColor(hitAbove ? GREEN : RED)
    .setTitle(`${hitAbove ? '📈' : '📉'} ${alert.symbol} is ${alert.direction} ${formatUsdPrice(alert.target)}`)
    .setDescription(
      [
        `Now **${formatUsdPrice(price)}**`,
        '',
        statBlock(
          statLine('Target', [`${alert.direction} ${formatUsdPrice(alert.target)}`]),
          statLine('When set', [
            formatUsdPrice(alert.priceAtCreate),
            movePct !== undefined && `${formatPercent(movePct)} since`,
          ]),
        ),
      ].join('\n'),
    )
    .setFooter({ text: `${chain?.label ?? alert.chainId} · ${alert.repeat ? 're-armed' : 'alert cleared'}` })
    .setTimestamp(new Date())

  if (pair) embed.setURL(pair.url).addFields({ name: 'Links', value: linksLine(pair) })
  return embed
}

/**
 * Second-opinion rug check on a token someone else mentioned.
 *
 * Leads with the verdict rather than the token: whoever posted the address
 * already knows what it is - what they do not have is an independent read on
 * whether it is safe.
 */
export function rugWatchEmbed(
  pair: DexPair,
  report: RiskReport,
  via: string,
  showMarket: boolean,
): EmbedBuilder {
  const chain = getChain(pair.chainId)
  const dangers = report.flags.filter((f) => f.severity === 'danger')
  const warnings = report.flags.filter((f) => f.severity === 'warn')

  const verdict =
    report.level === 'unknown'
      ? `${LEVEL_EMOJI.unknown} **No risk data** — ${report.note ?? 'nobody could vouch for this token'}`
      : `${LEVEL_EMOJI[report.level]} **${report.level.toUpperCase()}** risk · **${report.score}/100** _(lower is safer)_`

  const embed = new EmbedBuilder()
    .setColor(report.tradability?.untradeable ? 0xe74c3c : LEVEL_COLOR[report.level])
    .setTitle(`🛡️ Rug check · ${pair.baseToken.symbol}`)
    .setURL(pair.url)
    .setDescription(verdict)

  const trade = tradabilityField(report)
  if (trade) embed.addFields(trade)

  if (dangers.length > 0) {
    embed.addFields({
      name: `🔴 Critical (${dangers.length})`,
      value: dangers
        .slice(0, 6)
        .map((f) => `• ${f.label}${f.detail ? ` — ${f.detail}` : ''}`)
        .join('\n')
        .slice(0, 1024),
    })
  }
  if (warnings.length > 0) {
    embed.addFields({
      name: `🟡 Warnings (${warnings.length})`,
      value: warnings
        .slice(0, 6)
        .map((f) => `• ${f.label}`)
        .join('\n')
        .slice(0, 1024),
    })
  }
  if (dangers.length === 0 && warnings.length === 0 && report.level !== 'unknown') {
    embed.addFields({ name: 'Checks', value: 'No red flags returned by the provider.' })
  }

  const metrics: string[] = []
  const m = report.metrics
  if (m.lpLockedPct !== undefined) metrics.push(`LP locked ${m.lpLockedPct.toFixed(0)}%`)
  if (m.holderCount !== undefined) metrics.push(`Holders ${m.holderCount.toLocaleString()}`)
  if (m.buyTaxPct !== undefined) metrics.push(`Buy tax ${m.buyTaxPct.toFixed(1)}%`)
  if (m.sellTaxPct !== undefined) metrics.push(`Sell tax ${m.sellTaxPct.toFixed(1)}%`)
  if (m.topHolderPct !== undefined) metrics.push(`Top wallet ${m.topHolderPct.toFixed(1)}%`)

  const numbers = statBlock(
    statLine('Contract', metrics),
    statLine('Market', [
      showMarket && `Price ${formatUsdPrice(pair.priceUsd ? Number(pair.priceUsd) : undefined)}`,
      showMarket && `Liq ${formatCompactUsd(pair.liquidity?.usd)}`,
      showMarket && `MCap ${formatCompactUsd(pair.marketCap ?? pair.fdv)}`,
      showMarket && `Age ${formatAge(dexPairAgeMinutes(pair))}`,
    ]),
  )

  if (numbers) embed.addFields({ name: 'Numbers', value: clamp(numbers), inline: false })

  embed
    .addFields({ name: 'Contract', value: `\`${pair.baseToken.address}\`` })
    .addFields({ name: 'Links', value: linksLine(pair), inline: false })
    .setFooter({
      text: `${chain?.label ?? pair.chainId} · ${report.source === 'none' ? 'no provider' : report.source} · picked up from ${via} · not financial advice`,
    })
    .setTimestamp(new Date())

  if (pair.info?.imageUrl) embed.setThumbnail(pair.info.imageUrl)
  return embed
}

/**
 * A trend turn on the one-minute chart.
 *
 * It leads with the direction because that is the whole message, then shows
 * every signal that voted - including any that voted the other way. A reader who
 * only sees the agreeing signals cannot tell a unanimous call from a 2-1 split,
 * and on a one-minute chart that difference is most of the information.
 */
export function trendTurnEmbed(
  tracker: CoinTracker,
  signal: TurnSignal,
  pair: DexPair | undefined,
  minutesSinceLast: number | undefined,
): EmbedBuilder {
  const up = signal.direction === 'up'
  const chain = getChain(tracker.chainId)

  const embed = new EmbedBuilder()
    .setColor(up ? GREEN : RED)
    .setTitle(`${up ? '📈' : '📉'} ${tracker.symbol} is turning ${up ? 'UP' : 'DOWN'}`)
    .setDescription(
      [
        `**${formatUsdPrice(signal.price)}** · ${signal.agreeing.length} of 3 signals agree`,
        minutesSinceLast !== undefined
          ? `Last turn was ${formatAge(minutesSinceLast)} ago, the other way.`
          : 'First turn since you started tracking it.',
      ].join('\n'),
    )

  embed.addFields({
    name: `${up ? '🟢' : '🔴'} What turned`,
    value: clamp(
      signal.agreeing
        .map((d) => `• **${d.label}**${d.barsAgo > 0 ? ` (${d.barsAgo}m ago)` : ''} — ${d.detail}`)
        .join('\n'),
    ),
  })

  if (signal.disagreeing.length > 0) {
    embed.addFields({
      name: '⚖️ Pointing the other way',
      value: clamp(signal.disagreeing.map((d) => `• ${d.label} — ${d.detail}`).join('\n')),
    })
  }

  const numbers = statBlock(
    statLine('Move', [
      signal.change5m !== undefined && `5m ${formatPercent(signal.change5m)}`,
      signal.change15m !== undefined && `15m ${formatPercent(signal.change15m)}`,
      signal.change1h !== undefined && `1h ${formatPercent(signal.change1h)}`,
    ]),
    statLine('Readings', [
      signal.rsi !== undefined && `RSI ${signal.rsi.toFixed(1)}`,
      signal.macdHistogram !== undefined && `MACD hist ${signal.macdHistogram.toPrecision(3)}`,
      signal.emaFast !== undefined &&
        signal.emaSlow !== undefined &&
        `EMA 9/21 ${signal.emaFast > signal.emaSlow ? 'fast above' : 'fast below'}`,
    ]),
    statLine('Market', [
      pair && `Liq ${formatCompactUsd(pair.liquidity?.usd)}`,
      pair && `MCap ${formatCompactUsd(pair.marketCap ?? pair.fdv)}`,
      pair && `Vol 24h ${formatCompactUsd(pair.volume?.h24)}`,
    ]),
  )

  if (numbers) embed.addFields({ name: 'Numbers', value: clamp(numbers), inline: false })

  if (pair) {
    embed.setURL(pair.url).addFields({ name: 'Links', value: clamp(linksLine(pair)) })
  }

  return embed
    .setFooter({
      text: `${chain?.label ?? tracker.chainId} · 1-minute candles via GeckoTerminal · a crossover is not a prediction`,
    })
    .setTimestamp(new Date(signal.candleTime * 1000))
}

export interface BriefContext {
  /** Who posted the address that triggered this. */
  poster: string
  channelId: string
  /** Where in the message the address was found, e.g. "dexscreener" or "address". */
  via: string
  jumpUrl?: string
  detail: 'full' | 'short'
  delivery: 'channel' | 'dm'
}

/** Discord rejects a field value over 1024 characters outright. */
function clamp(value: string, limit = 1024): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

function renderSection(section: { lines: BriefLine[]; bullets?: string[] }): string {
  const lines = section.lines.map(
    (l) => `**${l.label}:** ${l.value}${l.meaning ? ` - ${l.meaning}` : ''}`,
  )
  return clamp([...lines, ...(section.bullets ?? [])].join('\n'))
}

/**
 * A whole token explained in one message.
 *
 * The "quick summary" setting exists for a reason: this is long, and a busy
 * channel is a different place from a DM. What it never does is drop a number
 * silently - `detail` chooses between sections, not between facts.
 */
export function tokenBriefEmbed(
  brief: TokenBrief,
  pair: DexPair,
  report: RiskReport,
  ctx: BriefContext,
): EmbedBuilder {
  // A DM arrives with no surroundings, so it has to say where it came from. A
  // channel reply is already sitting under the message that triggered it.
  const context =
    ctx.delivery === 'dm'
      ? [
          `Posted by **${ctx.poster}** in <#${ctx.channelId}>`,
          ctx.jumpUrl ? `[jump to message](${ctx.jumpUrl})` : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : ''

  const embed = new EmbedBuilder()
    .setColor(report.tradability?.untradeable ? RED : LEVEL_COLOR[report.level])
    .setTitle(`📋 ${brief.title}`.slice(0, 256))
    .setURL(pair.url)
    .setDescription(
      clamp(
        [`${brief.verdict.emoji} **${brief.verdict.text}**`, '', brief.summary, ...(context ? ['', context] : [])].join(
          '\n',
        ),
        4096,
      ),
    )

  const sections = ctx.detail === 'short' ? brief.sections.slice(0, 1) : brief.sections
  for (const section of sections) {
    if (section.lines.length === 0 && (section.bullets?.length ?? 0) === 0) continue
    embed.addFields({ name: section.title, value: renderSection(section) })
  }

  if (brief.concerns.length > 0) {
    embed.addFields({
      name: '⚠️ What the numbers say',
      value: clamp(brief.concerns.map((c) => `• ${c}`).join('\n')),
    })
  }
  if (brief.inFavour.length > 0) {
    embed.addFields({
      name: '✅ In its favour',
      value: clamp(brief.inFavour.map((c) => `• ${c}`).join('\n')),
    })
  }
  if (ctx.detail === 'full' && brief.notChecked.length > 0) {
    embed.addFields({
      name: '❓ Nobody checked',
      value: clamp(brief.notChecked.map((c) => `• ${c}`).join('\n')),
    })
  }

  embed
    .addFields(
      { name: 'Contract', value: `\`${pair.baseToken.address}\`` },
      { name: 'Links', value: clamp(linksLine(pair)) },
    )
    .setFooter({
      text: `${brief.subtitle} · numbers from ${brief.sources.join(' + ')} · found via ${ctx.via} · not financial advice`.slice(
        0,
        2048,
      ),
    })
    .setTimestamp(new Date())

  if (pair.info?.imageUrl) embed.setThumbnail(pair.info.imageUrl)
  return embed
}

/**
 * Colour by chain, so a busy channel is scannable without reading.
 *
 * These are the chains' own brand colours rather than a red/green judgement:
 * the alert already says what happened, and tinting a whale sell green because
 * the token is up on the day would be saying something we did not measure.
 */
const CHAIN_COLOR: Record<string, number> = {
  solana: 0x14f195,
  ethereum: 0x627eea,
  bsc: 0xf0b90b,
  base: 0x0052ff,
  arbitrum: 0x28a0f0,
  polygon: 0x8247e5,
  optimism: 0xff0420,
  avalanche: 0xe84142,
  blast: 0xfcfc03,
  robinhood: 0x00c805,
}

const MONITOR_ICON: Record<AlertKind, string> = {
  spike: '📊',
  whale: '🐋',
  momentum: '📈',
  drawdown: '🩸',
  recovery: '🟢',
  call: '🎯',
  level: '🎯',
  churn: '⚔️',
  vamp: '🧛',
}

const MONITOR_LABEL: Record<AlertKind, string> = {
  spike: 'Volume spike',
  whale: 'Whale buy',
  momentum: 'Trending',
  drawdown: 'Dip',
  recovery: 'Recovery',
  call: 'Called coin',
  level: 'Level break',
  churn: 'PvP churn',
  vamp: 'Ticker vamp',
}

/**
 * Dip and recovery alerts come in pairs and are read at a glance, so direction
 * is carried by the colour rather than by the chain. Everything else keeps the
 * chain colour, which is how a busy channel stays sortable by source.
 */
const MONITOR_COLOR: Partial<Record<AlertKind, number>> = {
  drawdown: RED,
  recovery: GREEN,
  call: GREEN,
}

function monitorLinks(snapshot: MarketSnapshot, txHash?: string): string {
  const parts: string[] = []

  parts.push(
    ...tradeLinksMarkdown(snapshot.chainId, snapshot.tokenAddress, {
      dexId: snapshot.dexId,
      pairAddress: snapshot.pairAddress,
    }),
  )

  if (snapshot.url) parts.push(`[DexScreener](${snapshot.url})`)

  const explorer = explorerUrl(snapshot.chainId, snapshot.tokenAddress)
  if (explorer) parts.push(`[Explorer](${explorer})`)

  if (txHash) {
    const tx = txUrl(snapshot.chainId, txHash)
    if (tx) parts.push(`[Transaction](${tx})`)
  }

  return parts.join(' • ')
}

/** Transaction page for a chain, when we know where one lives. */
function txUrl(chainId: string, txHash: string): string | undefined {
  const token = getChain(chainId)?.explorerToken
  if (!token) return undefined
  // Every explorer in CHAINS puts transactions at /tx/ off the same origin.
  return `${new URL(token).origin}/tx/${txHash}`
}

/**
 * A volume-monitor alert.
 *
 * Leads with what fired rather than with the token, because the token is not the
 * news - a channel watching a hundred tokens already knows they exist, and the
 * only reason this message is here is the trigger. Every figure below it is a
 * measurement; nothing is a rating.
 */
/**
 * A figure as its move, or as its current value when there is no "before".
 *
 * The move is the point: "$29.71M → $28.32M  -4.7%" answers the question a
 * reader actually has, where "$28.32M" makes them go and find the last alert to
 * work it out. Falls back rather than disappearing, because a token added four
 * minutes ago has no history and still has a market cap.
 */
function movementLine(
  label: string,
  movement: Movement | undefined,
  current: string,
  extra?: string,
): string | undefined {
  if (current === 'n/a' && !movement) return undefined

  const parts = movement
    ? [
        `${formatCompactish(label, movement.from)} → ${formatCompactish(label, movement.to)}`,
        // One decimal, not two. These are the headline figures of the alert and
        // "-34.4%" is the number a reader repeats; "-34.37%" implies a precision
        // the underlying market cap does not have.
        `${movement.changePct > 0 ? '+' : ''}${movement.changePct.toFixed(1)}%`,
      ]
    : [current]

  if (extra) parts.push(extra)
  return statLine(label, parts)
}

/** Prices need precision; sizes need compactness. */
function formatCompactish(label: string, value: number): string {
  return label === 'Price' ? formatUsdPrice(value) : formatCompactUsd(value)
}

/**
 * The dot in front of an observation.
 *
 * Green is "the pool is behaving", red is "depth is leaving" - a distinction
 * about liquidity, never a view on the price. A token can be down 40% with a
 * green dot, and that is the honest reading: the sentence is about whether the
 * pool emptied, not about whether anyone should buy.
 */
function dotFor(sentence: string): string {
  return /leaving|thinning/.test(sentence) ? '🔴' : '🟢'
}

export function monitorAlertEmbed(
  trigger: Trigger,
  snapshot: MarketSnapshot,
  context?: AlertContext,
  swap?: WhaleSwap,
): EmbedBuilder {
  const chain = getChain(snapshot.chainId)

  const embed = new EmbedBuilder()
    .setColor(MONITOR_COLOR[trigger.kind] ?? CHAIN_COLOR[snapshot.chainId] ?? GREY)
    .setTitle(`${MONITOR_ICON[trigger.kind]} ${snapshot.symbol} — ${trigger.headline}`.slice(0, 256))
    .setDescription(
      [
        `${chain?.emoji ?? ''} **${snapshot.name}** on ${chain?.label ?? snapshot.chainId}`.trim(),
        ...trigger.detail.map((line) => `• ${line}`),
        '',
        statBlock(
          // A figure that moved is shown as the move. Falling back to the bare
          // current value keeps the line rather than dropping it, because a
          // token watched for four minutes has no "before" and still has a price.
          movementLine('MCap', context?.marketCap, formatCompactUsd(snapshot.marketCapUsd)),
          movementLine(
            'Price',
            context?.price,
            formatUsdPrice(snapshot.priceUsd),
            // Same precision as the movement beside it - two figures on one
            // line disagreeing about decimals reads as a mistake.
            snapshot.priceChange.h24 !== undefined
              ? `24h ${snapshot.priceChange.h24 > 0 ? '+' : ''}${snapshot.priceChange.h24.toFixed(1)}%`
              : undefined,
          ),
          movementLine('Liquidity', context?.liquidity, formatCompactUsd(snapshot.liquidityUsd)),
          statLine('Volume', [
            snapshot.volume.m5 !== undefined && `5m ${formatCompactUsd(snapshot.volume.m5)}`,
            snapshot.volume.h1 !== undefined && `1h ${formatCompactUsd(snapshot.volume.h1)}`,
            snapshot.volume.h24 !== undefined && `24h ${formatCompactUsd(snapshot.volume.h24)}`,
          ]),
          statLine('Trades 5m', [
            snapshot.txns.m5 && `${snapshot.txns.m5.buys.toLocaleString()} buys`,
            snapshot.txns.m5 && `${snapshot.txns.m5.sells.toLocaleString()} sells`,
          ]),
          statLine('Age', [formatAge(pairAgeMinutes(snapshot))]),
          statLine('Wallet', [swap?.wallet && `\`${truncateAddress(swap.wallet, 6)}\``]),
        ),
        // The read-it-in-one-line half. Each carries its own dot, because these
        // are separate observations that can disagree - one overall colour would
        // force a verdict none of them makes.
        ...[
          context?.divergence && `${dotFor(context.divergence)} ${context.divergence}`,
          context?.flow && `${context.flow.includes(' sell') ? '🔴' : '🟢'} ${context.flow}`,
        ].filter(Boolean).flatMap((line) => ['', line as string]),
      ].join('\n'),
    )

  embed
    .addFields(
      { name: 'Contract', value: `\`${snapshot.tokenAddress}\`` },
      { name: 'Links', value: clamp(monitorLinks(snapshot, swap?.txHash)) },
    )
    .setFooter({
      text: [
        MONITOR_LABEL[trigger.kind],
        // Never the window that was configured - the one actually covered.
        context?.spanMinutes !== undefined && `measured over the last ${formatAge(context.spanMinutes)}`,
        chain?.label ?? snapshot.chainId,
      ]
        .filter(Boolean)
        .join(' · ')
        .concat(
          '\nAutomated on-chain data, not financial advice. Memecoins are extremely high risk — verify everything yourself.',
        ),
    })
    .setTimestamp(new Date(swap?.at ?? snapshot.fetchedAt))

  if (snapshot.url) embed.setURL(snapshot.url)
  if (snapshot.imageUrl) embed.setThumbnail(snapshot.imageUrl)

  return embed
}

/**
 * Provider health, posted when a data source goes down or comes back.
 *
 * Sent to an operator channel rather than an alert channel: a dead RPC is not
 * something a server admin can act on, and mixing it into a feed people read for
 * signals trains them to skim past it.
 */
export function monitorStatusEmbed(
  headline: string,
  lines: string[],
  level: 'ok' | 'problem',
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(level === 'ok' ? GREEN : RED)
    .setTitle(`${level === 'ok' ? '✅' : '⚠️'} ${headline}`.slice(0, 256))
    .setDescription(clamp(lines.join('\n'), 4096))
    .setTimestamp(new Date())
}

/**
 * `/rugcheck`'s reply - the on-demand counterpart to `rugCheckField` above.
 * Unlike the launch alert (flag-only, so silence never reads as "safe"), this
 * is a direct answer to a direct question, so all three verdicts are shown
 * explicitly - `unknown` says so rather than looking like a clean result.
 */
export function rugCheckResultEmbed(mint: string, result: RugCheckResult): EmbedBuilder {
  const color = result.verdict === 'flag' ? RED : result.verdict === 'clean' ? GREEN : GREY
  const headline =
    result.verdict === 'flag'
      ? '🚨 Rug pattern detected'
      : result.verdict === 'clean'
        ? '✅ No rug pattern found'
        : '❓ Could not be resolved'

  const fundingFlagged = result.fundingVerdict === 'flag'
  const distributionFlagged = result.distributionVerdict === 'flag'

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(headline)
    .setDescription(`\`${mint}\``)
    .addFields({
      name: 'Details',
      value: [
        fundingFlagged
          ? `${result.tightCohortSize} wallet${result.tightCohortSize === 1 ? '' : 's'} funded by the same wallet that funded this coin's creator, within 60s of each other, and still holding.`
          : result.fundingVerdict === 'clean'
            ? `Funding graph: none share the creator's funder in a tight window.`
            : undefined,
        distributionFlagged && result.distributionCv !== null
          ? `Distribution: top ${result.distributionCohort} non-pool holders are suspiciously flat (CV ${result.distributionCv.toFixed(3)}).`
          : result.distributionVerdict === 'clean' && result.distributionCv !== null
            ? `Distribution: organic taper across top ${result.distributionCohort} holders (CV ${result.distributionCv.toFixed(3)}).`
            : undefined,
        result.verdict === 'unknown' ? `Reason: ${result.reason}` : undefined,
        result.funderWallet ? `Funder \`${truncateAddress(result.funderWallet)}\`` : undefined,
        result.creatorWallet ? `Creator \`${truncateAddress(result.creatorWallet)}\`` : undefined,
        result.cohortSharePct !== undefined ? `Cohort holds ~${result.cohortSharePct.toFixed(1)}% of supply` : undefined,
        result.tailMatch ? '⚠️ Also matches a known launcher fingerprint' : undefined,
        result.fundingVerdict !== 'unknown'
          ? `Checked ${result.checkedHolders}/${result.totalHolders} top holders for the funding graph.`
          : undefined,
        '_Pattern match against 15 known pump.fun rugs plus a holder-flatness check, both unproven forward - advisory, not a certainty._',
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n')
        .slice(0, 1024),
      inline: false,
    })
}

/**
 * `/wallet`'s reply - Tracked Wallets, read-only against an imported list
 * (see `pnpm import:wallets`). Nothing here is computed by this codebase, so
 * a missing `score` is shown as "not scored" rather than as a low score -
 * some rows are cohort-tagged (e.g. moonshot frontrunners) rather than
 * trade-scored, and that is a different fact than "scored zero".
 */
export function trackedWalletEmbed(wallet: string, row: TrackedWallet | null): EmbedBuilder {
  if (!row) {
    return new EmbedBuilder()
      .setColor(GREY)
      .setTitle('❓ Not a tracked wallet')
      .setDescription(`\`${wallet}\``)
      .addFields({ name: 'Tracked Wallets', value: 'No entry for this address in the imported list.' })
  }

  const chain = getChain(row.chainId)
  const hasScore = row.score !== undefined
  const positive = hasScore && row.score! >= 50

  const lines: string[] = []
  if (hasScore) lines.push(`Score: **${row.score!.toFixed(1)}**`)
  if (row.winRate30d !== undefined) lines.push(`30d win rate: **${(row.winRate30d * 100).toFixed(0)}%**`)
  if (row.totalTrades30d !== undefined) lines.push(`30d trades: ${row.totalTrades30d.toLocaleString()}`)
  if (row.totalPnlSol30d !== undefined) lines.push(`30d PnL: ${row.totalPnlSol30d.toFixed(2)} SOL`)
  if (row.avgHoldMin !== undefined) lines.push(`Avg hold: ${row.avgHoldMin.toFixed(0)}m`)
  if (row.cohort) lines.push(`Cohort: ${row.cohort}`)
  if (!row.active) lines.push('⚠️ Marked inactive by the source list')
  if (!hasScore && lines.length === 0) lines.push('Cohort-tagged, not trade-scored - see notes below.')

  const embed = new EmbedBuilder()
    .setColor(!hasScore ? GREY : positive ? GREEN : RED)
    .setTitle(`${row.favourited ? '⭐ ' : ''}${row.label ?? 'Tracked wallet'}`)
    .setDescription(`\`${wallet}\``)
    .addFields({ name: 'Tracked Wallets', value: lines.join('\n') })

  if (row.notes) embed.addFields({ name: 'Notes', value: clamp(row.notes) })

  embed.setFooter({
    text: `${chain?.label ?? row.chainId}${row.source ? ` · via ${row.source}` : ''} · imported ${formatAge(
      (Date.now() - row.importedAt.getTime()) / 60_000,
    )} ago`,
  })

  return embed
}

export function errorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder().setColor(RED).setDescription(`❌ ${message}`)
}

export function noticeEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder().setColor(GREY).setDescription(message)
}

export function successEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder().setColor(GREEN).setDescription(`✅ ${message}`)
}
