import { config } from '../config.js';
import { createLogger, waLogger } from '../utils/logger.js';
import { downloadMediaMessage, jidNormalizedUser, prepareWAMessageMedia } from './baileys.js';
import { mediaLabel } from './mediaStore.js';

const log = createLogger('viewonce');

// Margen amplio para subir cualquier video, por pesado que sea, sin cortarse.
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
// Igual de generoso para la descarga: un archivo pesado tiene margen de sobra,
// pero ninguna descarga puede quedarse colgada para siempre bloqueando la
// entrega de la petición que la espera.
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** Descarga el medio a un buffer, con un tope de tiempo para no colgarse. */
function downloadMedia(descriptor, sock) {
  return Promise.race([
    downloadMediaMessage(descriptor, 'buffer', {}, {
      logger: waLogger,
      reuploadRequest: sock.updateMediaMessage,
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('La descarga agotó el tiempo')), DOWNLOAD_TIMEOUT_MS),
    ),
  ]);
}
const DEFAULT_MIME = { image: 'image/jpeg', video: 'video/mp4', audio: 'audio/ogg; codecs=opus' };

/**
 * Contenido del mensaje a enviar. `jpegThumbnail: null` evita que Baileys
 * intente generar la miniatura con ffmpeg (que no está en el hosting y bloquea
 * la subida). La misma forma vale para pre-subir y para entregar, de modo que
 * comparten clave de caché y la segunda vez no se vuelve a subir.
 */
function mediaPayload(record) {
  const mimetype = record.mimetype || DEFAULT_MIME[record.kind] || 'application/octet-stream';
  if (record.kind === 'video') return { video: { url: record.file }, mimetype, jpegThumbnail: null };
  if (record.kind === 'audio') return { audio: { url: record.file }, mimetype, ptt: true };
  return { image: { url: record.file }, mimetype, jpegThumbnail: null };
}

const MEDIA_KEYS = ['imageMessage', 'videoMessage', 'audioMessage'];

/** Desenvuelve las capas con las que WhatsApp empaqueta los mensajes. */
function unwrap(message) {
  let current = message;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    const next =
      current.ephemeralMessage?.message ??
      current.documentWithCaptionMessage?.message ??
      current.editedMessage?.message ??
      null;
    if (!next) break;
    current = next;
  }
  return current;
}

/**
 * Detecta una foto/video/audio de una sola vez en cualquiera de sus formatos:
 * viewOnceMessage, viewOnceMessageV2, la extensión de audio, o el flag
 * `viewOnce` puesto directamente sobre el medio.
 */
export function extractViewOnce(message) {
  const root = unwrap(message);
  if (!root) return null;

  const wrapper =
    root.viewOnceMessage?.message ??
    root.viewOnceMessageV2?.message ??
    root.viewOnceMessageV2Extension?.message ??
    null;

  const target = wrapper ? unwrap(wrapper) : root;
  if (!target) return null;

  for (const key of MEDIA_KEYS) {
    const node = target[key];
    if (!node) continue;
    if (!wrapper && !node.viewOnce) continue;
    return { kind: key.replace('Message', ''), key, node, message: target };
  }
  return null;
}

/** Número recortado para los logs: no hace falta volcarlo entero. */
function shortJid(jid = '') {
  const number = jid.split('@')[0];
  return number.length > 6 ? `+${number.slice(0, 4)}••••${number.slice(-4)}` : number;
}

/**
 * Envía y guarda el mensaje en la caché. Es imprescindible: si el aparato de
 * destino no consigue descifrarlo pedirá el reenvío, y solo podremos servirlo
 * si conservamos el contenido original.
 */
async function send(session, sock, jid, content, options = {}) {
  const sent = await sock.sendMessage(jid, content, options);
  session.messages.set(sent?.key?.id, sent?.message);
  // Enviar puede marcarnos como activos y robarle las notificaciones al
  // teléfono del usuario; volvemos a anunciarnos ausentes en cuanto acabamos.
  sock.sendPresenceUpdate('unavailable').catch(() => {});
  return sent;
}

