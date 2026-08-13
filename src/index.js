import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { assertConfig, config, ensureDirs } from './config.js';
import { installConsoleFilter } from './utils/console.js';
import { createLogger, log } from './utils/logger.js';
import { registerCommands } from './discord/commands.js';
import { routeInteraction } from './discord/interactions.js';
import { manager } from './whatsapp/manager.js';

const dm = createLogger('aviso');

// Antes de tocar nada de WhatsApp: libsignal escribe en consola por su cuenta.
installConsoleFilter({ verbose: config.logLevel === 'debug' });

try {
  assertConfig();
  ensureDirs();
} catch (error) {
  log.error(error.message);
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

/** Aviso privado en Discord; si el usuario tiene los DM cerrados, se ignora. */
async function notify(userId, text) {
  try {
    const user = await client.users.fetch(userId);
    await user.send({ content: text, allowedMentions: { parse: [] } });
  } catch (error) {
    dm.debug(`No se pudo avisar a ${userId}`, error);
  }
}

manager.on('open', (session) => {
  notify(
    session.id,
    `**${config.brand.name}**\nTu cuenta de WhatsApp está conectada. La sesión se mantendrá activa y se reconectará sola.`,
  );
});

manager.on('relink-required', (session, reason) => {
  notify(
    session.id,
    [
      `**${config.brand.name}**`,
      `Tu sesión de WhatsApp dejó de estar autorizada: ${reason.toLowerCase()}.`,
      '',
      'Tus archivos guardados siguen intactos. Pulsa **Generar código QR** en el panel para volver a vincular el dispositivo.',
    ].join('\n'),
  );
});

manager.on('replaced', (session) => {
  notify(
    session.id,
    `**${config.brand.name}**\nOtra sesión tomó el control del dispositivo vinculado. Vuelve a vincularlo desde el panel si fue un error.`,
  );
});

if (config.capture.notify) {
  manager.on('capture', (session, record) => {
    const kind = { image: 'Foto', video: 'Video', audio: 'Audio' }[record.kind] ?? 'Archivo';
    const destino = record.isOwner ? 'tu chat contigo mismo' : `el chat de +${record.to.split('@')[0]}`;
    notify(session.id, `**${config.brand.name}**\n${kind} de una sola vez guardada y enviada a ${destino}.`);
  });
}

client.once(Events.ClientReady, async (ready) => {
  log.info(`Conectado a Discord como ${ready.user.tag}`);
  if (config.logLevel !== 'debug') {
    log.info('Avisos internos de cifrado resumidos · BAILEYS_LOG_LEVEL=debug para verlos enteros');
  }
  try {
    await registerCommands();
  } catch (error) {
    log.error('No se pudieron registrar los comandos', error);
  }
  manager.startCleanup();
  await manager.restoreAll();
});

client.on(Events.InteractionCreate, (interaction) => {
  routeInteraction(interaction).catch((error) => log.error('Interacción', error));
});

client.on(Events.Error, (error) => log.error('Cliente de Discord', error));

// Con el mensaje suelto no hay forma de saber de dónde salió; la primera línea
// de la pila basta para ubicarlo sin llenar la consola.
function describe(error) {
  const where = error?.stack?.split('\n')[1]?.trim();
  return where ? `${error.message ?? error} · ${where}` : String(error?.message ?? error);
}

process.on('unhandledRejection', (error) => log.error('Promesa sin capturar', describe(error)));
process.on('uncaughtException', (error) => log.error('Excepción sin capturar', describe(error)));

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  log.info(`Cerrando (${signal})`);
  await manager.shutdown();
  await client.destroy();
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    shutdown(signal).catch(() => process.exit(1));
  });
}

client.login(config.discord.token).catch(async (error) => {
  log.error(`No se pudo iniciar sesión en Discord: ${error.message}`);
  log.error('Revisa DISCORD_TOKEN en las variables de entorno.');
  // Cerrar el cliente antes de salir: un process.exit() en mitad del cierre del
  // websocket revienta libuv en Windows.
  process.exitCode = 1;
  await client.destroy().catch(() => {});
});
