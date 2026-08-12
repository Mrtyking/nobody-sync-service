import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { createLogger, waLogger } from '../utils/logger.js';
import {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  makeWASocket,
  S_WHATSAPP_NET,
  useMultiFileAuthState,
} from './baileys.js';
import { MediaStore } from './mediaStore.js';
import { MessageCache } from './messageCache.js';
import { handleUpsert } from './viewOnce.js';

const log = createLogger('wa');

export const SessionState = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  QR: 'qr',
  OPEN: 'open',
  CLOSED: 'closed',
};

/** Códigos tras los que no tiene sentido reintentar: hay que volver a escanear. */
const FATAL = new Set([
  DisconnectReason.loggedOut,
  DisconnectReason.badSession,
  DisconnectReason.forbidden,
  DisconnectReason.multideviceMismatch,
  401,
  403,
  405,
]);

const MAX_SEEN_REACTIONS = 500;

/**
 * Una sesión = una cuenta de WhatsApp vinculada por un usuario de Discord.
 * Se reconecta sola indefinidamente mientras existan credenciales válidas,
 * que es lo que mantiene el bot "conectado siempre".
 */
export class Session extends EventEmitter {
  #connecting = null;
  #retryTimer = null;

  constructor(id) {
    super();
    this.id = id;
    this.dir = path.join(config.paths.sessions, id);
    this.media = new MediaStore(id);
    this.messages = new MessageCache();
    this.state = SessionState.IDLE;
    this.sock = null;
    this.qr = null;
    this.qrExpiresAt = 0;
    this.ownerJid = null;
    this.phone = null;
    this.connectedAt = null;
    this.linkedAt = null;
    this.lastError = null;
    this.captures = 0;
    this.attempts = 0;
    this.stopped = false;
    this.seenTriggers = new Set();
  }

