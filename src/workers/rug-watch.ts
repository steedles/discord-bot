import { Events, type Client, type Message } from 'discord.js'
import { resolveFeature } from '../db/features.js'
import { rugWatchEmbed } from '../discord/embeds.js'
import { extractFromMessage, messageText, type TokenRef } from '../discord/token-extract.js'
import { RUG_WATCH } from '../features/registry.js'
import { log } from '../logger.js'
import { getChain } from '../market/chains.js'
import { getPair, getPairsForToken, selectPricePair, type DexPair } from '../market/dexscreener.js'
import { assessToken } from '../risk/assess.js'
import type { RiskReport } from '../risk/index.js'

/** Cooldown entries kept in memory; a restart simply forgets them. */
const MAX_COOLDOWN_ENTRIES = 5_000

/**
 * Replies with an independent rug check whenever a token address shows up.
 *
 * The point is a second opinion: Rick and friends report a token's own numbers,
 * and this answers "what does a dedicated rug checker say about it" without
 * anyone having to copy the address anywhere.
 */
export class RugWatchWorker {
  private readonly recentlyChecked = new Map<string, number>()
  private stopped = false
  private handler?: (message: Message) => void

  constructor(private readonly client: Client) {}

  start(): void {
    this.handler = (message: Message) => void this.onMessage(message)
    this.client.on(Events.MessageCreate, this.handler)
    log.risk.info('rug watch listening for token addresses')
  }

  stop(): void {
    this.stopped = true
    if (this.handler) this.client.off(Events.MessageCreate, this.handler)
  }

  private async onMessage(message: Message): Promise<void> {
    if (this.stopped) return

    try {
      // Never react to ourselves - that would loop, since our own reply
      // contains the address too.
      if (message.author.id === this.client.user?.id) return
      if (!message.guildId) return

      const resolved = await resolveFeature(RUG_WATCH.id, message.guildId, message.channelId)
      if (!resolved?.enabled) return

      const sources = resolved.read.list('watchSources', ['bots'])
      const isBot = message.author.bot
      if (isBot && !sources.includes('bots')) return
      if (!isBot && !sources.includes('humans')) return

      if (isBot && !this.allowedBot(message.author.id, resolved.read.str('botAllowlist'))) return

      // Without the Message Content intent, other bots' embeds arrive empty.
      // Say so once rather than failing silently and looking broken.
      const text = messageText(message)
      if (text.trim() === '') {
        this.warnEmptyOnce(message)
        return
      }

      const limit = resolved.read.num('maxTokensPerMessage', 2)
      const refs = extractFromMessage(message, 5)
      if (refs.length === 0) return

      const allowedChains = resolved.read.list('chains')
      const cooldownMs = resolved.read.num('cooldownMinutes', 10) * 60_000
      const minRisk = resolved.read.num('minRiskToReply', 0)
      const showMarket = resolved.read.bool('showMarketData', true)
      const inline = resolved.read.bool('replyToMessage', true)

      let posted = 0

      for (const ref of refs) {
        if (posted >= limit) break

        const found = await this.lookup(ref)
        if (!found) continue

        const { pair } = found
        if (allowedChains.length > 0 && !allowedChains.includes(pair.chainId)) continue

        const key = `${message.channelId}:${pair.chainId}:${pair.baseToken.address.toLowerCase()}`
        if (this.onCooldown(key, cooldownMs)) continue

        const report = await assessToken(pair)

        // An unknown verdict still matters here - somebody asked about this
        // token and "nobody can vouch for it" is a real answer.
        if (report.level !== 'unknown' && report.score < minRisk) continue

        this.remember(key)
        await this.reply(message, pair, report, ref, showMarket, inline)
        posted += 1
      }
    } catch (err) {
      log.risk.warn({ err: String(err) }, 'rug watch failed on a message')
    }
  }

  /**
   * Turns a reference into a real pair. Links often carry the pool address
   * rather than the token, so a failed token lookup retries it as a pair.
   */
  private async lookup(ref: TokenRef): Promise<{ pair: DexPair } | undefined> {
    const pairs = await getPairsForToken(ref.address)
    const scoped = ref.chainId ? pairs.filter((p) => p.chainId === ref.chainId) : pairs
    const asToken = selectPricePair(scoped.length > 0 ? scoped : pairs)
    if (asToken) return { pair: asToken }

    if (ref.mayBePair && ref.chainId) {
      const pair = await getPair(ref.chainId, ref.address)
      if (pair) return { pair }
    }

    return undefined
  }

  private allowedBot(authorId: string, allowlist: string): boolean {
    const ids = allowlist
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    return ids.length === 0 || ids.includes(authorId)
  }

  private onCooldown(key: string, cooldownMs: number): boolean {
    if (cooldownMs <= 0) return false
    const last = this.recentlyChecked.get(key)
    return last !== undefined && Date.now() - last < cooldownMs
  }

  private remember(key: string): void {
    if (this.recentlyChecked.size >= MAX_COOLDOWN_ENTRIES) {
      const oldest = this.recentlyChecked.keys().next().value
      if (oldest !== undefined) this.recentlyChecked.delete(oldest)
    }
    this.recentlyChecked.set(key, Date.now())
  }

  private async reply(
    message: Message,
    pair: DexPair,
    report: RiskReport,
    ref: TokenRef,
    showMarket: boolean,
    inline: boolean,
  ): Promise<void> {
    const embed = rugWatchEmbed(pair, report, ref.source, showMarket)

    try {
      if (inline && message.channel.isSendable()) {
        await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } })
      } else if (message.channel.isSendable()) {
        await message.channel.send({ embeds: [embed] })
      }

      log.risk.info(
        {
          symbol: pair.baseToken.symbol,
          chain: pair.chainId,
          score: report.score,
          level: report.level,
          via: ref.source,
          trigger: message.author.username,
        },
        'rug watch replied',
      )
    } catch (err) {
      log.risk.warn({ err: String(err), channelId: message.channelId }, 'rug watch could not reply')
    }
  }

  private warnedEmpty = false

  /**
   * An empty message body from another bot almost always means the Message
   * Content intent is off. Worth saying loudly once.
   */
  private warnEmptyOnce(message: Message): void {
    if (this.warnedEmpty || !message.author.bot) return
    this.warnedEmpty = true
    log.risk.warn(
      { bot: message.author.username },
      'Rug Watch saw a bot message with no readable content or embeds. ' +
        'Enable the MESSAGE CONTENT INTENT: Discord portal -> your app -> Bot -> ' +
        'Privileged Gateway Intents -> Message Content Intent, then restart.',
    )
  }
}

/** Exposed so the chain label helper stays in one place. */
export const chainLabel = (chainId: string): string => getChain(chainId)?.label ?? chainId
