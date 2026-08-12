import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { createLogger } from './logger.js';

const log = createLogger('assets');
const cache = new Map();

/**
 * Carga un archivo del proyecto una sola vez y lo deja en memoria: el panel
 * puede publicarse muchas veces y no tiene sentido releer el GIF cada vez.
 */
export function loadAsset(filePath) {
  if (!filePath) return null;
  if (cache.has(filePath)) return cache.get(filePath);

  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(config.paths.root, filePath);

  let asset = null;
  try {
    asset = {
      buffer: fs.readFileSync(absolute),
      // Discord solo acepta nombres simples en los adjuntos.
      name: path.basename(absolute).toLowerCase().replace(/[^a-z0-9._-]/g, '-'),
    };
  } catch {
    log.warn(`No se encontró el archivo ${absolute}; el panel se publicará sin él.`);
  }

  cache.set(filePath, asset);
  return asset;
}

/** GIF de cabecera del panel. Devuelve null si no está disponible. */
export function panelBanner() {
  return loadAsset(config.brand.panelGif);
}
