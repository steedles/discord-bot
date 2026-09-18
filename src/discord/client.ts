import { Client, Events, GatewayIntentBits, MessageFlags, type Interaction } from 'discord.js'
import { config } from '../config.js'
import { log } from '../logger.js'
import { commandMap } from './commands/index.js'
import { errorEmbed } from './embeds.js'
import { registerAllGuildCommands, registerGuildCommands } from './register-commands.js'

/**
 * Guilds covers slash commands. GuildMessages + MessageContent are what let
 * Token Brief read token addresses out of other bots' embeds.
 *
 * MessageContent is a PRIVILEGED intent: it must also be switched on in the
 * Discord developer portal (Bot -> Privileged Gateway Intents), or the gateway
 * refuses the connection outright. Without it, other bots' messages arrive with
 * empty content and embeds, so Token Brief would silently never fire.
 *
 * Set ENABLE_MESSAGE_CONTENT=false to run without it - every other feature
 * works fine, only Token Brief goes quiet.
 */
export function createClient(): Client {
  const intents = [GatewayIntentBits.Guilds]

  if (config.ENABLE_MESSAGE_CONTENT) {
    intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent)
  }

  const client = new Client({ intents })

  client.once(Events.ClientReady, (c) => {
    log.bot.info({ user: c.user.tag, guilds: c.guilds.cache.size }, 'discord ready')
    // Every guild, every boot: a bulk PUT of an unchanged set is a no-op for
    // Discord, and it means a guild joined while the bot was down still gets
    // its commands. See register-commands.ts for why per-guild, not global.
    void registerAllGuildCommands(c)
  })

  // The invite itself is the one step only a server admin can do. Everything
  // that follows it - the commands appearing - happens here, so an invite made
  // at 3am with nobody at a workstation still produces a working bot.
  client.on(Events.GuildCreate, (guild) => {
    log.bot.info({ guildId: guild.id, name: guild.name, members: guild.memberCount }, 'joined guild')
    void registerGuildCommands(guild.id)
  })

  client.on(Events.GuildDelete, (guild) => {
    log.bot.info({ guildId: guild.id, name: guild.name }, 'left guild')
  })

  client.on(Events.InteractionCreate, (interaction) => {
    void handleInteraction(interaction)
  })

  client.on(Events.Error, (err) => log.bot.error({ err }, 'discord client error'))
  client.on(Events.Warn, (msg) => log.bot.warn(msg))

  return client
}

async function handleInteraction(interaction: Interaction): Promise<void> {
  if (interaction.isAutocomplete()) {
    const command = commandMap.get(interaction.commandName)
    if (!command?.autocomplete) return
    try {
      await command.autocomplete(interaction)
    } catch (err) {
      log.bot.warn({ err, command: interaction.commandName }, 'autocomplete failed')
    }
    return
  }

  if (!interaction.isChatInputCommand()) return

  const command = commandMap.get(interaction.commandName)
  if (!command) {
    log.bot.warn({ command: interaction.commandName }, 'unknown command')
    return
  }

  const started = Date.now()
  try {
    await command.execute(interaction)
    log.bot.debug({ command: interaction.commandName, ms: Date.now() - started }, 'command handled')
  } catch (err) {
    log.bot.error({ err, command: interaction.commandName }, 'command failed')
    await replyWithError(interaction)
  }
}

async function replyWithError(interaction: Interaction): Promise<void> {
  if (!interaction.isRepliable()) return

  const payload = {
    embeds: [errorEmbed('Something broke handling that command. It has been logged.')],
    flags: MessageFlags.Ephemeral as const,
  }

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload)
    } else {
      await interaction.reply(payload)
    }
  } catch (err) {
    log.bot.debug({ err }, 'could not deliver error reply')
  }
}
