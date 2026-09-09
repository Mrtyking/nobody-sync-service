import { InputFile } from 'grammy';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { panelBanner } from '../utils/assets.js';
import { qrFileName, renderQr } from '../utils/qr.js';
import { manager } from '../whatsapp/manager.js';
import { SessionState } from '../whatsapp/session.js';
import { IDS } from '../ui/views.js';
import { collectTelegramStatus, collectTelegramServiceStatus } from './status.js';
import { addStatusPanel } from './statusBoard.js';
import {
  panelText,
  openPanelLinkText,
  termsText,
  preparingText,
  qrCaption,
  qrExpiredText,
  qrCancelledText,
  qrFailedText,
  linkedText,
  statusText,
  serviceStatusText,
  unlinkConfirmText,
  unlinkedText,
  nothingToUnlinkText,
  cancelledText,
  genericErrorText,
} from './views.js';

const log = createLogger('telegram');

/** Flujos de vinculación abiertos, uno por sesión de Telegram. */
const flows = new Map();

/** Prefijo que separa las sesiones de Telegram de las de Discord en `manager`. */
export function sessionIdFor(userId) {
  return `tg-${userId}`;
}

function roundTripOf(ctx) {
  const date = ctx.callbackQuery?.message?.date ?? ctx.message?.date;
  return date ? Math.max(0, Date.now() - date * 1000) : null;
}

async function buildStatusMessage(bot, session, extra = {}) {
  await session.ensureMeta();
  const [status, media] = await Promise.all([
    collectTelegramStatus(bot, session, extra),
    session.media.stats(),
  ]);
  return statusText(status, session, {
    stored: media.count,
    size: media.human,
    delivered: session.captures,
  });
}

/* ─── /start, /panel ──────────────────────────────────────────────────────── */