/**
 * Pre-sube el archivo a WhatsApp en segundo plano, nada más recibirlo. Así el
 * trabajo pesado (cifrar + subir) ocurre antes de que nadie reaccione, y la
 * entrega luego es casi instantánea. Es una optimización: si falla, la entrega
 * sube el archivo de forma normal. Solo tiene sentido para video (lo pesado).
 */
function preUpload(session, sock, record) {
  // Fotos y videos: es lo que se pide y lo que cuesta subir.
  if (record.kind !== 'video' && record.kind !== 'image') return;
  if (!sock?.waUploadToServer || !session.mediaCache) return;
  if (session.pendingUploads.has(record.id)) return;

  const promise = prepareWAMessageMedia(mediaPayload(record), {
    upload: sock.waUploadToServer,
    mediaCache: session.mediaCache,
    mediaUploadTimeoutMs: UPLOAD_TIMEOUT_MS,
    logger: waLogger,
    options: {},
  })
    .then(() => log.info(`Archivo #${record.code} pre-subido y listo para entregar`))
    .catch((error) => log.debug(`Pre-subida de #${record.code} fallida (se subirá al pedirlo)`, error))
    .finally(() => session.pendingUploads.delete(record.id));

  session.pendingUploads.set(record.id, promise);
}

// Un emoji "de verdad": cualquier pictograma, una bandera (indicadores
// regionales) o un teclado numérico. Las banderas y los teclados no son
// Extended_Pictographic, por eso hay que nombrarlos aparte.
const HAS_EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{20E3}]/u;

/** ¿El texto contiene al menos un emoji? */
function hasEmoji(text) {
  return HAS_EMOJI.test(text);
}

/**
 * ¿Este texto activa el rescate?
 *
 * Con TRIGGER_EMOJIS vacío (lo recomendado) basta con que la respuesta lleve
 * cualquier emoji: la gente responde con el que le sugiere lo que vio —
 * risa, corazón, sorpresa— y todos deben valer. Solo si se configuran emojis
 * concretos se restringe a esos.
 */
function matchesTrigger(text) {
  if (!text) return false; // string vacío = reacción retirada
  if (config.capture.triggers.length) {
    return config.capture.triggers.some((emoji) => text.includes(emoji));
  }
  return hasEmoji(text);
}

/** Quién pidió el archivo, resolviendo los JID nuevos (@lid) cuando existen. */
function resolveRequester(entry, ownerJid, ownerLid) {
  if (entry.key.fromMe) return { jid: ownerJid, isOwner: true };
  const raw =
    entry.key.participantPn ??
    entry.key.participantAlt ??
    entry.key.participant ??
    entry.participant ??
    entry.key.remoteJid;
  if (!raw) return null;
  const jid = jidNormalizedUser(raw);
  if (jid.endsWith('@lid')) {
    // WhatsApp migró a identificadores ocultos (@lid). Si quien reacciona es el
    // propio dueño con su @lid, lo reconocemos por su id oculto y entregamos a
    // su chat. De un @lid ajeno no tenemos el número real, así que no se puede.
    if (ownerLid && jid === ownerLid) return { jid: ownerJid, isOwner: true };
    return null;
  }
  return { jid, isOwner: jid === ownerJid };
}

/**
 * Respuesta citando un mensaje con un emoji como texto. Es lo que hace la
 * gente en la práctica: mantener pulsado, Responder y mandar el emoji. Llega
 * como extendedTextMessage con el id del mensaje citado en contextInfo.
 */
function extractTriggerReply(root) {
  const extended = root?.extendedTextMessage;
  const context = extended?.contextInfo;
  if (!context?.stanzaId) return null;
  if (!matchesTrigger(extended.text ?? '')) return null;
  return {
    targetId: context.stanzaId,
    quoted: context.quotedMessage ?? null,
    quotedAuthor: context.participant ?? null,
  };
}

/**
 * Descarga y archiva el contenido de una sola vez en cuanto entra al
 * dispositivo, para poder recuperarlo después.
 */
