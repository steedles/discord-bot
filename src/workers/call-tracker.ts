import { Events, type Client, type Message } from 'discord.js'
import { countRecentCalls, recordCall } from '../db/calls.js'
import { resolveFeature } from '../db/features.js'
import { extractFromMessage, messageText, type TokenRef } from '../discord/token-extract.js'
import { CALL_TRACKER } from '../features/registry.js'
import { log } from '../logger.js'
import { getPairsForToken, selectPricePair, type DexPair } from '../market/dexscreener.js'
import { snapshotFromPairs } from '../monitor/providers/dexscreener-source.js'
import { addCalledToken } from '../monitor/watchlist.js'

const HOUR_MS = 60 * 60_000

/** Tokens taken from one message. More than this in a message is a list, not a call. */
const MAX_PER_MESSAGE = 3

/**
 * Turns a call in a channel into a watched token.
 *
 * The address is read from the message the same way Token Brief reads it -
 * sweeping the text for address-shaped strings rather than parsing anyone's
 * layout - and every number is then our own. What this adds is a memory: the
 * price at the moment of the call, and who to come back to when it moves.
 *
 * Nothing is posted here. Following up is the monitor's job, because it is
 * already polling the watchlist this just added to; posting from both would
 * double the request cost to learn the same thing.
 */
export class CallTrackerWorker {
  private stopped = false
  private handler?: (message: Message) => void

  constructor(private readonly client: Client) {}

  start(): void {
    this.handler = (message: Message) => void this.onMessage(message)
    this.client.on(Events.MessageCreate, this.handler)
    log.monitor.info('call tracker listening for called coins')
  }

  stop(): void {
    this.stopped = true
    if (this.handler) this.client.off(Events.MessageCreate, this.handler)
  }

  private async onMessage(message: Message): Promise<void> {
    if (this.stopped) return

    try {
      // Our own follow-up quotes the contract address, so reading it back would
      // re-call the coin every time it ran.
      if (message.author.id === this.client.user?.id) return
      if (!message.guildId) return

      const resolved = await resolveFeature(CALL_TRACKER.id, message.guildId, message.channelId)
      if (!resolved?.enabled) return

      const sources = resolved.read.list('watchSources', ['bots'])
      const isBot = message.author.bot
      if (isBot && !sources.includes('bots')) return
      if (!isBot && !sources.includes('humans')) return
      if (isBot && !allowedBot(message.author.id, resolved.read.str('botAllowlist'))) return

      // Without the Message Content intent another bot's embeds arrive empty,
      // which looks identical to "nobody called anything".
      if (messageText(message).trim() === '') return

      const refs = extractFromMessage(message, MAX_PER_MESSAGE)
      if (refs.length === 0) return

      const allowedChains = resolved.read.list('chains')
      const minLiquidity = resolved.read.num('minLiquidityUsd', 5_000)
      const watchMinutes = resolved.read.num('watchMinutes', 10)
      const maxPerHour = resolved.read.num('maxCallsPerHour', 12)

      const taken = await countRecentCalls(message.channelId, Date.now() - HOUR_MS)
      if (taken >= maxPerHour) {
        log.monitor.debug(
          { channelId: message.channelId, taken, maxPerHour },
          'call ignored - channel is at its hourly ceiling',
        )
        return
      }

      const callerId = await this.callerFor(message, resolved.read.bool('tagCaller', true))

      for (const ref of refs) {
        const pairs = await resolvePairs(ref)
        if (pairs.length === 0) continue

        const priced = selectPricePair(pairs)
        if (!priced) continue
        if (allowedChains.length > 0 && !allowedChains.includes(priced.chainId)) continue

        const snapshot = snapshotFromPairs(priced.chainId, priced.baseToken.address, pairs)
        if (!snapshot?.priceUsd) continue
        if (minLiquidity > 0 && (snapshot.liquidityUsd ?? 0) < minLiquidity) continue

        const added = await addCalledToken(snapshot, message.guildId, watchMinutes)
        if (!added.ok) {
          log.monitor.info(
            { symbol: snapshot.symbol, reason: added.reason },
            'call not followed - watchlist full',
          )
          continue
        }

        const call = await recordCall({
          guildId: message.guildId,
          channelId: message.channelId,
          messageId: message.id,
          ...(callerId ? { callerId } : {}),
          chainId: snapshot.chainId,
          tokenAddress: snapshot.tokenAddress,
          pairAddress: snapshot.pairAddress,
          symbol: snapshot.symbol,
          priceAtCall: snapshot.priceUsd,
          ...(snapshot.marketCapUsd !== undefined
            ? { marketCapAtCall: snapshot.marketCapUsd }
            : {}),
          watchMinutes,
        })

        if (call) {
          log.monitor.info(
            {
              symbol: snapshot.symbol,
              chain: snapshot.chainId,
              priceAtCall: snapshot.priceUsd,
              caller: callerId ?? 'unattributed',
              via: ref.source,
              channelId: message.channelId,
            },
            'following a call',
          )
        }
      }
    } catch (err) {
      log.monitor.warn({ err: String(err) }, 'call tracker failed on a message')
    }
  }

  /**
   * Who to tag when this call moves.
   *
   * A bot's message is not a person, and tagging Rick helps nobody - so when a
   * bot made the call, credit goes to whoever it was replying to, which is the
   * person who pasted the address. When that cannot be worked out the follow-up
   * still posts, with no mention: a call worth reporting is worth reporting
   * anonymously, and guessing at a name is worse than leaving it out.
   */
  private async callerFor(message: Message, tagCaller: boolean): Promise<string | undefined> {
    if (!tagCaller) return undefined
    if (!message.author.bot) return message.author.id

    const referenced = message.reference?.messageId
    if (!referenced) return undefined

    try {
      const replied = await message.channel.messages.fetch(referenced)
      return replied.author.bot ? undefined : replied.author.id
    } catch {
      return undefined
    }
  }
}

async function resolvePairs(ref: TokenRef): Promise<DexPair[]> {
  const pairs = await getPairsForToken(ref.address)
  const scoped = ref.chainId ? pairs.filter((p) => p.chainId === ref.chainId) : pairs
  return scoped.length > 0 ? scoped : pairs
}

/** Empty allowlist means any bot; otherwise the id has to be named. */
function allowedBot(authorId: string, allowlist: string): boolean {
  const ids = allowlist
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter(Boolean)
  return ids.length === 0 || ids.includes(authorId)
}