export async function handlePanelEntry(ctx) {
  if (ctx.chat.type !== 'private') {
    const { text, keyboard } = openPanelLinkText(ctx.me.username);
    return ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }

  const { text, keyboard } = panelText();
  const banner = panelBanner();
  if (banner) {
    try {
      return await ctx.replyWithAnimation(new InputFile(banner.buffer, banner.name), {
        caption: text,
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (error) {
      log.warn('No se pudo enviar el GIF del panel, se envía en texto', error);
    }
  }
  return ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

/* ─── /terms ──────────────────────────────────────────────────────────────── */

export async function handleTerms(ctx) {
  const { text } = termsText();
  return ctx.reply(text, { parse_mode: 'HTML' });
}

/* ─── /status ─────────────────────────────────────────────────────────────── */

export async function handleStatusCommand(ctx, bot, startedAt) {
  if (ctx.chat.type === 'private') {
    const id = sessionIdFor(ctx.from.id);
    const session = manager.get(id);
    const { text, keyboard } = await buildStatusMessage(bot, session, {
      roundTrip: roundTripOf(ctx),
      startedAt,
    });
    return ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }

  // En un grupo, /status publica el panel público que se refresca solo, igual que en Discord.
  const { text } = serviceStatusText(await collectTelegramServiceStatus(bot, { startedAt }));
  const message = await ctx.reply(text, { parse_mode: 'HTML' });
  await addStatusPanel(message.chat.id, message.message_id);
  return message;
}

/* ─── Botón: generar QR ──────────────────────────────────────────────────── */

function createFlow(bot, chatId, session, preparingMessageId) {
  let closed = false;
  let queue = Promise.resolve();
  let timer = null;
  let qrMessageId = null;

  const push = (task) => {
    queue = queue.then(task).catch((error) => log.warn('No se pudo actualizar el flujo de QR', error));
    return queue;
  };

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    session.off('qr', onQr);
    session.off('open', onOpen);
    session.off('qr-expired', onExpired);
    if (flows.get(session.id) === flow) flows.delete(session.id);
  };

  async function clearPreparing() {
    if (preparingMessageId) {
      await bot.api.deleteMessage(chatId, preparingMessageId).catch(() => {});
      preparingMessageId = null;
    }
  }

  async function finishWithText(html, keyboard) {
    await clearPreparing();
    if (qrMessageId) {
      await bot.api.deleteMessage(chatId, qrMessageId).catch(() => {});
      qrMessageId = null;
    }
    await bot.api
      .sendMessage(chatId, html, { parse_mode: 'HTML', reply_markup: keyboard })
      .catch((error) => log.warn('No se pudo enviar el resultado de la vinculación', error));
  }

  function onQr(qr, expiresAt) {
    push(async () => {
      if (closed) return;
      await clearPreparing();
      const buffer = await renderQr(qr);
      const { text, keyboard } = qrCaption(expiresAt);
      const photo = new InputFile(buffer, qrFileName());
      if (!qrMessageId) {
        const sent = await bot.api.sendPhoto(chatId, photo, {
          caption: text,
          parse_mode: 'HTML',
          reply_markup: keyboard,
        });
        qrMessageId = sent.message_id;
      } else {
        await bot.api.editMessageMedia(
          chatId,
          qrMessageId,
          { type: 'photo', media: photo, caption: text, parse_mode: 'HTML' },
          { reply_markup: keyboard },
        );
      }
    });
  }

  function onOpen() {
    push(async () => {
      const { text, keyboard } = linkedText(session);
      await finishWithText(text, keyboard);
      cleanup();
    });
  }

  function onExpired() {
    push(async () => {
      await finishWithText(qrExpiredText());
      cleanup();
    });
  }

  session.on('qr', onQr);
  session.once('open', onOpen);
  session.once('qr-expired', onExpired);

  timer = setTimeout(() => {
    if (closed) return;
    push(() => flow.finishCancel());
  }, config.qr.flowTimeoutMs);

  const flow = {
    session,
    // Cierre silencioso: usado cuando un nuevo flujo reemplaza a este.
    cancel: cleanup,
    // Cierre pedido por el usuario (botón Cancelar) o por el propio timeout:
    // manda un mensaje final y limpia.
    async finishCancel() {
      if (closed) return;
      if (session.state !== SessionState.OPEN) await session.stop();
      await finishWithText(qrCancelledText());
      cleanup();
    },
  };
  return flow;
}

async function handleLink(ctx, bot) {
  const id = sessionIdFor(ctx.from.id);
  const chatId = ctx.chat.id;
  await ctx.answerCallbackQuery();

  const session = manager.get(id);
  await session.ensureMeta();

  if (session.state === SessionState.OPEN) {
    const { text, keyboard } = linkedText(session, { alreadyLinked: true });
    return ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
  }

  // Una sesión, un flujo: cerramos el anterior si seguía vivo.
  flows.get(id)?.cancel();

  const preparing = await ctx.reply(preparingText());

  if (session.isLinked()) {
    session.connect().catch((error) => log.error('Reconexión manual', error));
    const { text, keyboard } = await buildStatusMessage(bot, session);
    await bot.api
      .editMessageText(chatId, preparing.message_id, text, { parse_mode: 'HTML', reply_markup: keyboard })
      .catch(() => {});
    return;
  }

  flows.set(id, createFlow(bot, chatId, session, preparing.message_id));

  try {
    await session.connect();
  } catch (error) {
    log.error('No se pudo abrir la sesión', error);
    flows.get(id)?.cancel();
    await bot.api.editMessageText(chatId, preparing.message_id, qrFailedText()).catch(() => {});
  }
}

/* ─── Botón: estado del sistema ──────────────────────────────────────────── */

async function handleStatusButton(ctx, bot, startedAt) {
  await ctx.answerCallbackQuery();
  const id = sessionIdFor(ctx.from.id);
  const session = manager.get(id);
  const { text, keyboard } = await buildStatusMessage(bot, session, {
    roundTrip: roundTripOf(ctx),
    startedAt,
  });
  return ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

async function handleStatusRefresh(ctx, bot, startedAt) {
  await ctx.answerCallbackQuery();
  const id = sessionIdFor(ctx.from.id);
  const session = manager.get(id);
  const { text, keyboard } = await buildStatusMessage(bot, session, {
    roundTrip: roundTripOf(ctx),
    startedAt,
  });
  return ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard }).catch((error) => {
    if (!/message is not modified/i.test(error?.description ?? '')) throw error;
  });
}

/* ─── Botones: desconectar ───────────────────────────────────────────────── */

async function handleUnlink(ctx) {
  const id = sessionIdFor(ctx.from.id);
  const session = manager.get(id);
  if (!session.isLinked() && session.state !== SessionState.OPEN) {
    return ctx.answerCallbackQuery({ text: nothingToUnlinkText(), show_alert: true });
  }
  await ctx.answerCallbackQuery();
  const { text, keyboard } = unlinkConfirmText();
  return ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}

async function handleUnlinkConfirm(ctx) {
  await ctx.answerCallbackQuery();
  const id = sessionIdFor(ctx.from.id);
  const session = manager.get(id);
  flows.get(id)?.cancel();
  await session.logout();
  return ctx.editMessageText(unlinkedText(), { parse_mode: 'HTML' });
}

async function handleCancel(ctx) {
  const id = sessionIdFor(ctx.from.id);
  const flow = flows.get(id);
  await ctx.answerCallbackQuery();
  if (flow) return flow.finishCancel();
  return ctx.editMessageText(cancelledText()).catch(() => {});
}

/* ─── Router ─────────────────────────────────────────────────────────────── */

const BUTTONS = {
  [IDS.link]: handleLink,
  [IDS.status]: handleStatusButton,
  [IDS.statusRefresh]: handleStatusRefresh,
  [IDS.unlink]: handleUnlink,
  [IDS.unlinkConfirm]: handleUnlinkConfirm,
  [IDS.cancel]: handleCancel,
};

export async function routeCallback(ctx, bot, startedAt) {
  const data = ctx.callbackQuery?.data;
  const handler = BUTTONS[data];
  if (!handler) return ctx.answerCallbackQuery().catch(() => {});
  try {
    await handler(ctx, bot, startedAt);
  } catch (error) {
    log.error(`Fallo procesando ${data}`, error);
    try {
      await ctx.answerCallbackQuery({ text: genericErrorText(), show_alert: true });
    } catch {
      /* la consulta ya expiró */
    }
  }
}

export function cancelFlow(userId) {
  flows.get(sessionIdFor(userId))?.cancel();
}
