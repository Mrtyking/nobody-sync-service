import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { collectTelegramServiceStatus } from './status.js';
import { serviceStatusText } from './views.js';

const log = createLogger('tg-status');
const FILE = path.join(config.paths.data, 'telegram-status-panels.json');
const REFRESH_MS = 60 * 1000;

let panels = []; // [{ chatId, messageId }]
let timer = null;
let updating = false;

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(raw)) panels = raw.filter((p) => p?.chatId && p?.messageId);
  } catch {
    panels = [];
  }
}

async function save() {
  await fsp.writeFile(FILE, JSON.stringify(panels, null, 2), 'utf8').catch(() => {});
}

/** Registra (o reemplaza por chat) un panel público y lo persiste. */
export async function addStatusPanel(chatId, messageId) {
  panels = panels.filter((p) => p.chatId !== chatId);
  panels.push({ chatId, messageId });
  await save();
}

async function refreshAll(bot, startedAt) {
  if (updating || !panels.length) return;
  updating = true;
  try {
    const { text } = serviceStatusText(await collectTelegramServiceStatus(bot, { startedAt }));
    const alive = [];
    let dropped = false;
    for (const panel of panels) {
      try {
        await bot.api.editMessageText(panel.chatId, panel.messageId, text, { parse_mode: 'HTML' });
        alive.push(panel);
      } catch (error) {
        const code = error?.error_code;
        // "message is not modified" no es un fallo real, solo no cambió nada.
        if (/message is not modified/i.test(error?.description ?? '')) {
          alive.push(panel);
        } else if (code === 400 || code === 403) {
          log.info(`Panel de estado retirado (chat ${panel.chatId}): ya no accesible`);
          dropped = true;
        } else {
          alive.push(panel);
          log.debug('No se pudo refrescar un panel de estado', error);
        }
      }
    }
    if (dropped) {
      panels = alive;
      await save();
    }
  } finally {
    updating = false;
  }
}

/** Arranca el refresco periódico de los paneles guardados. */
export function startStatusBoard(bot, startedAt) {
  load();
  if (panels.length) log.info(`Refrescando ${panels.length} panel(es) de estado cada 60 s`);
  refreshAll(bot, startedAt).catch((error) => log.error('Refresco inicial de estado', error));
  clearInterval(timer);
  timer = setInterval(() => {
    refreshAll(bot, startedAt).catch((error) => log.error('Refresco de estado', error));
  }, REFRESH_MS);
  timer.unref?.();
}

export function stopStatusBoard() {
  clearInterval(timer);
}