async function archive(session, sock, entry) {
  const found = extractViewOnce(entry.message);
  if (!found) return;

  const id = entry.key.id;
  if (!id || (await session.media.get(id))) return;

  const what = `${found.kind} de una sola vez`;
  try {
    const buffer = await downloadMedia(
      { key: entry.key, message: { [found.key]: found.node } },
      sock,
    );

    const record = await session.media.save(id, buffer, {
      kind: found.kind,
      mimetype: found.node.mimetype ?? '',
      caption: found.node.caption ?? '',
      chat: entry.key.remoteJid,
      sender: entry.key.participant ?? entry.key.remoteJid,
      fromMe: Boolean(entry.key.fromMe),
      pushName: entry.pushName ?? '',
      sentAt: Number(entry.messageTimestamp ?? 0) * 1000 || Date.now(),
    });
    log.info(`Archivado ${what} (${session.id})`);
    // Adelanta la subida para que la entrega sea instantánea al reaccionar.
    preUpload(session, sock, record);
  } catch (error) {
    log.warn(`No se pudo archivar el ${what}`, error);
  }
}

/**
 * Lanza el archivado sin bloquear: así una descarga pesada no retrasa la
 * entrega de otra petición que llegue en el mismo lote. La promesa se registra
 * para que, si alguien reacciona justo mientras se descarga, la entrega espere
 * a que termine en vez de no encontrar nada.
 */
function startArchive(session, sock, entry) {
  const id = entry.key?.id;
  if (!id || session.pendingArchives.has(id)) return;

  const promise = archive(session, sock, entry).finally(() =>
    session.pendingArchives.delete(id),
  );
  session.pendingArchives.set(id, promise);
}

/**
 * Último recurso cuando el archivo no estaba guardado: la copia citada que
 * viaja dentro de la respuesta suele conservar las claves del medio, así que
 * se puede intentar bajar de nuevo. Falla si el emisor ya lo eliminó.
 */
async function rescueFromQuote(session, sock, entry, reply) {
  const found = extractViewOnce(reply.quoted);
  if (!found) return null;

  try {
    const buffer = await downloadMedia(
      {
        key: {
          remoteJid: entry.key.remoteJid,
          id: reply.targetId,
          fromMe: false,
          participant: reply.quotedAuthor ?? undefined,
        },
        message: { [found.key]: found.node },
      },
      sock,
    );

    log.info(`Recuperado ${found.kind} desde el mensaje citado (${session.id})`);
    return await session.media.save(reply.targetId, buffer, {
      kind: found.kind,
      mimetype: found.node.mimetype ?? '',
      caption: found.node.caption ?? '',
      chat: entry.key.remoteJid,
      sender: reply.quotedAuthor ?? entry.key.remoteJid,
      fromMe: false,
      pushName: '',
      sentAt: Date.now(),
    });
  } catch (error) {
    log.warn('El medio citado ya no está disponible', error);
    return null;
  }
}

/**
 * Envía el archivo al chat privado de quien lo pidió. Nunca se escribe en el
 * chat de origen: la copia va siempre al chat del propio número.
 */
