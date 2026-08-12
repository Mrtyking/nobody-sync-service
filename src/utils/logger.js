import pino from 'pino';
import { config } from '../config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function write(level, scope, message, extra) {
  if (LEVELS[level] < Math.min(threshold, LEVELS.info)) return;
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const tag = `[${stamp}] ${level.toUpperCase().padEnd(5)} ${scope ? `(${scope}) ` : ''}`;
  if (extra instanceof Error) console[level === 'debug' ? 'log' : level](`${tag}${message}`, extra.message);
  else if (extra !== undefined) console[level === 'debug' ? 'log' : level](`${tag}${message}`, extra);
  else console[level === 'debug' ? 'log' : level](`${tag}${message}`);
}

export function createLogger(scope = '') {
  return {
    debug: (msg, extra) => write('debug', scope, msg, extra),
    info: (msg, extra) => write('info', scope, msg, extra),
    warn: (msg, extra) => write('warn', scope, msg, extra),
    error: (msg, extra) => write('error', scope, msg, extra),
  };
}

export const log = createLogger();

/** Logger silencioso (o no) que Baileys necesita internamente. */
export const waLogger = pino({ level: config.logLevel });
