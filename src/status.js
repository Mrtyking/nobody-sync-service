import os from 'node:os';
import { manager } from './whatsapp/manager.js';
import { SessionState } from './whatsapp/session.js';

/** Arranque real del proceso, sin depender del orden de importación. */
export function processStartedAt() {
  return Date.now() - Math.round(process.uptime() * 1000);
}

/**
 * Reúne el estado real de las dos mitades del sistema: la conexión con Discord
 * y la conexión con WhatsApp, cada una con su latencia medida en el momento.
 */
export async function collectStatus(client, session, { roundTrip = null } = {}) {
  const wsPing = Math.round(client.ws?.ping ?? -1);
  const discord = {
    online: client.isReady?.() ?? false,
    // client.ws.ping vale -1 hasta el primer heartbeat completo.
    ping: wsPing >= 0 ? wsPing : null,
    roundTrip,
    guilds: client.guilds?.cache?.size ?? 0,
    since: client.readyTimestamp ?? null,
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

  // Verde solo si las dos mitades responden; ámbar si Discord está y WhatsApp no.
  const health = !discord.online
    ? 'down'
    : whatsapp.online
      ? 'ok'
      : whatsapp.needsRelink || whatsapp.linked
        ? 'warn'
        : 'idle';

  return { discord, whatsapp, system, health, at: Date.now() };
}
