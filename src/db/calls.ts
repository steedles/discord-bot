import { ObjectId } from 'mongodb'
import type { TokenCall } from './models.js'
import { getCollections } from './mongo.js'
import { log } from '../logger.js'

/**
 * Calls made in a channel, and their follow-up state.
 *
 * A call is stored per message rather than per token: the same coin called in
 * two channels is two calls, each measured from its own price and each answered
 * where it was made.
 */

export interface RecordCallInput {
  guildId: string
  channelId: string
  messageId: string
  callerId?: string
  chainId: string
  tokenAddress: string
  pairAddress: string
  symbol: string
  priceAtCall: number
  marketCapAtCall?: number
  /** How long the follow-up may run, before the row is cleaned up. */
  watchMinutes: number
}

/**
 * Writes down a call. Returns undefined when this message already produced one,
 * which is what makes an edited or re-delivered message harmless.
 */
export async function recordCall(
  input: RecordCallInput,
  now = new Date(),
): Promise<TokenCall | undefined> {
  const { tokenCalls } = getCollections()

  const filter = {
    messageId: input.messageId,
    chainId: input.chainId,
    tokenAddress: input.tokenAddress,
  }

  try {
    const existing = await tokenCalls.findOne(filter)
    if (existing) return undefined

    // Kept well past the follow-up window so `/monitor status` and any later
    // "how did that call do" question still have it.
    const expiresAt = new Date(now.getTime() + Math.max(60, input.watchMinutes * 6) * 60_000)

    const call: TokenCall = {
      guildId: input.guildId,
      channelId: input.channelId,
      messageId: input.messageId,
      ...(input.callerId ? { callerId: input.callerId } : {}),
      chainId: input.chainId,
      tokenAddress: input.tokenAddress,
      pairAddress: input.pairAddress,
      symbol: input.symbol,
      priceAtCall: input.priceAtCall,
      ...(input.marketCapAtCall !== undefined ? { marketCapAtCall: input.marketCapAtCall } : {}),
      calledAt: now,
      alerted: [],
      expiresAt,
    }

    const result = await tokenCalls.insertOne(call)
    return { ...call, _id: result.insertedId }
  } catch (err) {
    // The unique index is the real guard against a double insert; losing that
    // race is a duplicate call, not an error worth surfacing.
    log.monitor.debug({ err: String(err), token: input.tokenAddress }, 'could not record call')
    return undefined
  }
}

/** Every call still being followed. */
export async function openCalls(): Promise<TokenCall[]> {
  const { tokenCalls } = getCollections()
  return tokenCalls.find({ closedAt: { $exists: false } }).toArray()
}

/** Calls still open for one token, across every channel that called it. */
export async function openCallsFor(chainId: string, tokenAddress: string): Promise<TokenCall[]> {
  const { tokenCalls } = getCollections()
  return tokenCalls.find({ chainId, tokenAddress, closedAt: { $exists: false } }).toArray()
}

/** Records that a multiple has been announced, so it is not announced again. */
export async function markCallAlerted(id: ObjectId, multiple: number): Promise<void> {
  const { tokenCalls } = getCollections()
  await tokenCalls.updateOne({ _id: id }, { $addToSet: { alerted: multiple } })
}

export async function closeCall(id: ObjectId, reason: string, now = new Date()): Promise<void> {
  const { tokenCalls } = getCollections()
  await tokenCalls.updateOne({ _id: id }, { $set: { closedAt: now, closedReason: reason } })
}

/** How many calls this channel has taken on recently, for the per-hour ceiling. */
export async function countRecentCalls(channelId: string, sinceMs: number): Promise<number> {
  const { tokenCalls } = getCollections()
  return tokenCalls.countDocuments({ channelId, calledAt: { $gte: new Date(sinceMs) } })
}
