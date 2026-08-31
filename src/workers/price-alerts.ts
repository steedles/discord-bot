import { ObjectId } from 'mongodb'
import type { Client } from 'discord.js'
import { config } from '../config.js'
import { resolveFeature } from '../db/features.js'
import type { Alert } from '../db/models.js'
import { getCollections } from '../db/mongo.js'
import { PRICE_ALERTS } from '../features/registry.js'
import { log } from '../logger.js'
import { getPairsForTokens, priceOf, selectPricePair, type DexPair } from '../market/dexscreener.js'
import { ATTACHMENT_URL, renderCard } from '../monitor/chart-card.js'
import { CYAN, DOWN, UP } from '../analysis/chart.js'
import { alertTriggeredEmbed, noticeEmbed } from '../discord/embeds.js'
import { pingFor } from '../discord/mentions.js'

/** Consecutive failed price lookups before an alert is retired as dead. */
const MAX_ERRORS = 20

export class PriceAlertWorker {
  private timer?: NodeJS.Timeout
  private running = false
  private stopped = false

  constructor(private readonly client: Client) {}

  start(): void {
    const intervalMs = config.PRICE_POLL_SECONDS * 1_000
    log.alerts.info({ everySeconds: config.PRICE_POLL_SECONDS }, 'price alert worker started')

    this.timer = setInterval(() => void this.tick(), intervalMs)
    // Give Discord a moment to finish connecting before the first pass.
    setTimeout(() => void this.tick(), 5_000)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
  }

  /** Exposed for manual runs and tests. Skips if a previous tick is still going. */
  async tick(): Promise<void> {
    if (this.running || this.stopped) return
    this.running = true

    try {
      await this.checkAlerts()
    } catch (err) {
      log.alerts.error({ err }, 'price alert tick failed')
    } finally {
      this.running = false
    }
  }

  private async checkAlerts(): Promise<void> {
    const { alerts } = getCollections()
    const active = await alerts.find({ active: true }).toArray()
    if (active.length === 0) return

    const prices = await this.fetchPrices(active)
    const missing: ObjectId[] = []
    const resolved: ObjectId[] = []

    for (const alert of active) {
      const key = priceKey(alert.chainId, alert.tokenAddress)
      const entry = prices.get(key)

      if (!entry) {
        if (prices.size > 0) missing.push(alert._id!)
        continue
      }

      if (alert.errorCount > 0) resolved.push(alert._id!)

      const conditionMet =
        alert.direction === 'above' ? entry.price >= alert.target : entry.price <= alert.target

      if (conditionMet && alert.armed) {
        await this.fire(alert, entry.price, entry.pair)
      } else if (!conditionMet && !alert.armed && alert.repeat) {
        // Price came back to the other side - the alert can fire again.
        await alerts.updateOne({ _id: alert._id! }, { $set: { armed: true } })
      }
    }

    if (resolved.length > 0) {
      await alerts.updateMany({ _id: { $in: resolved } }, { $set: { errorCount: 0 } })
    }
    if (missing.length > 0) {
      await alerts.updateMany({ _id: { $in: missing } }, { $inc: { errorCount: 1 } })
      await this.retireDeadAlerts()
    }
  }

  /**
   * One request per unique token, not one batched request for all of them.
   * The batched endpoint caps its response at 30 pairs in total, so it returns
   * roughly one arbitrary pool per token - not enough for selectPricePair() to
   * spot a broken pool, and an alert firing off a bad price is worse than no
   * alert at all. Alerts share tokens, so this is far fewer calls than alerts.
   */
  private async fetchPrices(alerts: Alert[]): Promise<Map<string, { price: number; pair: DexPair }>> {
    const uniqueAddresses = [...new Set(alerts.map((a) => a.tokenAddress))]
    const byAddress = await getPairsForTokens(uniqueAddresses)

    const prices = new Map<string, { price: number; pair: DexPair }>()

    for (const alert of alerts) {
      const key = priceKey(alert.chainId, alert.tokenAddress)
      if (prices.has(key)) continue

      const pairs = byAddress.get(alert.tokenAddress.toLowerCase())
      if (!pairs) continue

      const pair = selectPricePair(pairs, alert.chainId)
      const price = pair ? priceOf(pair) : undefined
      if (pair && price !== undefined) prices.set(key, { price, pair })
    }

    return prices
  }

