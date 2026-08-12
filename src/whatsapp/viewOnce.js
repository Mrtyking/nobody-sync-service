import { config } from '../config.js';
import { createLogger, waLogger } from '../utils/logger.js';
import { downloadMediaMessage, jidNormalizedUser } from './baileys.js';

const log = createLogger('viewonce');

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

function describeType(kind) {
  return { image: 'Foto', video: 'Video', audio: 'Audio' }[kind] ?? 'Archivo';
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
async function send(session, jid, content) {
  const sent = await session.sock.sendMessage(jid, content);
  session.messages.set(sent?.key?.id, sent?.message);
  return sent;
}

// Un emoji "de verdad": un pictograma, una bandera (dos indicadores
// regionales) o un teclado numérico. Las banderas y los teclados no son
// Extended_Pictographic, por eso hay que nombrarlos aparte.
const HAS_EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{20E3}]/u;
// Emoji_Component cubre el ZWJ, el selector de variación, los tonos de piel,
// los indicadores regionales y los dígitos de los teclados.
const ONLY_EMOJI = /^[\p{Extended_Pictographic}\p{Emoji_Component}\s]+$/u;

/**
 * Un texto formado solo por emojis. Se exige al menos un emoji real para que
 * un "123" o un simple espacio no cuenten como disparador.
 */
function isEmojiOnly(text) {
  const trimmed = text.trim();
  if (!trimmed || !HAS_EMOJI.test(trimmed)) return false;
  return ONLY_EMOJI.test(trimmed);
}

/** ¿Este texto activa el rescate? Vacío en la config = cualquier emoji. */
function matchesTrigger(text) {
  if (!text) return false; // string vacío = reacción retirada
  if (config.capture.triggers.length) return config.capture.triggers.includes(text.trim());
  return isEmojiOnly(text);
}

/** Quién pidió el archivo, resolviendo los JID nuevos (@lid) cuando existen. */
function resolveRequester(entry, ownerJid) {
  if (entry.key.fromMe) return { jid: ownerJid, isOwner: true };
  const raw =
    entry.key.participantPn ??
    entry.key.participantAlt ??
    entry.key.participant ??
    entry.participant ??
    entry.key.remoteJid;
  if (!raw) return null;
  const jid = jidNormalizedUser(raw);
  if (jid.endsWith('@lid')) return null; // sin número real no podemos escribirle
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

/** Descarga y archiva el medio en cuanto entra al dispositivo. */
async function archive(session, entry) {
  const found = extractViewOnce(entry.message);
  if (!found) return;

  const id = entry.key.id;
  if (!id || (await session.media.get(id))) return;

  try {
    const buffer = await downloadMediaMessage(
      { key: entry.key, message: { [found.key]: found.node } },
      'buffer',
      {},
      { logger: waLogger, reuploadRequest: session.sock.updateMediaMessage },
    );

    await session.media.save(id, buffer, {
      kind: found.kind,
      mimetype: found.node.mimetype ?? '',
      caption: found.node.caption ?? '',
      chat: entry.key.remoteJid,
      sender: entry.key.participant ?? entry.key.remoteJid,
      fromMe: Boolean(entry.key.fromMe),
      pushName: entry.pushName ?? '',
      sentAt: Number(entry.messageTimestamp ?? 0) * 1000 || Date.now(),
    });
    log.info(`Archivado ${found.kind} de una sola vez (${session.id})`);
  } catch (error) {
    log.warn(`No se pudo archivar el medio ${id}`, error);
  }
}

/**
 * Último recurso cuando el archivo no estaba guardado: la copia citada que
 * viaja dentro de la respuesta suele conservar las claves del medio, así que
 * se puede intentar bajar de nuevo. Falla si el emisor ya lo eliminó.
 */
async function rescueFromQuote(session, entry, reply) {
  const found = extractViewOnce(reply.quoted);
  if (!found) return null;

  try {
    const buffer = await downloadMediaMessage(
      {
        key: {
          remoteJid: entry.key.remoteJid,
          id: reply.targetId,
          fromMe: false,
          participant: reply.quotedAuthor ?? undefined,
        },
        message: { [found.key]: found.node },
      },
      'buffer',
      {},
      { logger: waLogger, reuploadRequest: session.sock.updateMediaMessage },
    );

    log.info(`Recuperado ${found.kind} desde el mensaje citado (${session.id})`);
    return session.media.save(reply.targetId, buffer, {
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
async function deliverMedia(session, entry, targetId, { quotedReply = null } = {}) {
  if (!targetId || !session.sock) return;
  if (session.seenTriggers.has(entry.key.id)) return;
  session.seenTriggers.add(entry.key.id);

  const requester = resolveRequester(entry, session.ownerJid);
  if (!requester) return;
  if (!requester.isOwner && !config.capture.allowGuests) return;

  let record = await session.media.get(targetId);
  if (!record && quotedReply) record = await rescueFromQuote(session, entry, quotedReply);

  if (!record) {
    // Solo avisamos si lo citado era de verdad de una sola vez; si no, callamos.
    if (quotedReply && extractViewOnce(quotedReply.quoted)) {
      await send(session, requester.jid, {
        text: `No pude recuperar ese archivo. Solo se guardan los que llegan con ${config.brand.name} conectado, y el emisor puede haberlo eliminado.`,
      }).catch(() => {});
    }
    return;
  }

  const label = describeType(record.kind);
  const payload =
    record.kind === 'video'
      ? { video: { url: record.file }, mimetype: record.mimetype || 'video/mp4' }
      : record.kind === 'audio'
        ? { audio: { url: record.file }, mimetype: record.mimetype || 'audio/ogg; codecs=opus', ptt: true }
        : { image: { url: record.file }, mimetype: record.mimetype || 'image/jpeg' };

  if (record.caption) payload.caption = record.caption;

  try {
    await send(session, requester.jid, payload);
    const origin = record.fromMe
      ? 'Enviado por ti'
      : record.pushName || record.sender?.split('@')[0] || 'Desconocido';
    await send(session, requester.jid, {
      text: [
        `${label} de una sola vez recuperada`,
        `Origen: ${origin}`,
        `Fecha: ${new Date(record.sentAt).toLocaleString('es-ES')}`,
        '',
        config.brand.name,
      ].join('\n'),
    });
    session.captures += 1;
    session.emit('capture', { ...record, to: requester.jid, isOwner: requester.isOwner });
    log.info(
      `Entregado ${record.kind} a ${requester.isOwner ? 'su propio chat' : shortJid(requester.jid)}`,
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
export async function handleUpsert(session, { messages, type }) {
  for (const entry of messages ?? []) {
    if (!entry?.message || !entry.key) continue;
    const root = unwrap(entry.message);
    if (!root) continue;

    // 1. Reacción con emoji sobre el mensaje.
    const reaction = root.reactionMessage;
    if (reaction) {
      if (type === 'notify' && matchesTrigger(reaction.text)) {
        await deliverMedia(session, entry, reaction.key?.id);
      }
      continue;
    }

    // 2. Respuesta citando el mensaje con un emoji.
    const reply = extractTriggerReply(root);
    if (reply) {
      if (type === 'notify') {
        await deliverMedia(session, entry, reply.targetId, { quotedReply: reply });
      }
      continue;
    }

    // 3. Cualquier otro mensaje: si trae contenido de una sola vez, se archiva.
    await archive(session, entry);
  }
}

export const __test = { isEmojiOnly, matchesTrigger, extractTriggerReply };
