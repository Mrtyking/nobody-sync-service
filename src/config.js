import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function str(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function int(name, fallback) {
  const value = Number(process.env[name]);
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

export const config = {
  discord: {
    token: str('DISCORD_TOKEN'),
    clientId: str('DISCORD_CLIENT_ID'),
    guildId: str('DISCORD_GUILD_ID'),
  },
  brand: {
    name: str('BRAND_NAME', 'Nobody Sync'),
    color: color('PANEL_COLOR', 0x5865f2),
    // Ruta relativa a la raíz del proyecto (o absoluta) del GIF del panel.
    panelGif: str('PANEL_GIF', 'assets/nobody.gif'),
  },
  // Colores de estado del panel de diagnóstico.
  status: {
    ok: color('STATUS_OK_COLOR', 0x3ba55d),
    warn: color('STATUS_WARN_COLOR', 0xf0b232),
    down: color('STATUS_DOWN_COLOR', 0xed4245),
  },
  qr: {
    size: Math.min(Math.max(int('QR_SIZE', 1024), 256), 2048),
    margin: int('QR_MARGIN', 2),
    dark: str('QR_DARK', '#0B0B0F'),
    light: str('QR_LIGHT', '#FFFFFF'),
    timeoutMs: int('QR_TIMEOUT_MS', 60_000),
    // Tiempo total que el panel efimero sigue renovando el QR.
    flowTimeoutMs: int('QR_FLOW_TIMEOUT_MS', 300_000),
  },
  capture: {
    ttlHours: int('MEDIA_TTL_HOURS', 24),
    // Vale tanto para reacciones como para respuestas citando con emoji.
    triggers: list('TRIGGER_EMOJIS').concat(list('REACTION_TRIGGERS')),
    allowGuests: bool('ALLOW_GUEST_REACTIONS', true),
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
  const missing = [];
  if (!config.discord.token) missing.push('DISCORD_TOKEN');
  if (!config.discord.clientId) missing.push('DISCORD_CLIENT_ID');
  if (missing.length) {
    throw new Error(
      `Faltan variables de entorno: ${missing.join(', ')}. Copia .env.example a .env y complétalas.`,
    );
  }
}
