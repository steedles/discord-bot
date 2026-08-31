import type { Client } from 'discord.js'
import { config } from '../config.js'
import { monitorStatusEmbed } from '../discord/embeds.js'
import { getChain } from '../market/chains.js'
import { log } from '../logger.js'
import type { ProviderHealth } from './providers/types.js'

/**
 * Operator-facing health reporting.
 *
 * Reports **transitions**, not states. A provider that has been down for six
 * hours does not need saying every minute, and a channel that repeats itself is
 * one people stop reading - which defeats the point of having it. Recovery is
 * reported too: "it went down" without "it came back" leaves an operator
 * chasing a problem that fixed itself.
 */
export class StatusReporter {
  /** Last state actually announced per chain. Absent means never announced. */
  private readonly announced = new Map<string, boolean>()

  constructor(private readonly client: Client) {}

  get enabled(): boolean {
    return Boolean(config.MONITOR_STATUS_CHANNEL_ID)
  }

  /** Announces what changed since the last call. */
  async report(healths: ProviderHealth[]): Promise<void> {
    if (!this.enabled) return

    const nowBroken: ProviderHealth[] = []
    const nowFixed: ProviderHealth[] = []

    for (const health of healths) {
      const previous = this.announced.get(health.chainId)

      // Nothing to announce about a chain that has always been fine.
      if (previous === undefined) {
        if (health.healthy) {
          this.announced.set(health.chainId, true)
          continue
        }
        this.announced.set(health.chainId, false)
        nowBroken.push(health)
        continue
      }

      if (previous === health.healthy) continue

      this.announced.set(health.chainId, health.healthy)
      ;(health.healthy ? nowFixed : nowBroken).push(health)
    }

    if (nowBroken.length > 0) {
      await this.send(
        `${nowBroken.length} data source${nowBroken.length === 1 ? '' : 's'} failing`,
        nowBroken.map(
          (h) =>
            `**${label(h.chainId)}** — ${h.consecutiveFailures} consecutive failures. ${h.lastError ?? 'no error recorded'}`,
        ),
        'problem',
      )
    }

    if (nowFixed.length > 0) {
      await this.send(
        `${nowFixed.length} data source${nowFixed.length === 1 ? '' : 's'} recovered`,
        nowFixed.map((h) => `**${label(h.chainId)}** — answering again.`),
        'ok',
      )
    }
  }

  /** One-off summary of what whale detection can actually do, posted at startup. */
  async reportCapabilities(healths: ProviderHealth[]): Promise<void> {
    if (!this.enabled) return

    const live = healths.filter((h) => h.whaleSupport !== 'unsupported')
    const off = healths.filter((h) => h.whaleSupport === 'unsupported')

    await this.send(
      'Volume monitor started',
      [
        live.length > 0
          ? `**Whale detection live:** ${live.map((h) => `${label(h.chainId)} (${h.whaleSupport})`).join(', ')}`
          : '**Whale detection: nothing configured.** Spike and momentum alerts still work everywhere.',
        ...(off.length > 0
          ? [
              '',
              '**No per-transaction data on:**',
              ...off.map((h) => `• ${label(h.chainId)} — ${h.whaleNote ?? 'unsupported'}`),
            ]
          : []),
      ],
      live.length > 0 ? 'ok' : 'problem',
    )
  }

  private async send(headline: string, lines: string[], level: 'ok' | 'problem'): Promise<void> {
    const channelId = config.MONITOR_STATUS_CHANNEL_ID
    if (!channelId) return

    try {
      const channel = await this.client.channels.fetch(channelId)
      if (!channel?.isSendable()) {
        log.monitor.warn({ channelId }, 'monitor status channel is not writable')
        return
      }
      await channel.send({ embeds: [monitorStatusEmbed(headline, lines, level)] })
    } catch (err) {
      // Failing to report a failure must not become a second failure.
      log.monitor.warn({ err: String(err), channelId }, 'could not post monitor status')
    }
  }
}

function label(chainId: string): string {
  return getChain(chainId)?.label ?? chainId
}
