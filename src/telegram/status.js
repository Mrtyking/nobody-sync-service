import os from 'node:os';
import { manager } from '../whatsapp/manager.js';
import { SessionState } from '../whatsapp/session.js';
import { processStartedAt } from '../status.js';

/**
 * Equivalente a `src/status.js` pero para el lado de Telegram: no hay un
 * websocket cuyo ping leer como en discord.js, así que se mide llamando a la
 * propia API de Telegram (getMe), igual que el ping de WhatsApp mide contra
 * los servidores de WhatsApp.
 */
async function apiPing(bot) {
  const started = Date.now();
  try {
    await bot.api.getMe();
    return Date.now() - started;
  } catch {
    return null;
  }
}

export async function collectTelegramStatus(bot, session, { roundTrip = null, startedAt } = {}) {
  const ping = await apiPing(bot);
  const telegram = {
    online: ping != null,
    ping,
    roundTrip,
    since: startedAt ?? null,
  };

  const whatsapp = {
    state: session.state,
    linked: session.isLinked(),
    needsRelink: session.needsRelink,
    online: session.state === SessionState.OPEN,
    phone: session.phone,
    ping: await session.ping(),
    since: session.connectedAt,
    linkedAt: session.linkedAt,
    lastError: session.lastError,
  };

  const memory = process.memoryUsage().rss;
  const system = {
    ...manager.counts(),
    memory,
    memoryTotal: os.totalmem(),
    node: process.version,
    since: processStartedAt(),
  };

  const health = !telegram.online
    ? 'down'
    : whatsapp.online
      ? 'ok'
      : whatsapp.needsRelink || whatsapp.linked
        ? 'warn'
        : 'idle';

  return { telegram, whatsapp, system, health, at: Date.now() };
}

/** Estado agregado del servicio, para el panel público que publica /status en un grupo. */
export async function collectTelegramServiceStatus(bot, { startedAt } = {}) {
  const ping = await apiPing(bot);
  const telegram = { online: ping != null, ping, since: startedAt ?? null };

  const counts = manager.counts();
  const onlineSessions = [...manager.sessions.values()].filter((s) => s.state === SessionState.OPEN);
  let waPing = null;
  if (onlineSessions.length) {
    const pings = (await Promise.all(onlineSessions.map((s) => s.ping()))).filter(
      (value) => typeof value === 'number',
    );
    if (pings.length) waPing = Math.round(pings.reduce((a, b) => a + b, 0) / pings.length);
  }

  const memory = process.memoryUsage().rss;
  const system = {
    memory,
    memoryTotal: os.totalmem(),
    node: process.version,
    since: processStartedAt(),
  };

  const whatsapp = { ...counts, ping: waPing, online: counts.connected > 0 };
  const health = !telegram.online
    ? 'down'
    : counts.linked > 0 && counts.connected < counts.linked
      ? 'warn'
      : 'ok';

  return { telegram, whatsapp, system, health, at: Date.now() };
}
