import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function str(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

/**
 * Los paneles de hosting suelen crear la variable vacía en cuanto la detectan,
 * y `Number('')` es 0, no NaN: sin esta comprobación una casilla en blanco
 * dejaría, por ejemplo, MEDIA_TTL_HOURS en 0 y la limpieza borraría todos los
 * archivos guardados. En blanco significa "no configurada".
 */
function int(name, fallback) {
  const raw = str(name);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function bool(name, fallback) {
  const value = str(name);
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'si', 'sí', 'on'].includes(value.toLowerCase());
}

function color(name, fallback) {
  const value = str(name).replace('#', '');
  const parsed = Number.parseInt(value, 16);
  return Number.isFinite(parsed) && value.length === 6 ? parsed : fallback;
}

function list(name) {
  return str(name)
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

const dataDir = path.resolve(rootDir, str('DATA_DIR', path.join(rootDir, 'data')));

/**
 * Ajustes finos que en la práctica nunca se tocan. Viven aquí, como constantes,
 * en vez de como variables de entorno: así el panel del hosting solo muestra lo
 * que de verdad hay que configurar. Para cambiarlos, se editan aquí.
 */
const QR = {
  size: 1024, // lado del PNG en píxeles
  margin: 2, // margen en módulos
  dark: '#0B0B0F',
  light: '#FFFFFF',
  timeoutMs: 60_000, // vida de cada código antes de renovarse
  flowTimeoutMs: 300_000, // cuánto sigue el panel renovando el código
};

/** Color de la barra del panel de estado según la salud del servicio. */
const STATUS_COLORS = {
  ok: 0x3ba55d,
  warn: 0xf0b232,
  down: 0xed4245,
};

export const config = {
  discord: {
    token: str('DISCORD_TOKEN'),
    clientId: str('DISCORD_CLIENT_ID'),
    guildId: str('DISCORD_GUILD_ID'),
  },
  telegram: {
    // Token de @BotFather. Basta con esto: a diferencia de Discord, Telegram
    // no tiene un "Application ID" aparte.
    token: str('TELEGRAM_BOT_TOKEN'),
  },
  brand: {
    name: str('BRAND_NAME', 'Nobody Sync'),
    color: color('PANEL_COLOR', 0x5865f2),
    // Ruta relativa a la raíz del proyecto (o absoluta) del GIF del panel.
    panelGif: str('PANEL_GIF', 'assets/nobody.gif'),
  },
  status: STATUS_COLORS,
  qr: QR,
  capture: {
    ttlHours: int('MEDIA_TTL_HOURS', 24),
    triggers: list('TRIGGER_EMOJIS'),
    // Desactivado a propósito: si varias personas del mismo chat tienen el bot,
    // atender reacciones ajenas hace que TODAS le manden el archivo a quien
    // reaccionó, desde sus propias cuentas. Cada quien recupera con su sesión.
    allowGuests: bool('ALLOW_GUEST_REACTIONS', false),
    notify: bool('NOTIFY_CAPTURES', true),
    // Guardar también los estados, para poder recuperarlos al reaccionarles.
    status: bool('CAPTURE_STATUS', true),
  },
  paths: {
    root: rootDir,
    data: dataDir,
    sessions: path.join(dataDir, 'sessions'),
    media: path.join(dataDir, 'media'),
  },
  // Webhook de Discord para el registro administrativo de cada rescate. Es un
  // secreto: se lee del entorno y nunca se guarda en el repositorio.
  logWebhook: str('LOG_WEBHOOK_URL'),
  logLevel: str('BAILEYS_LOG_LEVEL', 'silent'),
};

export function ensureDirs() {
  for (const dir of [config.paths.data, config.paths.sessions, config.paths.media]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function assertConfig() {
  // Cada plataforma es independiente: puedes tener solo Discord, solo
  // Telegram, o las dos encendidas a la vez, y cada una vincula sus propias
  // sesiones de WhatsApp.
  const wantsDiscord = Boolean(config.discord.token || config.discord.clientId);
  const missing = [];
  if (wantsDiscord) {
    if (!config.discord.token) missing.push('DISCORD_TOKEN');
    if (!config.discord.clientId) missing.push('DISCORD_CLIENT_ID');
  }
  if (missing.length) {
    throw new Error(
      `Faltan variables de entorno: ${missing.join(', ')}. Copia .env.example a .env y complétalas.`,
    );
  }
  if (!config.discord.token && !config.telegram.token) {
    throw new Error(
      'Falta configurar al menos una plataforma: define DISCORD_TOKEN + DISCORD_CLIENT_ID, o TELEGRAM_BOT_TOKEN, en tu .env.',
    );
  }
}
