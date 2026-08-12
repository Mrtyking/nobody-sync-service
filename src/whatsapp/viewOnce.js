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

/** Quién reaccionó, resolviendo los JID nuevos (@lid) cuando existen. */
function resolveReactor(entry, ownerJid) {
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

function matchesTrigger(emoji) {
  if (!emoji) return false; // string vacío = reacción retirada
  if (!config.capture.triggers.length) return true; // cualquier emoji
  return config.capture.triggers.includes(emoji);
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

/** Reenvía el archivo guardado al chat propio de quien reaccionó. */
async function deliver(session, entry, reaction) {
  const targetId = reaction.key?.id;
  if (!targetId || !matchesTrigger(reaction.text)) return;
  if (session.seenReactions.has(entry.key.id)) return;
  session.seenReactions.add(entry.key.id);

  const record = await session.media.get(targetId);
  if (!record) return;

  const reactor = resolveReactor(entry, session.ownerJid);
  if (!reactor) return;
  if (!reactor.isOwner && !config.capture.allowGuests) return;

  const label = describeType(record.kind);
  const payload =
    record.kind === 'video'
      ? { video: { url: record.file }, mimetype: record.mimetype || 'video/mp4' }
      : record.kind === 'audio'
        ? { audio: { url: record.file }, mimetype: record.mimetype || 'audio/ogg; codecs=opus', ptt: true }
        : { image: { url: record.file }, mimetype: record.mimetype || 'image/jpeg' };

  if (record.caption) payload.caption = record.caption;

  try {
    await session.sock.sendMessage(reactor.jid, payload);
    const origin = record.fromMe ? 'Enviado por ti' : record.pushName || record.sender?.split('@')[0] || 'Desconocido';
    await session.sock.sendMessage(reactor.jid, {
      text: [
        `${label} de una sola vez recuperada`,
        `Origen: ${origin}`,
        `Fecha: ${new Date(record.sentAt).toLocaleString('es-ES')}`,
        '',
        `${config.brand.name}`,
      ].join('\n'),
    });
    session.captures += 1;
    session.emit('capture', { ...record, to: reactor.jid, isOwner: reactor.isOwner });
    log.info(`Entregado ${record.kind} a ${reactor.jid} (${session.id})`);
  } catch (error) {
    log.warn('No se pudo entregar el archivo', error);
  }
}

/**
 * Punto de entrada del evento messages.upsert.
 *
 * Solo las reacciones en vivo (`notify`) provocan un envío. Al reconectar,
 * WhatsApp reenvía mensajes recientes como `append`; sin este filtro, una
 * reacción ya atendida antes de un reinicio se volvería a entregar.
 */
export async function handleUpsert(session, { messages, type }) {
  for (const entry of messages ?? []) {
    if (!entry?.message || !entry.key) continue;
    const root = unwrap(entry.message);
    const reaction = root?.reactionMessage;
    if (reaction) {
      if (type === 'notify') await deliver(session, entry, reaction);
    } else {
      await archive(session, entry);
    }
  }
}
