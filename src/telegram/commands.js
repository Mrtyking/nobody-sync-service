import { createLogger } from '../utils/logger.js';

const log = createLogger('tg-commands');

const COMMANDS = [
  { command: 'start', description: 'Abrir el panel de vinculación de WhatsApp' },
  { command: 'panel', description: 'Abrir el panel de vinculación de WhatsApp' },
  { command: 'terms', description: 'Ver los términos de uso' },
  { command: 'status', description: 'Ver el estado del sistema' },
];

export async function registerCommands(bot) {
  await bot.api.setMyCommands(COMMANDS);
  log.info('Comandos registrados en Telegram');
}
