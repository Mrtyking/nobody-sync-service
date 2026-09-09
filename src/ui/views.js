import { ButtonStyle } from 'discord.js';
import { config } from '../config.js';
import { panelBanner } from '../utils/assets.js';
import { humanSize } from '../whatsapp/mediaStore.js';
import { SessionState } from '../whatsapp/session.js';

const COLOR = config.brand.color;

export const IDS = {
  link: 'ns:link',
  status: 'ns:status',
  statusRefresh: 'ns:status:refresh',
  unlink: 'ns:unlink',
  unlinkConfirm: 'ns:unlink:confirm',
  cancel: 'ns:cancel',
};

export function maskPhone(phone) {
  if (!phone) return 'Sin vincular';
  if (phone.length <= 6) return `+${phone}`;
  return `+${phone.slice(0, 2)}••••${phone.slice(-4)}`;
}

function relative(ts) {
  return ts ? `<t:${Math.floor(ts / 1000)}:R>` : '—';
}

function ms(value) {
  return value == null ? '—' : `${value} ms`;
}

const STATE_LABEL = {
  [SessionState.IDLE]: 'Sin vincular',
  [SessionState.CONNECTING]: 'Conectando',
  [SessionState.QR]: 'Esperando escaneo',
  [SessionState.OPEN]: 'Conectado',
  [SessionState.CLOSED]: 'Desconectado',
  [SessionState.RELINK]: 'Hay que volver a escanear',
};

/** Panel público que deja `/setpanel` en el canal. */
export function panelView() {
  return {
    color: COLOR,
    banner: panelBanner(),
    title: config.brand.name,
    subtitle: 'Sincronización de WhatsApp',
    body: [
      'Vincula tu cuenta de WhatsApp con un código QR en alta definición y mantén la sesión activa de forma permanente.',
      '',
      'Cuando reacciones con cualquier emoji a una foto o un video de **una sola vez**, recibirás una copia en tu propio chat de WhatsApp, guardada para siempre.',
    ].join('\n'),
    blocks: [
      {
        text: '**Vincular dispositivo**\n-# Genera un código QR y escanéalo desde tu teléfono.',
        button: { id: IDS.link, label: 'Generar código QR', style: ButtonStyle.Primary },
      },
      {
        text: '**Estado del sistema**\n-# Comprueba en directo que todo está encendido.',
        button: { id: IDS.status, label: 'Ver estado', style: ButtonStyle.Secondary },
      },
      {
        text: '**Cerrar sesión**\n-# Desvincula el dispositivo y borra las credenciales del servidor.',
        button: { id: IDS.unlink, label: 'Desconectar', style: ButtonStyle.Danger },
      },
    ],
    footer: 'Tu sesión permanece activa las 24 horas · No compartas tu código de vinculación',
  };
}

/** Términos de uso que deja `/terms` en el canal. Solo informativo. */
export function termsView() {
  const brand = config.brand.name;
  return {
    color: COLOR,
    title: 'Términos de uso',
    subtitle: brand,
    body: `Al vincular tu cuenta de WhatsApp y usar ${brand} aceptas estos términos. Léelos con calma.`,
    blocks: [
      {
        text: [
          '**1 · El servicio**',
          `${brand} vincula tu WhatsApp mediante un código QR y recupera las fotos y videos de una sola vez cuando reaccionas con un emoji, enviándotelos a tu chat privado.`,
        ].join('\n'),
      },
      {
        text: [
          '**2 · Uso responsable**',
          'Eres el único responsable del uso que hagas del bot y del contenido que recuperes. Úsalo solo con material propio o con permiso de quien lo envió. Queda prohibido usarlo para acosar, extorsionar, difundir contenido íntimo sin consentimiento o para cualquier fin ilegal.',
        ].join('\n'),
      },
      {
        text: [
          '**3 · Privacidad y datos**',
          'Para mantener la sesión activa se guardan las credenciales de tu WhatsApp y una copia temporal de los archivos recuperados en el servidor. Los archivos se borran solos pasado el tiempo configurado, y puedes eliminar todo cuando quieras con el botón Desconectar del panel.',
        ].join('\n'),
      },
      {
        text: [
          '**4 · Registro**',
          'Cada archivo recuperado queda registrado para la administración del servicio, incluyendo su identificador, su tipo y el propio archivo. Usa el bot solo si estás de acuerdo con ello.',
        ].join('\n'),
      },
      {
        text: [
          '**5 · Sin afiliación**',
          `${brand} no está afiliado ni respaldado por WhatsApp ni por Meta. Es una herramienta independiente que usa una conexión no oficial, por lo que tu cuenta de WhatsApp podría ser limitada o bloqueada. Lo usas bajo tu propio riesgo.`,
        ].join('\n'),
      },
      {
        text: [
          '**6 · Aceptación**',
          'Vincular la cuenta y usar el bot implica que aceptas estos términos. Si no estás de acuerdo, no lo vincules. Estos términos pueden cambiar; el uso continuado supone aceptar la versión vigente.',
        ].join('\n'),
      },
    ],
    footer: brand,
  };
}

