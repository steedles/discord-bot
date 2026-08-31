/**
 * Registers slash commands with Discord.
 *
 *   pnpm commands:deploy    register (guild-scoped if DISCORD_GUILD_ID is set)
 *   pnpm commands:clear     remove every registered command
 */
import { REST, Routes } from 'discord.js'
import { config } from '../config.js'
import { commands } from '../discord/commands/index.js'
import { logger } from '../logger.js'

async function main(): Promise<void> {
  const clear = process.argv.includes('--clear')
  const body = clear ? [] : commands.map((c) => c.data.toJSON())

  const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN)

  const route = config.DISCORD_GUILD_ID
    ? Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID)
    : Routes.applicationCommands(config.DISCORD_CLIENT_ID)

  const scope = config.DISCORD_GUILD_ID ? `guild ${config.DISCORD_GUILD_ID}` : 'globally'

  await rest.put(route, { body })

  if (clear) {
    logger.info(`Cleared all commands ${scope}.`)
  } else {
    logger.info(`Registered ${body.length} commands ${scope}: ${commands.map((c) => `/${c.data.name}`).join(' ')}`)
    if (!config.DISCORD_GUILD_ID) {
      logger.warn('Global commands can take up to an hour to appear. Set DISCORD_GUILD_ID for instant updates.')
    }
  }
}

main().catch((err) => {
  logger.error({ err }, 'command deployment failed')
  process.exit(1)
})
