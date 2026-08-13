import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { Session, SessionState } from './session.js';

const log = createLogger('manager');
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000;
/** Separación entre reconexiones al arrancar, para no golpear a WhatsApp de golpe. */
const RESTORE_STAGGER_MS = 1_500;

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
    for (const event of ['open', 'relink-required', 'replaced', 'capture', 'state', 'qr-expired']) {
      session.on(event, (...args) => this.emit(event, session, ...args));
    }
    this.sessions.set(discordUserId, session);
    return session;
  }

  /** Ids con credenciales guardadas en disco. */
  #storedIds() {
    try {
      return fs
        .readdirSync(config.paths.sessions, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((id) => fs.existsSync(path.join(config.paths.sessions, id, 'creds.json')));
    } catch {
      return [];
    }
  }

  /** Levanta al arrancar todas las sesiones que ya estaban vinculadas. */
  async restoreAll() {
    const ids = this.#storedIds();
    if (!ids.length) return 0;

    let restored = 0;
    let pending = 0;
    for (const id of ids) {
      const session = this.get(id);
      await session.ensureMeta();
      if (!session.isLinked()) {
        pending += 1; // esperando a que su dueño escanee otro código
        continue;
      }
      // Escalonadas: varias cuentas reconectando a la vez es una forma rápida
      // de que WhatsApp empiece a rechazar sesiones.
      const delay = restored * RESTORE_STAGGER_MS;
      restored += 1;
      setTimeout(() => {
        session.connect().catch((error) => log.error(`No se pudo restaurar ${id}`, error));
      }, delay).unref?.();
    }

    log.info(
      `Restaurando ${restored} sesión(es) de WhatsApp${pending ? ` · ${pending} pendiente(s) de revincular` : ''}`,
    );
    return restored;
  }

  /** Cuentas vinculadas, en línea y pendientes de volver a escanear. */
  counts() {
    let linked = 0;
    let connected = 0;
    let relink = 0;
    for (const id of this.#storedIds()) {
      const session = this.sessions.get(id);
      if (session?.needsRelink) {
        relink += 1;
        continue;
      }
      linked += 1;
      if (session?.state === SessionState.OPEN) connected += 1;
    }
    return { linked, connected, relink };
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
