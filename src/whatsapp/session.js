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
  RELINK: 'relink',
};

/**
 * Motivos por los que no sirve reintentar: el dispositivo dejó de estar
 * autorizado y hace falta escanear otro código.
 *
 * `badSession` (500) NO está aquí a propósito: WhatsApp lo devuelve también en
 * cortes pasajeros, y darlo por definitivo dejaba fuera a sesiones sanas.
 */
const NEEDS_RELINK = new Set([
  DisconnectReason.loggedOut, // 401
  DisconnectReason.forbidden, // 403
  DisconnectReason.multideviceMismatch, // 411
  405,
]);

/** Cierres con badSession seguidos antes de darla por perdida. */
const MAX_BAD_SESSIONS = 3;
const MAX_SEEN_TRIGGERS = 500;
const PRESENCE_REFRESH_MS = 5 * 60 * 1000;

/**
 * Una sesión = una cuenta de WhatsApp vinculada por un usuario de Discord.
 * Se reconecta sola indefinidamente mientras las credenciales sigan siendo
 * válidas, que es lo que mantiene el bot conectado siempre.
 */
export class Session extends EventEmitter {
  #connecting = null;
  #retryTimer = null;
  #presenceTimer = null;
  #metaLoaded = false;
  /**
   * Cada socket se numera. Un socket viejo puede emitir eventos tardíos
   * después de que ya exista uno nuevo; sin esta comprobación, el cierre del
   * antiguo anulaba el socket vivo y la sesión se quedaba conectada pero muda.
   */
  #epoch = 0;

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
    this.needsRelink = false;
    this.captures = 0;
    this.attempts = 0;
    this.badSessions = 0;
    this.stopped = false;
    this.seenTriggers = new Set();
  }

  hasCredentials() {
    return fs.existsSync(path.join(this.dir, 'creds.json'));
  }

  /** Vinculada y utilizable. Si hace falta reescanear, cuenta como no vinculada. */
  isLinked() {
    return this.hasCredentials() && !this.needsRelink;
  }

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  #trimSeen() {
    if (this.seenTriggers.size <= MAX_SEEN_TRIGGERS) return;
    const excess = this.seenTriggers.size - MAX_SEEN_TRIGGERS;
    let index = 0;
    for (const key of this.seenTriggers) {
      if (index++ >= excess) break;
      this.seenTriggers.delete(key);
    }
  }

  async connect() {
    if (this.sock || this.#connecting) return this.#connecting;
    clearTimeout(this.#retryTimer);
    this.stopped = false;

    // Volver a intentarlo con credenciales muertas solo repite el error: se
    // limpian aquí, con el usuario delante pidiendo un código nuevo.
    if (this.needsRelink) await this.reset();

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

    const epoch = ++this.#epoch;
    const sock = makeWASocket({
      version,
      logger: waLogger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, waLogger),
      },
      browser: Browsers.macOS(config.brand.name),
      syncFullHistory: false,
      // Con esto Baileys anuncia la presencia como "no disponible" al conectar,
      // que es lo que deja que el teléfono siga dando sus notificaciones.
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

    sock.ev.on('creds.update', () => {
      saveCreds().catch((error) => log.error(`No se pudieron guardar credenciales (${this.id})`, error));
    });

    sock.ev.on('connection.update', (update) => {
      if (epoch !== this.#epoch) return; // evento de un socket ya sustituido
      this.handleConnectionUpdate(update, sock).catch((error) =>
        log.error('connection.update', error),
      );
    });

    sock.ev.on('messages.upsert', (event) => {
      if (epoch !== this.#epoch) return;
      // Guardar todo lo que pasa por aquí es lo que permite atender los
      // reenvíos: incluye también lo que enviamos nosotros.
      for (const entry of event.messages ?? []) {
        this.messages.set(entry?.key?.id, entry?.message);
      }
      // El socket va explícito: es el que recibió el evento, y así una
      // reconexión a media faena no deja la entrega sin destino.
      handleUpsert(this, sock, event)
        .then(() => this.#trimSeen())
        .catch((error) => log.error('messages.upsert', error));
    });
  }

  /** Interno: reacciona a un cambio de conexión del socket indicado. */
  async handleConnectionUpdate({ connection, lastDisconnect, qr }, sock) {
    if (qr) {
      this.qr = qr;
      this.qrExpiresAt = Date.now() + config.qr.timeoutMs;
      this.#setState(SessionState.QR);
      this.emit('qr', qr, this.qrExpiresAt);
    }

    if (connection === 'open') {
      this.attempts = 0;
      this.badSessions = 0;
      this.qr = null;
      this.lastError = null;
      this.needsRelink = false;
      this.connectedAt = Date.now();
      this.ownerJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
      this.phone = this.ownerJid?.split('@')[0] ?? null;
      await this.#saveMeta();
      this.#keepPresenceAway(sock);
      this.#setState(SessionState.OPEN);
      this.emit('open', this);
      log.info(`Sesión abierta (${this.id})`);
      return;
    }

    if (connection !== 'close') return;

    const code = lastDisconnect?.error?.output?.statusCode;
    const reason = lastDisconnect?.error?.message ?? '';
    clearInterval(this.#presenceTimer);
    // Solo el socket actual puede soltar la referencia viva.
    if (this.sock === sock) this.sock = null;

    if (this.stopped) {
      this.#setState(SessionState.CLOSED);
      return;
    }

    // Nunca llegó a vincularse: el QR caducó, no reintentamos en bucle.
    if (!this.hasCredentials()) {
      this.#setState(SessionState.CLOSED);
      this.qr = null;
      this.emit('qr-expired');
      return;
    }

    if (NEEDS_RELINK.has(code)) {
      log.warn(`Dispositivo desvinculado por WhatsApp (${this.id}, código ${code})`);
      await this.#requireRelink('La sesión se cerró desde el teléfono');
      return;
    }

    if (code === DisconnectReason.connectionReplaced) {
      this.lastError = 'Otra sesión tomó el control del dispositivo';
      this.#setState(SessionState.CLOSED);
      this.emit('replaced');
      return;
    }

    // badSession suele ser pasajero. Solo tras varios seguidos se da por muerta,
    // y aun así no se borra nada: lo decide el usuario desde el panel.
    if (code === DisconnectReason.badSession) {
      this.badSessions += 1;
      if (this.badSessions >= MAX_BAD_SESSIONS) {
        log.warn(`Sesión rechazada ${this.badSessions} veces seguidas (${this.id})`);
        await this.#requireRelink('WhatsApp rechazó la sesión varias veces seguidas');
        return;
      }
      log.warn(`Sesión rechazada (${this.id}, intento ${this.badSessions}/${MAX_BAD_SESSIONS})`);
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
   * El teléfono deja de avisar de los mensajes nuevos si cree que estás activo
   * en otro dispositivo. Anunciarse como ausente, y reafirmarlo cada pocos
   * minutos, mantiene las notificaciones donde el usuario las espera.
   */
  #keepPresenceAway(sock) {
    const away = () => {
      if (this.sock !== sock) return;
      sock.sendPresenceUpdate('unavailable').catch(() => {});
    };
    away();
    clearInterval(this.#presenceTimer);
    this.#presenceTimer = setInterval(away, PRESENCE_REFRESH_MS);
    this.#presenceTimer.unref?.();
  }

  /** Marca la sesión como "hay que volver a escanear" sin destruir nada. */
  async #requireRelink(reason) {
    this.stopped = true;
    this.needsRelink = true;
    this.lastError = reason;
    clearTimeout(this.#retryTimer);
    clearInterval(this.#presenceTimer);
    // Se espera a que quede en disco: si el proceso se reinicia justo después,
    // la marca tiene que sobrevivir o volveríamos a insistir con credenciales
    // muertas.
    await this.#saveMeta().catch((error) =>
      log.error(`No se pudo marcar la sesión ${this.id} para revincular`, error),
    );
    this.#setState(SessionState.RELINK);
    this.emit('relink-required', reason);
  }

  /**
   * Latencia real contra los servidores de WhatsApp: el mismo ping que Baileys
   * usa como keep-alive, midiendo el viaje de ida y vuelta.
   */
  async ping({ timeoutMs = 5_000 } = {}) {
    const sock = this.sock;
    if (!sock || this.state !== SessionState.OPEN) return null;
    const started = Date.now();
    try {
      await Promise.race([
        sock.query({
          tag: 'iq',
          attrs: {
            id: sock.generateMessageTag(),
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
      needsRelink: this.needsRelink,
      lastError: this.needsRelink ? this.lastError : null,
    };
    await fsp.writeFile(path.join(this.dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  }

  /** Carga los metadatos una sola vez; sin ellos no sabríamos si hay que revincular. */
  async ensureMeta() {
    if (this.#metaLoaded) return;
    await this.loadMeta();
  }

  async loadMeta() {
    this.#metaLoaded = true;
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(this.dir, 'meta.json'), 'utf8'));
      this.phone = meta.phone ?? null;
      this.ownerJid = meta.ownerJid ?? null;
      this.linkedAt = meta.linkedAt ?? null;
      this.needsRelink = Boolean(meta.needsRelink);
      if (this.needsRelink) {
        this.lastError = meta.lastError ?? 'Hay que volver a escanear el código';
        this.#setState(SessionState.RELINK);
      }
    } catch {
      /* sin metadatos previos */
    }
  }

  /** Cierra el socket sin borrar credenciales. */
  async stop() {
    this.stopped = true;
    this.#epoch += 1; // ningún evento tardío del socket anterior debe actuar
    clearTimeout(this.#retryTimer);
    clearInterval(this.#presenceTimer);
    const sock = this.sock;
    this.sock = null;
    try {
      sock?.end?.(undefined);
    } catch {
      /* ya estaba cerrado */
    }
    this.#setState(SessionState.CLOSED);
  }

  /** Cierra sesión en WhatsApp y borra todo rastro local. */
  async logout() {
    const sock = this.sock;
    this.stopped = true;
    this.#epoch += 1;
    clearTimeout(this.#retryTimer);
    clearInterval(this.#presenceTimer);
    this.sock = null;
    try {
      await sock?.logout();
    } catch {
      /* el teléfono puede haberla cerrado antes */
    }
    try {
      sock?.end?.(undefined);
    } catch {
      /* ignorado */
    }
    await this.reset();
    await this.media.purge();
    this.#setState(SessionState.CLOSED);
  }

  /** Borra credenciales y metadatos. Solo a petición del usuario. */
  async reset() {
    await fsp.rm(this.dir, { recursive: true, force: true });
    this.messages = new MessageCache();
    this.phone = null;
    this.ownerJid = null;
    this.connectedAt = null;
    this.linkedAt = null;
    this.needsRelink = false;
    this.badSessions = 0;
    this.attempts = 0;
  }
}
