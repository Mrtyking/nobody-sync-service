import * as WA from '@whiskeysockets/baileys';

/**
 * Baileys 6.7.24+ es ESM nativo: `default` es directamente makeWASocket y el
 * resto son exports con nombre. Las versiones anteriores eran CommonJS y lo
 * metían todo dentro de `default`. Normalizamos las dos formas para no
 * depender de la versión exacta que instale el hosting.
 */
const ns = WA.default && typeof WA.default === 'object' ? { ...WA.default, ...WA } : WA;

export const makeWASocket =
  typeof WA.default === 'function' ? WA.default : (ns.makeWASocket ?? ns.default);

export const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  Browsers,
  jidNormalizedUser,
  downloadMediaMessage,
} = ns;

if (typeof makeWASocket !== 'function' || !DisconnectReason) {
  throw new Error(
    'La versión instalada de @whiskeysockets/baileys no expone la API esperada. Ejecuta "npm install" de nuevo.',
  );
}
