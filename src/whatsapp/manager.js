import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { Session } from './session.js';

const log = createLogger('manager');
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

/** Registro central de sesiones, una por usuario de Discord. */
class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.cleanupTimer = null;
  }

  get(discordUserId) {
    let session = this.sessions.get(discordUserId);
    if (session) return session;

    session = new Session(discordUserId);
    // Reemitimos todo hacia arriba para que la capa de Discord avise al usuario.
    for (const event of ['open', 'logout', 'replaced', 'capture', 'state', 'qr-expired']) {
      session.on(event, (...args) => this.emit(event, session, ...args));
    }
    this.sessions.set(discordUserId, session);
    return session;
  }

  /** Levanta al arrancar todas las sesiones que ya estaban vinculadas. */
  async restoreAll() {
    let ids = [];
    try {
      ids = fs
        .readdirSync(config.paths.sessions, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((id) => fs.existsSync(path.join(config.paths.sessions, id, 'creds.json')));
    } catch {
      return 0;
    }

    for (const id of ids) {
      const session = this.get(id);
      await session.loadMeta();
      session.connect().catch((error) => log.error(`No se pudo restaurar ${id}`, error));
    }

    if (ids.length) log.info(`Restaurando ${ids.length} sesión(es) de WhatsApp`);
    return ids.length;
  }

  startCleanup() {
    if (this.cleanupTimer) return;
    const run = async () => {
      for (const session of this.sessions.values()) {
        const removed = await session.media.cleanup();
        if (removed) log.info(`Limpieza: ${removed} archivo(s) caducado(s) de ${session.id}`);
      }
    };
    run().catch((error) => log.error('Limpieza inicial', error));
    this.cleanupTimer = setInterval(() => {
      run().catch((error) => log.error('Limpieza periódica', error));
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  async shutdown() {
    clearInterval(this.cleanupTimer);
    await Promise.allSettled([...this.sessions.values()].map((session) => session.stop()));
  }
}

export const manager = new SessionManager();