async function deliverMedia(session, sock, entry, targetId, { quotedReply = null } = {}) {
  if (!targetId || !sock) return;
  if (session.seenTriggers.has(entry.key.id)) return;
  session.seenTriggers.add(entry.key.id);

  // El dueño se saca del socket vivo: los metadatos en memoria pueden ir por
  // detrás tras una reconexión, y sin él las peticiones propias se perderían.
  const ownerJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : session.ownerJid;
  // Su id oculto (@lid), para reconocer sus propias reacciones cuando WhatsApp
  // las entrega con ese formato en vez de con el número.
  const ownerLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null;
  const requester = resolveRequester(entry, ownerJid, ownerLid);
  if (!requester?.jid) {
    // Diagnóstico sin números: solo el dominio de cada campo (@lid, @s.whatsapp.net…)
    // y si teníamos el id oculto del dueño, para ver por qué no se resolvió.
    const k = entry.key ?? {};
    const dom = (j) => (j ? (j.split('@')[1] ?? '?') : '-');
    log.warn(
      `No se pudo identificar a quién enviar el archivo (${session.id}) · ` +
        `fromMe=${Boolean(k.fromMe)} pn=${dom(k.participantPn)} alt=${dom(k.participantAlt)} ` +
        `part=${dom(k.participant)} remote=${dom(k.remoteJid)} ownerLid=${ownerLid ? 'sí' : 'no'}`,
    );
    return;
  }
  if (!requester.isOwner && !config.capture.allowGuests) return;

  // Puede que aún se esté descargando (reacción inmediata): esperarla evita
  // quedarnos sin nada que entregar por milésimas.
  await session.pendingArchives.get(targetId)?.catch(() => {});

  let record = await session.media.get(targetId);
  if (!record && quotedReply) record = await rescueFromQuote(session, sock, entry, quotedReply);

  if (!record) {
    // Solo avisamos si lo citado era de verdad de una sola vez; si no, callamos.
    if (quotedReply && extractViewOnce(quotedReply.quoted)) {
      await send(session, sock, requester.jid, {
        text: `No pude recuperar ese archivo. Solo se guardan los que llegan con ${config.brand.name} conectado, y el emisor puede haberlo eliminado.`,
      }).catch(() => {});
    }
    return;
  }

  const label = mediaLabel(record.kind);
  const payload = mediaPayload(record);
  // La ficha va como pie del propio archivo: un solo mensaje en vez de dos,
  // que es la mitad de ida y vuelta y se siente inmediato.
  const info = [
    // El pie original, si lo tenía, va primero y separado.
    ...(record.caption ? [record.caption, ''] : []),
    label.recovered,
    `ID · #${record.code}`,
    '',
    config.brand.name,
  ].join('\n');

  // Si el archivo se está pre-subiendo, esperamos a que termine: así la entrega
  // acierta en la caché y sale al instante en vez de subirlo otra vez.
  await session.pendingUploads.get(targetId)?.catch(() => {});

  try {
    const options = { mediaUploadTimeoutMs: UPLOAD_TIMEOUT_MS };
    if (record.kind === 'audio') {
      // El audio no admite pie: ahí sí hacen falta dos mensajes.
      await send(session, sock, requester.jid, payload, options);
      await send(session, sock, requester.jid, { text: info });
    } else {
      await send(session, sock, requester.jid, { ...payload, caption: info }, options);
    }
    session.captures += 1;
    session.emit('capture', { ...record, to: requester.jid, isOwner: requester.isOwner });
    log.info(
      `Entregado ${record.kind} #${record.code} a ${requester.isOwner ? 'su propio chat' : shortJid(requester.jid)}`,
    );
  } catch (error) {
    log.warn('No se pudo entregar el archivo', error);
  }
}

/**
 * Punto de entrada del evento messages.upsert.
 *
 * Solo los disparadores en vivo (`notify`) provocan un envío. Al reconectar,
 * WhatsApp reenvía mensajes recientes como `append`; sin este filtro, una
 * petición ya atendida antes de un reinicio se volvería a entregar.
 */
export async function handleUpsert(session, sock, { messages, type }) {
  for (const entry of messages ?? []) {
    if (!entry?.key) continue;
    const root = entry.message ? unwrap(entry.message) : null;

    // ─── Diagnóstico temporal (solo nombres de tipo, sin contenido ni números).
    // Incluye los mensajes que llegan SIN contenido (no se pudieron descifrar),
    // para distinguir "llegó pero no se descifró" de "no llegó". Quitar al resolver.
    log.info(
      `[diag] type=${type} fromMe=${Boolean(entry.key.fromMe)} ` +
        `raw=[${entry.message ? Object.keys(entry.message).join(',') : '(sin contenido/no descifrado)'}] ` +
        `vo=${root ? Boolean(extractViewOnce(entry.message)) : false}`,
    );

    if (!root) continue;

    // 1. Reacción con emoji sobre el mensaje.
    const reaction = root.reactionMessage;
    if (reaction) {
      if (type === 'notify' && matchesTrigger(reaction.text)) {
        await deliverMedia(session, sock, entry, reaction.key?.id);
      }
      continue;
    }

    // 2. Respuesta citando el mensaje con un emoji.
    const reply = extractTriggerReply(root);
    if (reply) {
      if (type === 'notify') {
        await deliverMedia(session, sock, entry, reply.targetId, { quotedReply: reply });
      }
      continue;
    }

    // 3. Cualquier otro mensaje: si trae contenido recuperable, se archiva sin
    //    bloquear, para no retrasar las peticiones que vengan en el mismo lote.
    startArchive(session, sock, entry);
  }
}

export const __test = { hasEmoji, matchesTrigger, extractTriggerReply };