  private async fire(alert: Alert, price: number, pair: DexPair): Promise<void> {
    const { alerts } = getCollections()

    // Settings are read at fire time, not create time, so an admin turning the
    // feature off or switching to DM-only takes effect on alerts already set.
    const resolved = await resolveFeature(PRICE_ALERTS.id, alert.guildId, alert.channelId)
    const announce = resolved?.read.bool('announceToChannel', true) ?? true

    await alerts.updateOne(
      { _id: alert._id! },
      {
        $set: {
          active: alert.repeat,
          armed: false,
          lastTriggeredAt: new Date(),
        },
        $inc: { triggerCount: 1 },
      },
    )

    const embed = alertTriggeredEmbed(alert, price, pair)

    // The target the user set is exactly the level a rail is for, and an alert
    // that just fired is rare enough to justify one candle request.
    const wantsChart = resolved?.read.bool('includeChart', true) ?? true
    const card = wantsChart
      ? await renderCard({
          symbol: alert.symbol,
          chainId: alert.chainId,
          pairAddress: alert.pairAddress,
          subline: `${alert.direction} ${alert.target}`,
          priceUsd: price,
          marketCapUsd: pair?.marketCap ?? pair?.fdv,
          rails: [
            { value: alert.target, colour: CYAN, label: 'target' },
            { value: price, colour: alert.direction === 'above' ? UP : DOWN, label: 'now' },
          ],
        })
      : undefined

    if (card) embed.setImage(ATTACHMENT_URL)

    if (announce) {
      try {
        const channel = await this.client.channels.fetch(alert.channelId)
        if (channel?.isSendable()) {
          /*
           * The person who set the alert is always pinged - it is their alert -
           * and the channel's roles ride along with them. `resolved` is the
           * channel's own Price Alerts config, so a channel that names no roles
           * behaves exactly as before.
           */
          const ping = resolved
            ? pingFor(resolved.read, { extraUserIds: [alert.userId] })
            : undefined

          await channel.send({
            content: ping?.content ?? `<@${alert.userId}>`,
            allowedMentions: ping?.allowed ?? { users: [alert.userId], roles: [] },
            embeds: [embed],
            ...(card ? { files: [card.attachment] } : {}),
          })
          log.alerts.info({ symbol: alert.symbol, target: alert.target, price }, 'alert fired')
          return
        }
      } catch (err) {
        log.alerts.warn({ err, channelId: alert.channelId }, 'could not post to alert channel')
      }
    }

    // DM-only by config, or the channel is gone and we lost access.
    try {
      const user = await this.client.users.fetch(alert.userId)
      await user.send({ embeds: [embed] })
      log.alerts.info({ symbol: alert.symbol }, 'alert delivered by DM fallback')
    } catch (err) {
      log.alerts.warn({ err, userId: alert.userId }, 'alert could not be delivered')
    }
  }

  private async retireDeadAlerts(): Promise<void> {
    const { alerts } = getCollections()
    const dead = await alerts.find({ active: true, errorCount: { $gte: MAX_ERRORS } }).toArray()
    if (dead.length === 0) return

    await alerts.updateMany({ _id: { $in: dead.map((a) => a._id!) } }, { $set: { active: false } })
    log.alerts.warn({ count: dead.length }, 'retired alerts with no price data')

    for (const alert of dead) {
      try {
        const user = await this.client.users.fetch(alert.userId)
        await user.send({
          embeds: [
            noticeEmbed(
              `Your alert for **${alert.symbol}** ${alert.direction} ${alert.target} was cleared - the token has had no price data for a while.`,
            ),
          ],
        })
      } catch {
        // DMs closed; the alert is still cleared.
      }
    }
  }
}

const priceKey = (chainId: string, address: string): string => `${chainId}:${address.toLowerCase()}`
