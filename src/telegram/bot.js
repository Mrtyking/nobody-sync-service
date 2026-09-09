import { Bot } from 'grammy';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { manager } from '../whatsapp/manager.js';
import { registerCommands } from './commands.js';
import { handlePanelEntry, handleTerms, handleStatusCommand, routeCallback } from './interactions.js';
import { startStatusBoard, stopStatusBoard } from './statusBoard.js';
import { escapeHtml } from './views.js';

const log = createLogger('telegram');

function isTelegramSession(session) {
  return typeof session.id === 'string' && session.id.startsWith('tg-');
}

/** El id de chat privado de Telegram coincide con el id de usuario. */
function chatIdOf(session) {
  return Number(session.id.slice(3));
}

/** Arranca el bot de Telegram: comandos, botones y avisos por privado. */
export async function startTelegram() {
  const bot = new Bot(config.telegram.token);
  const startedAt = Date.now();

  async function notify(chatId, text) {
    try {
      await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (error) {
      log.debug(`No se pudo avisar a ${chatId}`, error);
    }
  }

  bot.catch((err) => {
    log.error('Fallo procesando una actualización de Telegram', err.error);
  });

  bot.command('start', handlePanelEntry);
  bot.command('panel', handlePanelEntry);
  bot.command('terms', handleTerms);
  bot.command('status', (ctx) => handleStatusCommand(ctx, bot, startedAt));
  bot.on('callback_query:data', (ctx) => routeCallback(ctx, bot, startedAt));

  manager.on('open', (session) => {
    if (!isTelegramSession(session)) return;
    notify(
      chatIdOf(session),
      `<b>${escapeHtml(config.brand.name)}</b>\nTu cuenta de WhatsApp está conectada. La sesión se mantendrá activa y se reconectará sola.`,
    );
  });

  manager.on('relink-required', (session, reason) => {
    if (!isTelegramSession(session)) return;
    notify(
      chatIdOf(session),
      [
        `<b>${escapeHtml(config.brand.name)}</b>`,
        `Tu sesión de WhatsApp dejó de estar autorizada: ${escapeHtml(reason.toLowerCase())}.`,
        '',
        'Tus archivos guardados siguen intactos. Pulsa <b>Generar código QR</b> en el panel para volver a vincular el dispositivo.',
      ].join('\n'),
    );
  });

  manager.on('replaced', (session) => {
    if (!isTelegramSession(session)) return;
    notify(
      chatIdOf(session),
      `<b>${escapeHtml(config.brand.name)}</b>\nOtra sesión tomó el control del dispositivo vinculado. Vuelve a vincularlo desde el panel si fue un error.`,
    );
  });

  manager.on('capture', (session, record) => {
    if (!isTelegramSession(session) || !config.capture.notify) return;
    const kind = { image: 'Foto', video: 'Video', audio: 'Audio' }[record.kind] ?? 'Archivo';
    const destino = record.isOwner ? 'tu chat contigo mismo' : `el chat de +${record.to.split('@')[0]}`;
    notify(
      chatIdOf(session),
      `<b>${escapeHtml(config.brand.name)}</b>\n${kind} #${record.code} guardada y enviada a ${escapeHtml(destino)}.`,
    );
  });

  await bot.init();
  log.info(`Conectado a Telegram como @${bot.botInfo.username}`);
  await registerCommands(bot);
  startStatusBoard(bot, startedAt);

  bot.start({
    onStart: () => log.info('Escuchando actualizaciones de Telegram (long polling)'),
  });

  return {
    bot,
    async shutdown() {
      stopStatusBoard();
      await bot.stop();
    },
  };
}