  isLinked() {
    return fs.existsSync(path.join(this.dir, 'creds.json'));
  }

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  #trimSeen() {
    if (this.seenTriggers.size <= MAX_SEEN_REACTIONS) return;
    const excess = this.seenTriggers.size - MAX_SEEN_REACTIONS;
    let i = 0;
    for (const key of this.seenTriggers) {
      if (i++ >= excess) break;
      this.seenTriggers.delete(key);
    }
  }

  async connect() {
    if (this.sock || this.#connecting) return this.#connecting;
    this.stopped = false;
    this.#connecting = this.#open().finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  async #open() {
    fs.mkdirSync(this.dir, { recursive: true });
    this.#setState(SessionState.CONNECTING);

    const { state, saveCreds } = await useMultiFileAuthState(this.dir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger: waLogger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, waLogger),
      },
      browser: Browsers.macOS(config.brand.name),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      // Necesario para ver nuestras propias reacciones hechas desde el teléfono.
      emitOwnEvents: true,
      // Vida de cada QR. Sin esto, Baileys renueva el primero a los 60 s y los
      // siguientes cada 20 s, y la cuenta atrás del panel dejaría de cuadrar.
      qrTimeout: config.qr.timeoutMs,
      // Cuando el receptor no logra descifrar algo pide el reenvío al emisor, y
      // Baileys nos lo reclama por aquí. Sin esto el mensaje se queda colgado
      // en "Esperando el mensaje" para siempre.
      getMessage: async (key) => this.messages.get(key?.id),
    });

    this.sock = sock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
      this.#onConnectionUpdate(update).catch((error) => log.error('connection.update', error));
    });
    sock.ev.on('messages.upsert', (event) => {
      // Guardar todo lo que pasa por aquí es lo que permite atender los
      // reenvíos: incluye también lo que enviamos nosotros.
      for (const entry of event.messages ?? []) {
        this.messages.set(entry?.key?.id, entry?.message);
      }
      handleUpsert(this, event)
        .then(() => this.#trimSeen())
        .catch((error) => log.error('messages.upsert', error));
    });
  }

  async #onConnectionUpdate({ connection, lastDisconnect, qr }) {
    if (qr) {
      this.qr = qr;
      this.qrExpiresAt = Date.now() + config.qr.timeoutMs;
      this.#setState(SessionState.QR);
      this.emit('qr', qr, this.qrExpiresAt);
    }

    if (connection === 'open') {
      this.attempts = 0;
      this.qr = null;
      this.lastError = null;
      this.connectedAt = Date.now();
      this.ownerJid = this.sock?.user?.id ? jidNormalizedUser(this.sock.user.id) : null;
      this.phone = this.ownerJid?.split('@')[0] ?? null;
      await this.#saveMeta();
      this.#setState(SessionState.OPEN);
      this.emit('open', this);
      log.info(`Sesión abierta (${this.id})`);
      return;
    }

    if (connection !== 'close') return;

    const code = lastDisconnect?.error?.output?.statusCode;
    const reason = lastDisconnect?.error?.message ?? '';
    this.sock = null;

    if (this.stopped) {
      this.#setState(SessionState.CLOSED);
      return;
    }

    // Nunca llegó a vincularse: el QR caducó, no reintentamos en bucle.
    if (!this.isLinked()) {
      this.#setState(SessionState.CLOSED);
      this.qr = null;
      this.emit('qr-expired');
      return;
    }

    if (FATAL.has(code)) {
      log.warn(`Sesión cerrada por WhatsApp (${this.id}, código ${code})`);
      this.lastError = 'La sesión fue cerrada desde el teléfono';
      await this.wipe();
      this.#setState(SessionState.CLOSED);
      this.emit('logout');
      return;
    }

    if (code === DisconnectReason.connectionReplaced) {
      this.lastError = 'Otra sesión tomó el control del dispositivo';
      this.#setState(SessionState.CLOSED);
      this.emit('replaced');
      return;
    }

    // restartRequired es parte del handshake normal: reconectar de inmediato.
    const immediate = code === DisconnectReason.restartRequired;
    const delay = immediate
      ? 500
      : Math.min(30_000, 2_000 * 2 ** this.attempts) + Math.floor(Math.random() * 1_000);
    if (!immediate) this.attempts += 1;

    this.lastError = immediate ? null : reason.slice(0, 120) || `Reconectando (código ${code})`;
    this.#setState(SessionState.CONNECTING);
    this.emit('reconnecting', delay);

    clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => {
      this.connect().catch((error) => log.error(`Fallo al reconectar (${this.id})`, error));
    }, delay);
  }

  /**
   * Latencia real contra los servidores de WhatsApp: el mismo ping que Baileys
   * usa como keep-alive, midiendo el viaje de ida y vuelta.
   */
  async ping({ timeoutMs = 5_000 } = {}) {
    if (!this.sock || this.state !== SessionState.OPEN) return null;
    const started = Date.now();
    try {
      await Promise.race([
        this.sock.query({
          tag: 'iq',
          attrs: {
            id: this.sock.generateMessageTag(),
            to: S_WHATSAPP_NET,
            type: 'get',
            xmlns: 'w:p',
          },
          content: [{ tag: 'ping', attrs: {} }],
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
      ]);
      return Date.now() - started;
    } catch {
      return null;
    }
  }

  async #saveMeta() {
    this.linkedAt ??= Date.now();
    const meta = {
      id: this.id,
      phone: this.phone,
      ownerJid: this.ownerJid,
      linkedAt: this.linkedAt,
    };
    await fsp.writeFile(path.join(this.dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  }

  async loadMeta() {
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(this.dir, 'meta.json'), 'utf8'));
      this.phone = meta.phone ?? null;
      this.ownerJid = meta.ownerJid ?? null;
      this.linkedAt = meta.linkedAt ?? null;
    } catch {
      /* sin metadatos previos */
    }
  }

  /** Cierra el socket sin borrar credenciales. */
  async stop() {
    this.stopped = true;
    clearTimeout(this.#retryTimer);
    try {
      this.sock?.end?.(undefined);
    } catch {
      /* ya estaba cerrado */
    }
    this.sock = null;
    this.#setState(SessionState.CLOSED);
  }

  /** Cierra sesión en WhatsApp y borra todo rastro local. */
  async logout() {
    this.stopped = true;
    clearTimeout(this.#retryTimer);
    try {
      await this.sock?.logout();
    } catch {
      /* el teléfono puede haberla cerrado antes */
    }
    try {
      this.sock?.end?.(undefined);
    } catch {
      /* ignorado */
    }
    this.sock = null;
    await this.wipe();
    await this.media.purge();
    this.#setState(SessionState.CLOSED);
  }

  async wipe() {
    await fsp.rm(this.dir, { recursive: true, force: true });
    this.phone = null;
    this.ownerJid = null;
    this.connectedAt = null;
    this.linkedAt = null;
  }
}
