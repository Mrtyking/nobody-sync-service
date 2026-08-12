import { ButtonStyle } from 'discord.js';
import { config } from '../config.js';
import { SessionState } from '../whatsapp/session.js';

const COLOR = config.brand.color;
const FOOTER = `${config.brand.name} · ${config.brand.url.replace(/^https?:\/\//, '')}`;

export const IDS = {
  link: 'ns:link',
  status: 'ns:status',
  unlink: 'ns:unlink',
  unlinkConfirm: 'ns:unlink:confirm',
  cancel: 'ns:cancel',
};

function maskPhone(phone) {
  if (!phone) return 'Desconocido';
  const tail = phone.slice(-4);
  return `+${phone.slice(0, Math.max(phone.length - 6, 2))}••${tail}`;
}

function relative(ts) {
  return ts ? `<t:${Math.floor(ts / 1000)}:R>` : 'Sin registro';
}

const STATE_LABEL = {
  [SessionState.IDLE]: 'Sin vincular',
  [SessionState.CONNECTING]: 'Conectando',
  [SessionState.QR]: 'Esperando escaneo',
  [SessionState.OPEN]: 'Conectado',
  [SessionState.CLOSED]: 'Desconectado',
};

/** Panel público que deja `/setpanel` en el canal. */
export function panelView() {
  return {
    color: COLOR,
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
        text: '**Estado de la sesión**\n-# Conexión, número vinculado y archivos rescatados.',
        button: { id: IDS.status, label: 'Ver estado', style: ButtonStyle.Secondary },
      },
      {
        text: '**Cerrar sesión**\n-# Desvincula el dispositivo y borra las credenciales del servidor.',
        button: { id: IDS.unlink, label: 'Desconectar', style: ButtonStyle.Danger },
      },
    ],
    footer: FOOTER,
  };
}

export function preparingView() {
  return {
    color: COLOR,
    ephemeral: true,
    title: 'Preparando la vinculación',
    body: 'Estableciendo conexión con WhatsApp. El código aparecerá aquí en unos segundos.',
    footer: FOOTER,
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
    footer: `${FOOTER} · No compartas esta imagen con nadie`,
  };
}

export function linkedView(session) {
  return {
    color: COLOR,
    ephemeral: true,
    title: 'Dispositivo vinculado',
    body: [
      `Tu cuenta **${maskPhone(session.phone)}** quedó conectada correctamente.`,
      '',
      'La sesión se mantiene activa y se reconecta sola si se cae. Ya puedes reaccionar con cualquier emoji a las fotos y videos de una sola vez.',
    ].join('\n'),
    blocks: [
      {
        text: '**Estado de la sesión**\n-# Consulta la conexión y los archivos rescatados.',
        button: { id: IDS.status, label: 'Ver estado', style: ButtonStyle.Secondary },
      },
    ],
    footer: FOOTER,
  };
}

export function statusView(session, stats) {
  const state = STATE_LABEL[session.state] ?? 'Desconocido';
  const rows = [
    `**Estado**  ${state}`,
    `**Número**  ${session.phone ? maskPhone(session.phone) : 'Sin vincular'}`,
    `**Conectado**  ${session.state === SessionState.OPEN ? relative(session.connectedAt) : 'No'}`,
    `**Archivos rescatados**  ${stats.captures}`,
    `**En almacenamiento**  ${stats.stored} archivo(s) · ${stats.size}`,
  ];
  if (session.lastError) rows.push(`**Último aviso**  ${session.lastError}`);

  return {
    color: COLOR,
    ephemeral: true,
    title: 'Estado de la sesión',
    body: rows.join('\n'),
    blocks: [
      session.isLinked()
        ? {
            text: '**Cerrar sesión**\n-# Desvincula el dispositivo y borra las credenciales.',
            button: { id: IDS.unlink, label: 'Desconectar', style: ButtonStyle.Danger },
          }
        : {
            text: '**Vincular dispositivo**\n-# Genera un código QR nuevo.',
            button: { id: IDS.link, label: 'Generar código QR', style: ButtonStyle.Primary },
          },
    ],
    footer: FOOTER,
  };
}

export function unlinkConfirmView() {
  return {
    color: 0xed4245,
    ephemeral: true,
    title: 'Confirmar desconexión',
    body: 'Se cerrará la sesión de WhatsApp y se eliminarán las credenciales y los archivos guardados en el servidor. Tendrás que escanear un código nuevo para volver a vincularte.',
    actions: [
      { id: IDS.unlinkConfirm, label: 'Sí, desconectar', style: ButtonStyle.Danger },
      { id: IDS.cancel, label: 'Cancelar', style: ButtonStyle.Secondary },
    ],
    footer: FOOTER,
  };
}

export function noticeView(title, body, { error = false } = {}) {
  return {
    color: error ? 0xed4245 : COLOR,
    ephemeral: true,
    title,
    body,
    footer: FOOTER,
  };
}
