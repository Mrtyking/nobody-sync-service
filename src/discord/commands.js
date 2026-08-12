import {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('commands');

/** El comando solo tiene sentido dentro de un servidor, nunca por DM. */
function guildOnly(command) {
  if (typeof command.setContexts === 'function' && InteractionContextType) {
    return command.setContexts(InteractionContextType.Guild);
  }
  return command.setDMPermission(false);
}

export const commands = [
  guildOnly(
    new SlashCommandBuilder()
      .setName('setpanel')
      .setDescription('Publica el panel de vinculación de WhatsApp en un canal.')
      .addChannelOption((option) =>
        option
          .setName('canal')
          .setDescription('Canal donde publicar el panel. Por defecto, el canal actual.')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false),
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  ),
].map((command) => command.toJSON());

export async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  const route = config.discord.guildId
    ? Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId)
    : Routes.applicationCommands(config.discord.clientId);

  await rest.put(route, { body: commands });
  log.info(
    config.discord.guildId
      ? `Comandos registrados en el servidor ${config.discord.guildId}`
      : 'Comandos registrados globalmente (pueden tardar en propagarse)',
  );
}
