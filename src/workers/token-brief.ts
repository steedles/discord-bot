import { Events, type Client, type Message } from 'discord.js'
import { buildBrief } from '../analysis/brief.js'
import { resolveFeature } from '../db/features.js'
import { tokenBriefEmbed } from '../discord/embeds.js'
import { extractFromMessage, messageText, type TokenRef } from '../discord/token-extract.js'
import { TOKEN_BRIEF } from '../features/registry.js'
import { log } from '../logger.js'
import { getPair, getPairsForToken, selectPricePair, type DexPair } from '../market/dexscreener.js'
import { assessToken } from '../risk/assess.js'
import { getHolderProfile } from '../risk/holders.js'

/** Cooldown entries kept in memory; a restart simply forgets them. */
const MAX_COOLDOWN_ENTRIES = 5_000

/** Snowflakes are 17-20 digits today, but the range has grown before. */
const SNOWFLAKE = /^\d{15,25}$/

/**
 * Reads token addresses out of the channel and answers with a plain-English
 * brief - in the channel by default, or by DM.
 *
 * The address is taken from the message; every number in the brief is then
 * fetched from our own providers. It never parses Rick's layout - that format is
 * undocumented and changes, and re-deriving the numbers means the brief stays
 * right when Rick's next redesign ships. It also means the brief can say things
 * Rick does not, and can be honest about what nobody checked.
 */
export class TokenBriefWorker {
  private readonly recentlyBriefed = new Map<string, number>()
  private stopped = false
  private handler?: (message: Message) => void

  constructor(private readonly client: Client) {}

  start(): void {
    this.handler = (message: Message) => void this.onMessage(message)
    this.client.on(Events.MessageCreate, this.handler)
    log.brief.info('token brief listening for token addresses')
  }

  stop(): void {
    this.stopped = true
    if (this.handler) this.client.off(Events.MessageCreate, this.handler)
  }

  private async onMessage(message: Message): Promise<void> {
    if (this.stopped) return

    try {
      // Our own brief quotes the contract address, so reading it back would
      // brief the brief, forever.
      if (message.author.id === this.client.user?.id) return
      if (!message.guildId) return

      const resolved = await resolveFeature(TOKEN_BRIEF.id, message.guildId, message.channelId)
      if (!resolved?.enabled) return

      const sources = resolved.read.list('watchSources', ['bots'])
      const isBot = message.author.bot
      if (isBot && !sources.includes('bots')) return
      if (!isBot && !sources.includes('humans')) return
      if (isBot && !allowedBot(message.author.id, resolved.read.str('botAllowlist'))) return

      const delivery = resolved.read.str('delivery', 'channel') === 'dm' ? 'dm' : 'channel'

      // Work out who is listening before spending anything on providers.
      const recipients =
        delivery === 'dm'
          ? this.recipientsFor(
              resolved.read.str('recipients'),
              resolved.instance?.updatedBy,
              message.guildId,
            )
          : []
      if (delivery === 'dm' && recipients.length === 0) return
      if (delivery === 'channel' && !message.channel.isSendable()) return

      // Without the Message Content intent, other bots' embeds arrive empty.
      // Say so once rather than failing silently and looking broken.
      if (messageText(message).trim() === '') {
        this.warnEmptyOnce(message)
        return
      }

      const refs = extractFromMessage(message, 5)
      if (refs.length === 0) return

      const limit = resolved.read.num('maxTokensPerMessage', 1)
      const allowedChains = resolved.read.list('chains')
      const minLiquidity = resolved.read.num('minLiquidityUsd', 0)
      const cooldownMs = resolved.read.num('cooldownMinutes', 30) * 60_000
      const detail = resolved.read.str('detail', 'full') === 'short' ? 'short' : 'full'
      const inline = resolved.read.bool('replyToMessage', true)

      let sent = 0

      for (const ref of refs) {
        if (sent >= limit) break

        const found = await lookup(ref)
        if (!found) continue

        const { pair, siblings } = found
        if (allowedChains.length > 0 && !allowedChains.includes(pair.chainId)) continue
        if (minLiquidity > 0 && (pair.liquidity?.usd ?? 0) < minLiquidity) continue

        const key = `${message.channelId}:${pair.chainId}:${pair.baseToken.address.toLowerCase()}`
        if (this.onCooldown(key, cooldownMs)) continue
        this.remember(key)

        // Both calls hit different vendors, so there is nothing to serialise.
        const [report, holders] = await Promise.all([
          assessToken(pair),
          getHolderProfile(pair.chainId, pair.baseToken.address),
        ])

        const brief = buildBrief(pair, report, holders, poolDepth(siblings))
        const embed = tokenBriefEmbed(brief, pair, report, {
          poster: message.author.username,
          channelId: message.channelId,
          via: ref.source,
          jumpUrl: message.url,
          detail,
          delivery,
        })

        const delivered =
          delivery === 'dm'
            ? await this.dmAll(recipients, embed)
            : await this.post(message, embed, inline)
        sent += 1

        log.brief.info(
          {
            symbol: pair.baseToken.symbol,
            chain: pair.chainId,
            level: report.level,
            via: ref.source,
            trigger: message.author.username,
            delivery,
            delivered,
          },
          'token brief sent',
        )
      }
    } catch (err) {
      log.brief.warn({ err: String(err) }, 'token brief failed on a message')
    }
  }