export function preparingView() {
  return {
    color: COLOR,
    ephemeral: true,
    title: 'Preparando la vinculación',
    body: 'Estableciendo conexión con WhatsApp. El código aparecerá aquí en unos segundos.',
  };
}

export function qrView({ image, expiresAt }) {
  return {
    color: COLOR,
    ephemeral: true,
    title: 'Código de vinculación',
    subtitle: 'Válido solo para ti',
    body: [
      '**1.** Abre WhatsApp en tu teléfono.',
      '**2.** Entra en Ajustes y luego en Dispositivos vinculados.',
      '**3.** Pulsa Vincular un dispositivo.',
      '**4.** Escanea el código que aparece abajo.',
    ].join('\n'),
    image,
    blocks: [
      {
        text: `**El código se renueva automáticamente**\n-# El actual caduca ${relative(expiresAt)}.`,
      },
    ],
    actions: [{ id: IDS.cancel, label: 'Cancelar', style: ButtonStyle.Secondary }],
    footer: 'Nadie más ve este mensaje · No compartas la imagen con nadie',
  };
}

/** Se muestra al terminar de escanear y al pulsar Generar con la sesión ya activa. */
export function linkedView(session, { alreadyLinked = false } = {}) {
  return {
    color: config.status.ok,
    ephemeral: true,
    title: alreadyLinked ? 'Ya tienes una sesión activa' : 'Dispositivo vinculado',
    body: [
      alreadyLinked
        ? 'Tu cuenta sigue conectada, no hace falta escanear otro código.'
        : 'Tu cuenta quedó conectada correctamente.',
      '',
      `**Número**  ${maskPhone(session.phone)}`,
      `**Conectado**  ${relative(session.connectedAt)}`,
      `**Vinculado**  ${relative(session.linkedAt)}`,
      '',
      'La sesión se mantiene activa y se reconecta sola si se cae. Ya puedes reaccionar con cualquier emoji a las fotos y videos de una sola vez.',
    ].join('\n'),
    blocks: [
      {
        text: '**Estado del sistema**\n-# Latencia y actividad de los dos bots.',
        button: { id: IDS.status, label: 'Ver estado', style: ButtonStyle.Secondary },
      },
    ],
  };
}

/* ─── Estado del sistema ─────────────────────────────────────────────────── */

const HEALTH_COLOR = {
  ok: config.status.ok,
  warn: config.status.warn,
  down: config.status.down,
  idle: config.brand.color,
};

const HEALTH_TITLE = {
  ok: 'Todos los sistemas operativos',
  warn: 'Servicio parcial',
  down: 'Servicio caído',
  idle: 'Operativo · sin WhatsApp vinculado',
};

function discordBlock(discord) {
  return [
    '**Discord**',
    `Conexión · **${discord.online ? 'En línea' : 'Desconectado'}**`,
    `Latencia · **${ms(discord.ping)}**`,
    `Respuesta · **${ms(discord.roundTrip)}**`,
    `Servidores · **${discord.guilds}**`,
    `Encendido · ${relative(discord.since)}`,
  ].join('\n');
}

function whatsappBlock(whatsapp) {
  const lines = [
    '**WhatsApp**',
    `Conexión · **${STATE_LABEL[whatsapp.state] ?? 'Desconocido'}**`,
  ];
  if (whatsapp.online) {
    lines.push(
      `Latencia · **${ms(whatsapp.ping)}**`,
      `Número · **${maskPhone(whatsapp.phone)}**`,
      `Activa desde · ${relative(whatsapp.since)}`,
      `Vinculada · ${relative(whatsapp.linkedAt)}`,
    );
  } else if (whatsapp.needsRelink) {
    lines.push(
      `Número · **${maskPhone(whatsapp.phone)}**`,
      `-# ${whatsapp.lastError ?? 'WhatsApp cerró la sesión.'}`,
      '-# Tus archivos guardados siguen intactos. Pulsa Generar código QR para volver a vincular.',
    );
  } else if (whatsapp.linked) {
    lines.push(
      `Número · **${maskPhone(whatsapp.phone)}**`,
      'Reintentando la conexión automáticamente.',
    );
    if (whatsapp.lastError) lines.push(`-# ${whatsapp.lastError}`);
  } else {
    lines.push('-# Pulsa Generar código QR para vincular tu cuenta.');
  }
  return lines.join('\n');
}

