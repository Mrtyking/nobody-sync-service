import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { collectServiceStatus } from '../status.js';
import { serviceStatusView } from '../ui/views.js';
import { deliver } from '../ui/render.js';

const log = createLogger('status');
const FILE = path.join(config.paths.data, 'status-panels.json');
const REFRESH_MS = 60 * 1000;
// Códigos de Discord: canal o mensaje que ya no existen -> se descarta el panel.
const GONE = new Set([10003, 10004, 10008, 50001]);

let panels = []; // [{ channelId, messageId }]
let timer = null;
let updating = false;

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(raw)) panels = raw.filter((p) => p?.channelId && p?.messageId);
  } catch {
    panels = [];
  }
}

async function save() {
  await fsp.writeFile(FILE, JSON.stringify(panels, null, 2), 'utf8').catch(() => {});
}

/** Registra (o reemplaza por canal) un panel público y lo persiste. */
export async function addStatusPanel(channelId, messageId) {
  panels = panels.filter((p) => p.channelId !== channelId);
  panels.push({ channelId, messageId });
  await save();
}

async function refreshOne(client, panel, view) {
  const channel = await client.channels.fetch(panel.channelId).catch((e) => {
    throw e;
  });
  const message = await channel.messages.fetch(panel.messageId);
  await deliver(message, 'edit', view);
}

/** Refresca todos los paneles con una sola medición del estado. */
async function refreshAll(client) {
  if (updating || !panels.length || !client.isReady()) return;
  updating = true;
  try {
    const view = serviceStatusView(await collectServiceStatus(client));
    const alive = [];
    let dropped = false;
    for (const panel of panels) {
      try {
        await refreshOne(client, panel, view);
        alive.push(panel);
      } catch (error) {
        const code = error?.code ?? error?.rawError?.code;
        if (GONE.has(code)) {
          log.info(`Panel de estado retirado (canal ${panel.channelId}): ya no existe`);
          dropped = true;
        } else {
          alive.push(panel); // fallo pasajero: se conserva
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
export function startStatusBoard(client) {
  load();
  if (panels.length) log.info(`Refrescando ${panels.length} panel(es) de estado cada 60 s`);
  refreshAll(client).catch((error) => log.error('Refresco inicial de estado', error));
  clearInterval(timer);
  timer = setInterval(() => {
    refreshAll(client).catch((error) => log.error('Refresco de estado', error));
  }, REFRESH_MS);
  timer.unref?.();
}

export function stopStatusBoard() {
  clearInterval(timer);
}