  /**
   * Explicit IDs win; otherwise the brief goes to whoever configured the
   * feature. That fallback is what makes `/feature enable token-brief` work on
   * its own - the alternative is a feature that looks on but silently sends
   * nothing until someone finds the dashboard.
   */
  private recipientsFor(setting: string, configuredBy: string | undefined, guildId: string): string[] {
    const listed = setting
      .split(',')
      .map((s) => s.trim())
      .filter((s) => SNOWFLAKE.test(s))

    if (listed.length > 0) return listed
    if (configuredBy && SNOWFLAKE.test(configuredBy)) return [configuredBy]

    this.warnNoRecipientOnce(guildId)
    return []
  }

  /** Returns 1 on success, so both delivery paths report the same shape. */
  private async post(
    message: Message,
    embed: ReturnType<typeof tokenBriefEmbed>,
    inline: boolean,
  ): Promise<number> {
    if (!message.channel.isSendable()) return 0

    try {
      if (inline) {
        // repliedUser: false - the brief is information, not a summons.
        await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } })
      } else {
        await message.channel.send({ embeds: [embed] })
      }
      return 1
    } catch (err) {
      log.brief.warn({ err: String(err), channelId: message.channelId }, 'token brief could not post')
      return 0
    }
  }

  private async dmAll(recipients: string[], embed: ReturnType<typeof tokenBriefEmbed>): Promise<number> {
    let delivered = 0

    for (const userId of recipients) {
      try {
        const user = await this.client.users.fetch(userId)
        await user.send({ embeds: [embed] })
        delivered += 1
      } catch (err) {
        this.warnDmBlockedOnce(userId, err)
      }
    }

    return delivered
  }

  private onCooldown(key: string, cooldownMs: number): boolean {
    if (cooldownMs <= 0) return false
    const last = this.recentlyBriefed.get(key)
    return last !== undefined && Date.now() - last < cooldownMs
  }

  private remember(key: string): void {
    if (this.recentlyBriefed.size >= MAX_COOLDOWN_ENTRIES) {
      const oldest = this.recentlyBriefed.keys().next().value
      if (oldest !== undefined) this.recentlyBriefed.delete(oldest)
    }
    this.recentlyBriefed.set(key, Date.now())
  }

  private warnedEmpty = false
  private readonly warnedGuilds = new Set<string>()
  private readonly warnedUsers = new Set<string>()

  /**
   * An empty message body from another bot almost always means the Message
   * Content intent is off. Worth saying loudly once.
   */
  private warnEmptyOnce(message: Message): void {
    if (this.warnedEmpty || !message.author.bot) return
    this.warnedEmpty = true
    log.brief.warn(
      { bot: message.author.username },
      'Token Brief saw a bot message with no readable content or embeds. ' +
        'Enable the MESSAGE CONTENT INTENT: Discord portal -> your app -> Bot -> ' +
        'Privileged Gateway Intents -> Message Content Intent, then restart.',
    )
  }

  private warnNoRecipientOnce(guildId: string): void {
    if (this.warnedGuilds.has(guildId)) return
    this.warnedGuilds.add(guildId)
    log.brief.warn(
      { guildId },
      'Token Brief is on but has nobody to DM. Set "Who gets the DM" on the dashboard, ' +
        'or re-run /feature enable token-brief so the brief goes to you.',
    )
  }

  private warnDmBlockedOnce(userId: string, err: unknown): void {
    if (this.warnedUsers.has(userId)) return
    this.warnedUsers.add(userId)
    log.brief.warn(
      { userId, err: String(err) },
      'Token Brief could not DM this user. Discord blocks bot DMs unless the user allows ' +
        'direct messages from server members (User Settings -> Content & Social -> Direct Messages).',
    )
  }
}

function allowedBot(authorId: string, allowlist: string): boolean {
  const ids = allowlist
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return ids.length === 0 || ids.includes(authorId)
}

/**
 * Turns a reference into a real pair, plus every other pool the token trades in
 * on that chain - the brief measures depth against all of them, not just the one
 * it quotes from.
 *
 * Links often carry the pool address rather than the token, so a failed token
 * lookup retries it as a pair.
 */
async function lookup(ref: TokenRef): Promise<{ pair: DexPair; siblings: DexPair[] } | undefined> {
  const pairs = await getPairsForToken(ref.address)
  const scoped = ref.chainId ? pairs.filter((p) => p.chainId === ref.chainId) : pairs
  const candidates = scoped.length > 0 ? scoped : pairs
  const asToken = selectPricePair(candidates)
  if (asToken) return { pair: asToken, siblings: candidates.filter((p) => p.chainId === asToken.chainId) }

  if (ref.mayBePair && ref.chainId) {
    const pair = await getPair(ref.chainId, ref.address)
    // A pair lookup sees one pool by definition, so it is its own sibling list.
    if (pair) return { pair, siblings: [pair] }
  }

  return undefined
}

/**
 * Total depth and turnover behind a token, and how thinly it is spread.
 *
 * DexScreener caps a token query at 30 pairs, so a token with more pools than
 * that is undercounted here. That errs towards making a token look thinner than
 * it is, which is the safe direction - and batching addresses to get more back
 * makes it far worse, not better (see getPairsForToken).
 */
export function poolDepth(pairs: DexPair[]): {
  totalLiquidityUsd?: number
  totalVolume24hUsd?: number
  poolCount?: number
} {
  const priced = pairs.filter((p) => (p.liquidity?.usd ?? 0) > 0)
  if (priced.length === 0) return {}

  return {
    totalLiquidityUsd: priced.reduce((sum, p) => sum + (p.liquidity?.usd ?? 0), 0),
    totalVolume24hUsd: priced.reduce((sum, p) => sum + (p.volume?.h24 ?? 0), 0),
    poolCount: priced.length,
  }
}
