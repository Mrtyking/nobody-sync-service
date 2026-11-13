import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('media');

const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'video/quicktime': 'mov',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
};

export function extensionFor(mimetype = '') {
  return EXTENSIONS[mimetype.split(';')[0].trim().toLowerCase()] ?? 'bin';
}

export function humanSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

/** Etiqueta legible de un tipo de medio, con la concordancia ya resuelta. */
export function mediaLabel(kind) {
  return (
    {
      image: { noun: 'Foto', recovered: 'Foto recuperada' },
      video: { noun: 'Video', recovered: 'Video recuperado' },
      audio: { noun: 'Audio', recovered: 'Audio recuperado' },
    }[kind] ?? { noun: 'Archivo', recovered: 'Archivo recuperado' }
  );
}

/**
 * Identificador corto y estable de un archivo, derivado (FNV-1a) del id largo
 * del mensaje de WhatsApp. Sirve para que el mismo archivo muestre el mismo
 * código en el chat del usuario y en el log administrativo, y es más legible
 * que el id original de 32 caracteres.
 */
export function shortId(id = '') {
  let hash = 0x811c9dc5;
  const text = String(id);
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).toUpperCase().padStart(6, '0').slice(-6);
}

/**
 * Guarda en disco el contenido de las fotos y videos de una sola vez en cuanto
 * llegan. Descargarlo al instante es lo único fiable: si esperamos a la
 * reacción, el emisor puede haberlo abierto o eliminado y el medio ya no existe.
 */
export class MediaStore {
  constructor(sessionId) {
    this.dir = path.join(config.paths.media, sessionId);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  #paths(id) {
    const safe = String(id).replace(/[^A-Za-z0-9_-]/g, '_');
    return { meta: path.join(this.dir, `${safe}.json`), base: path.join(this.dir, safe) };
  }

  async save(id, buffer, meta) {
    const { meta: metaPath, base } = this.#paths(id);
    const file = `${base}.${extensionFor(meta.mimetype)}`;
    await fsp.writeFile(file, buffer);
    const record = {
      id,
      code: shortId(id),
      file,
      size: buffer.length,
      savedAt: Date.now(),
      ...meta,
    };
    await fsp.writeFile(metaPath, JSON.stringify(record, null, 2), 'utf8');
    return record;
  }

  async get(id) {
    try {
      const record = JSON.parse(await fsp.readFile(this.#paths(id).meta, 'utf8'));
      await fsp.access(record.file);
      return record;
    } catch {
      return null;
    }
  }

  async remove(id) {
    const record = await this.get(id);
    if (!record) return;
    await Promise.allSettled([fsp.rm(record.file, { force: true }), fsp.rm(this.#paths(id).meta, { force: true })]);
  }

  async stats() {
    let count = 0;
    let size = 0;
    try {
      for (const entry of await fsp.readdir(this.dir)) {
        if (entry.endsWith('.json')) continue;
        count += 1;
        size += (await fsp.stat(path.join(this.dir, entry))).size;
      }
    } catch {
      /* carpeta aún vacía */
    }
    return { count, size, human: humanSize(size) };
  }

  /** Borra lo que supere el TTL configurado. */
  async cleanup() {
    const cutoff = Date.now() - config.capture.ttlHours * 3_600_000;
    let removed = 0;
    let entries = [];
    try {
      entries = await fsp.readdir(this.dir);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const metaPath = path.join(this.dir, entry);
      try {
        const record = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
        if (record.savedAt > cutoff) continue;
        await Promise.allSettled([fsp.rm(record.file, { force: true }), fsp.rm(metaPath, { force: true })]);
        removed += 1;
      } catch (error) {
        log.debug(`No se pudo limpiar ${entry}`, error);
      }
    }
    return removed;
  }

  async purge() {
    await fsp.rm(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
  }
}
