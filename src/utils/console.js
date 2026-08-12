import { createLogger } from './logger.js';

const log = createLogger('cifrado');

/**
 * libsignal escribe directamente en la consola, sin pasar por ningún logger, y
 * varios de sus avisos arrastran el volcado entero del objeto de sesión: cientos
 * de líneas de buffers por cada mensaje. Aquí se descarta lo que es simple
 * mantenimiento del cifrado y se resume en una línea lo que sí importa.
 */
const RULES = [
  { test: /^Closing session/i },
  { test: /^Closing open session in favor of incoming prekey bundle/i },
  { test: /^Closing stale open session/i },
  { test: /^Session already (closed|open)/i },
  { test: /^Decrypted message with closed session/i },
  { test: /^Unhandled bucket type/i },
  { test: /^WARNING: Expected pubkey of length 33/i },
  {
    test: /^Failed to decrypt message with any known session/i,
    level: 'warn',
    text: 'No se pudo descifrar un mensaje entrante; se renegociará la sesión',
  },
  {
    test: /^Session error/i,
    level: 'warn',
    text: 'Error en la sesión cifrada; se restablecerá automáticamente',
  },
  {
    test: /^V1 session storage migration error/i,
    level: 'warn',
    text: 'Migración de una sesión antigua incompleta',
  },
];

const THROTTLE_MS = 30_000;
const lastSeen = new Map();

let installed = false;

/**
 * @param {{ verbose?: boolean }} options `verbose` deja pasar todo tal cual,
 * útil para depurar problemas de cifrado.
 */
export function installConsoleFilter({ verbose = false } = {}) {
  if (installed || verbose) return;
  installed = true;

  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      const first = typeof args[0] === 'string' ? args[0] : '';
      const rule = first && RULES.find((entry) => entry.test.test(first));
      if (!rule) {
        original(...args);
        return;
      }
      if (!rule.level) return;
      // Un mismo aviso puede repetirse en ráfaga; basta con verlo una vez.
      const now = Date.now();
      if (now - (lastSeen.get(rule.text) ?? 0) < THROTTLE_MS) return;
      lastSeen.set(rule.text, now);
      log[rule.level](rule.text);
    };
  }
}
