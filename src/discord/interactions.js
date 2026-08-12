import { ChannelType, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { config } from '../config.js';
import { createLogger } from '../utils/logger.js';
import { deliver } from '../ui/render.js';
import * as views from '../ui/views.js';
import { IDS } from '../ui/views.js';
import { manager } from '../whatsapp/manager.js';
import { SessionState } from '../whatsapp/session.js';
import { qrFileName, renderQr } from '../utils/qr.js';

const log = createLogger('discord');

/** Flujos de vinculación abiertos, uno por usuario. */
const flows = new Map();

/* ─── /setpanel ──────────────────────────────────────────────────────────── */

async function handleSetPanel(interaction) {
  const channel = interaction.options.getChannel('canal') ?? interaction.channel;

  if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
    return deliver(
      interaction,
      'reply',
      views.noticeView('Canal no válido', 'Elige un canal de texto del servidor.', { error: true }),
    );
  }

  const me = await interaction.guild.members.fetchMe();
  const perms = channel.permissionsFor(me);
  if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages)) {
    return deliver(
      interaction,
      'reply',
      views.noticeView(
        'Faltan permisos',
        `No puedo escribir en ${channel}. Concédeme Ver canal y Enviar mensajes.`,
        { error: true },
      ),
    );
  }

  await deliver(channel, 'send', views.panelView());
  return deliver(
    interaction,
    'reply',
    views.noticeView('Panel publicado', `El panel ya está disponible en ${channel}.`),
  );
}

/* ─── Botón: generar QR ──────────────────────────────────────────────────── */

function createFlow(interaction, session) {
  let closed = false;
  let queue = Promise.resolve();
  let timer = null;

  const push = (task) => {
    queue = queue.then(task).catch((error) => log.warn('No se pudo actualizar el panel', error));
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

  function onQr(qr, expiresAt) {
    push(async () => {
      if (closed) return;
      const buffer = await renderQr(qr);
      await deliver(
        interaction,
        'editReply',
        views.qrView({ image: { buffer, name: qrFileName() }, expiresAt }),
      );
    });
  }

  function onOpen() {
    push(async () => {
      await deliver(interaction, 'editReply', views.linkedView(session));
      cleanup();
    });
  }

  function onExpired() {
    push(async () => {
      await deliver(
        interaction,
        'editReply',
        views.noticeView(
          'El código caducó',
          'Nadie escaneó el código a tiempo. Pulsa el botón del panel para generar uno nuevo.',
        ),
      );
      cleanup();
    });
  }

  session.on('qr', onQr);
  session.once('open', onOpen);
  session.once('qr-expired', onExpired);

  timer = setTimeout(() => {
    if (closed) return;
    push(async () => {
      if (session.state !== SessionState.OPEN) await session.stop();
      await deliver(
        interaction,
        'editReply',
        views.noticeView('Vinculación cancelada', 'Se agotó el tiempo de espera. Puedes volver a intentarlo.'),
      );
      cleanup();
    });
  }, config.qr.flowTimeoutMs);

  const flow = { cancel: cleanup, session };
  return flow;
}

async function handleLink(interaction) {
  const userId = interaction.user.id;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const session = manager.get(userId);

  if (session.state === SessionState.OPEN) {
    return deliver(interaction, 'editReply', views.linkedView(session));
  }

  // Un usuario, un flujo: cerramos el anterior si seguía vivo.
  flows.get(userId)?.cancel();

  await deliver(interaction, 'editReply', views.preparingView());

  if (session.isLinked()) {
    await session.loadMeta();
    session.connect().catch((error) => log.error('Reconexión manual', error));
    return deliver(
      interaction,
      'editReply',
      views.noticeView(
        'Sesión ya vinculada',
        `Tu cuenta **${session.phone ? `•••${session.phone.slice(-4)}` : 'guardada'}** sigue registrada y se está reconectando. Si quieres empezar de cero, usa Desconectar y vuelve a generar el código.`,
      ),
    );
  }

  flows.set(userId, createFlow(interaction, session));

  try {
    await session.connect();
  } catch (error) {
    log.error('No se pudo abrir la sesión', error);
    flows.get(userId)?.cancel();
    await deliver(
      interaction,
      'editReply',
      views.noticeView(
        'No se pudo conectar',
        'WhatsApp no respondió al intento de vinculación. Inténtalo de nuevo en unos segundos.',
        { error: true },
      ),
    );
  }
}

/* ─── Botón: estado ──────────────────────────────────────────────────────── */

async function handleStatus(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const session = manager.get(interaction.user.id);
  if (!session.phone) await session.loadMeta();
  const stats = await session.stats();
  return deliver(interaction, 'editReply', views.statusView(session, stats));
}

/* ─── Botones: desconectar ───────────────────────────────────────────────── */

async function handleUnlink(interaction) {
  const session = manager.get(interaction.user.id);
  if (!session.isLinked() && session.state !== SessionState.OPEN) {
    return deliver(
      interaction,
      'reply',
      views.noticeView('Nada que desconectar', 'No tienes ninguna sesión de WhatsApp vinculada.'),
    );
  }
  return deliver(interaction, 'reply', views.unlinkConfirmView());
}

async function handleUnlinkConfirm(interaction) {
  await interaction.deferUpdate();
  const session = manager.get(interaction.user.id);
  flows.get(interaction.user.id)?.cancel();
  await session.logout();
  return deliver(
    interaction,
    'editReply',
    views.noticeView(
      'Sesión cerrada',
      'El dispositivo quedó desvinculado y se borraron las credenciales y los archivos guardados.',
    ),
  );
}

async function handleCancel(interaction) {
  const session = manager.get(interaction.user.id);
  const flow = flows.get(interaction.user.id);
  if (flow) {
    flow.cancel();
    if (session.state !== SessionState.OPEN) await session.stop();
  }
  return deliver(
    interaction,
    'update',
    views.noticeView('Operación cancelada', 'No se realizó ningún cambio.'),
  );
}

/* ─── Router ─────────────────────────────────────────────────────────────── */

const BUTTONS = {
  [IDS.link]: handleLink,
  [IDS.status]: handleStatus,
  [IDS.unlink]: handleUnlink,
  [IDS.unlinkConfirm]: handleUnlinkConfirm,
  [IDS.cancel]: handleCancel,
};

export async function routeInteraction(interaction) {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'setpanel') {
      return await handleSetPanel(interaction);
    }
    if (interaction.isButton()) {
      const handler = BUTTONS[interaction.customId];
      if (handler) return await handler(interaction);
    }
  } catch (error) {
    log.error(`Fallo procesando ${interaction.customId ?? interaction.commandName}`, error);
    const view = views.noticeView(
      'Algo salió mal',
      'No se pudo completar la acción. Vuelve a intentarlo en unos segundos.',
      { error: true },
    );
    try {
      const method = interaction.deferred || interaction.replied ? 'followUp' : 'reply';
      await deliver(interaction, method, view);
    } catch {
      /* la interacción ya expiró */
    }
  }
  return undefined;
}

export function cancelFlow(userId) {
  flows.get(userId)?.cancel();
}
