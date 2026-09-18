import { REST, Routes, type Client } from 'discord.js'
import { config } from '../config.js'
import { log } from '../logger.js'
import { commands } from './commands/index.js'

/**
 * Registers the slash commands with one guild, so they appear there instantly.
 *
 * The bot registers per guild rather than globally, and does it itself: on
 * ready for every guild it is in, and again the moment it joins a new one. A
 * global registration would take Discord up to an hour to fan out and would
 * double up alongside any guild-scoped set, and a `pnpm commands:deploy` run
 * from a workstation needs someone at the workstation - which is exactly what
 * the Setup tab exists to remove. A bulk PUT of an unchanged set is a no-op on
 * Discord's side, so doing it on every boot costs one request per guild.
 *
 * The one way this fails is an invite that lacked the `applications.commands`
 * scope - the `bot` scope alone lets the bot in but not its commands. Discord
 * answers 403 "Missing Access", which is surfaced as that rather than as a
 * generic failure, because the fix is a re-invite and nothing on this side.
 */

export interface RegisterOutcome {
  ok: boolean
  count: number
  detail: string
}

export async function registerGuildCommands(guildId: string): Promise<RegisterOutcome> {
  const body = commands.map((c) => c.data.toJSON())
  const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN)

  try {
    await rest.put(Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, guildId), { body })
    log.bot.info({ guildId, count: body.length }, 'slash commands registered')
    return { ok: true, count: body.length, detail: `${body.length} commands registered` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const missingScope = /Missing Access/i.test(message)
    log.bot.warn({ err, guildId }, 'slash command registration failed')
    return {
      ok: false,
      count: 0,
      detail: missingScope
        ? 'Discord refused: the invite did not include the applications.commands scope. Re-invite the bot with the link in the setup guide.'
        : message,
    }
  }
}

/** Every guild the bot is in, sequentially - a handful of guilds, no need to race them. */
export async function registerAllGuildCommands(client: Client): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    await registerGuildCommands(guild.id)
  }
}

/**
 * How many commands Discord currently holds for a guild. The Setup tab shows
 * this against the number the bot ships so a missing scope is visible before
 * anyone types `/price` into an empty picker.
 */
export async function countGuildCommands(client: Client, guildId: string): Promise<number | undefined> {
  const guild = client.guilds.cache.get(guildId)
  if (!guild) return undefined
  try {
    const registered = await guild.commands.fetch()
    return registered.size
  } catch (err) {
    log.bot.debug({ err, guildId }, 'could not fetch guild commands')
    return undefined
  }
}

export const shippedCommandCount = (): number => commands.length
