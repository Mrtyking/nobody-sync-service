import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { humanSize, mediaLabel } from '../whatsapp/mediaStore.js';

const log = createLogger('webhook');

const WEBHOOK_RE = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

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

/**
 * Publica el registro administrativo de un rescate en el webhook de Discord.
 * Es "fire and forget": nunca lanza ni bloquea la entrega en WhatsApp; los
 * fallos se anotan y punto.
 */
export async function postRecovery({ discordUserId, accountPhone, record, to, isOwner }) {
  if (!webhookEnabled() || !record) return;

  const label = mediaLabel(record.kind);
  const origin = record.fromMe
    ? 'La propia cuenta'
    : record.pushName?.trim() || maskPhone(record.sender);

  const embed = {
    title: label.recovered,
    color: config.brand.color,
    fields: [
      { name: 'ID', value: `\`#${record.code}\``, inline: true },
      { name: 'Tamaño', value: humanSize(record.size), inline: true },
      { name: 'Origen', value: origin, inline: true },
      { name: 'Usuario', value: discordUserId ? `<@${discordUserId}>` : 'Desconocido', inline: true },
      { name: 'Cuenta', value: maskPhone(accountPhone), inline: true },
      { name: 'Destino', value: isOwner ? 'Su propio chat' : maskPhone(to), inline: true },
    ],
    timestamp: new Date(record.sentAt || Date.now()).toISOString(),
    footer: { text: config.brand.name },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(`${config.logWebhook}?wait=false`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn(`El webhook respondió ${res.status}; revisa LOG_WEBHOOK_URL`);
    }
  } catch (error) {
    log.warn('No se pudo enviar el registro al webhook', error);
  } finally {
    clearTimeout(timer);
  }
}