function systemBlock(system, captures) {
  return [
    '**Servicio**',
    `Cuentas vinculadas · **${system.linked}**`,
    `Cuentas en línea · **${system.connected}**`,
    ...(system.relink ? [`Pendientes de revincular · **${system.relink}**`] : []),
    `Archivos guardados · **${captures.stored}** · ${captures.size}`,
    `Entregas realizadas · **${captures.delivered}**`,
    `Memoria · **${humanSize(system.memory)}**`,
    `Node · **${system.node}**`,
    `Arrancado · ${relative(system.since)}`,
  ].join('\n');
}

export function statusView(status, session, captures) {
  const linked = session.isLinked();
  return {
    color: HEALTH_COLOR[status.health] ?? COLOR,
    ephemeral: true,
    title: 'Estado del sistema',
    subtitle: HEALTH_TITLE[status.health] ?? '',
    body: discordBlock(status.discord),
    blocks: [
      { text: whatsappBlock(status.whatsapp) },
      { text: systemBlock(status.system, captures) },
      linked
        ? {
            text: '**Cerrar sesión**\n-# Desvincula el dispositivo y borra las credenciales.',
            button: { id: IDS.unlink, label: 'Desconectar', style: ButtonStyle.Danger },
          }
        : {
            text: '**Vincular dispositivo**\n-# Genera un código QR nuevo.',
            button: { id: IDS.link, label: 'Generar código QR', style: ButtonStyle.Primary },
          },
    ],
    actions: [{ id: IDS.statusRefresh, label: 'Actualizar', style: ButtonStyle.Secondary }],
    footer: `Medido ${new Date(status.at).toLocaleTimeString('es-ES')} · Los datos se toman en el momento de pulsar`,
  };
}

/** Panel público de estado del servicio que publica y refresca `/status`. */
export function serviceStatusView(status) {
  const { discord, whatsapp, system } = status;
  const discordBlock = [
    '**Discord**',
    `Conexión · **${discord.online ? 'En línea' : 'Desconectado'}**`,
    `Latencia · **${ms(discord.ping)}**`,
    `Servidores · **${discord.guilds}**`,
    `Encendido · ${relative(discord.since)}`,
  ].join('\n');

  const waBlock = [
    '**WhatsApp**',
    `Cuentas en línea · **${whatsapp.connected} / ${whatsapp.linked}**`,
    ...(whatsapp.online ? [`Latencia media · **${ms(whatsapp.ping)}**`] : []),
    ...(whatsapp.relink ? [`Pendientes de revincular · **${whatsapp.relink}**`] : []),
  ].join('\n');

  const systemBlock = [
    '**Servicio**',
    `Memoria · **${humanSize(system.memory)}**`,
    `Node · **${system.node}**`,
    `Arrancado · ${relative(system.since)}`,
  ].join('\n');

  return {
    color: HEALTH_COLOR[status.health] ?? COLOR,
    title: 'Estado del sistema',
    subtitle: HEALTH_TITLE[status.health] ?? '',
    body: discordBlock,
    blocks: [{ text: waBlock }, { text: systemBlock }],
    footer: `${config.brand.name} · Actualizado <t:${Math.floor(status.at / 1000)}:R>`,
  };
}

export function unlinkConfirmView() {
  return {
    color: config.status.down,
    ephemeral: true,
    title: 'Confirmar desconexión',
    body: 'Se cerrará la sesión de WhatsApp y se eliminarán las credenciales y los archivos guardados en el servidor. Tendrás que escanear un código nuevo para volver a vincularte.',
    actions: [
      { id: IDS.unlinkConfirm, label: 'Sí, desconectar', style: ButtonStyle.Danger },
      { id: IDS.cancel, label: 'Cancelar', style: ButtonStyle.Secondary },
    ],
  };
}

export function noticeView(title, body, { error = false } = {}) {
  return {
    color: error ? config.status.down : COLOR,
    ephemeral: true,
    title,
    body,
  };
}
