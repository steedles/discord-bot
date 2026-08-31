import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js'

export type AnySlashCommandBuilder =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder

export interface Command {
  data: AnySlashCommandBuilder
  execute(interaction: ChatInputCommandInteraction): Promise<void>
  autocomplete?(interaction: AutocompleteInteraction): Promise<void>
}
