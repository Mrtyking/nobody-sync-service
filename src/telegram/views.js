import { InlineKeyboard } from 'grammy';
import { config } from '../config.js';
import { maskPhone, IDS } from '../ui/views.js';
import { humanSize } from '../whatsapp/mediaStore.js';
import { SessionState } from '../whatsapp/session.js';

/**
 * Textos y teclados para Telegram. Misma idea que `ui/views.js`, pero
 * adaptado al formato de Telegram (HTML en vez de markdown de Discord, y sin
 * timestamps dinámicos como `<t:...:R>`, que Telegram no tiene).
 */

function escapeHtml(value = '') {
  return String(value).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function when(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
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

const HEALTH_TITLE = {
  ok: 'Todos los sistemas operativos',
  warn: 'Servicio parcial',
  down: 'Servicio caído',
  idle: 'Operativo · sin WhatsApp vinculado',
};

/** Construye un InlineKeyboard a partir de filas de botones. */
function kb(rows) {
  const keyboard = new InlineKeyboard();
  rows.forEach((row, i) => {
    for (const btn of row) {
      if (btn.url) keyboard.url(btn.label, btn.url);
      else keyboard.text(btn.label, btn.id);
    }
    if (i < rows.length - 1) keyboard.row();
  });
  return keyboard;
}

export function panelText() {
  const text = [
    `<b>${escapeHtml(config.brand.name)}</b>`,
    'Sincronización de WhatsApp',
    '',
    'Vincula tu cuenta de WhatsApp con un código QR en alta definición y mantén la sesión activa de forma permanente.',
    '',
    'Cuando reacciones o respondas con cualquier emoji a una foto o un video de <b>una sola vez</b>, recibirás una copia en tu propio chat de WhatsApp, guardada para siempre.',
    '',
    '<i>Tu sesión permanece activa las 24 horas · No compartas tu código de vinculación</i>',
  ].join('\n');
  const keyboard = kb([
    [{ label: 'Generar código QR', id: IDS.link }],
    [{ label: 'Ver estado', id: IDS.status }],
    [{ label: 'Desconectar', id: IDS.unlink }],
  ]);
  return { text, keyboard };
}

/** Botón de enlace directo, para cuando /panel se usa en un grupo. */
export function openPanelLinkText(username) {
  return {
    text: `Abre el panel de <b>${escapeHtml(config.brand.name)}</b> en un chat privado con el bot; ahí puedes vincular tu WhatsApp sin que nadie más del grupo lo vea.`,
    keyboard: kb([[{ label: 'Abrir panel privado', url: `https://t.me/${username}?start=panel` }]]),
  };
}

export function termsText() {
  const brand = escapeHtml(config.brand.name);
  const text = [
    `<b>Términos de uso · ${brand}</b>`,
    `Al vincular tu cuenta de WhatsApp y usar ${brand} aceptas estos términos. Léelos con calma.`,
    '',
    '<b>1 · El servicio</b>',
    `${brand} vincula tu WhatsApp mediante un código QR y recupera las fotos y videos de una sola vez cuando reaccionas o respondes con un emoji, enviándotelos a tu chat privado.`,
    '',
    '<b>2 · Uso responsable</b>',
    'Eres el único responsable del uso que hagas del bot y del contenido que recuperes. Úsalo solo con material propio o con permiso de quien lo envió. Queda prohibido usarlo para acosar, extorsionar, difundir contenido íntimo sin consentimiento o para cualquier fin ilegal.',
    '',
    '<b>3 · Privacidad y datos</b>',
    'Para mantener la sesión activa se guardan las credenciales de tu WhatsApp y una copia temporal de los archivos recuperados en el servidor. Los archivos se borran solos pasado el tiempo configurado, y puedes eliminar todo cuando quieras con el botón Desconectar del panel.',
    '',
    '<b>4 · Registro</b>',
    'Cada archivo recuperado queda registrado para la administración del servicio, incluyendo su identificador, su tipo y el propio archivo. Usa el bot solo si estás de acuerdo con ello.',
    '',
    '<b>5 · Sin afiliación</b>',
    `${brand} no está afiliado ni respaldado por WhatsApp ni por Meta. Es una herramienta independiente que usa una conexión no oficial, por lo que tu cuenta de WhatsApp podría ser limitada o bloqueada. Lo usas bajo tu propio riesgo.`,
    '',
    '<b>6 · Aceptación</b>',
    'Vincular la cuenta y usar el bot implica que aceptas estos términos. Si no estás de acuerdo, no lo vincules. Estos términos pueden cambiar; el uso continuado supone aceptar la versión vigente.',
  ].join('\n');
  return { text };
}

export function preparingText() {
  return 'Estableciendo conexión con WhatsApp. El código llega en un mensaje aparte en unos segundos…';
}

export function qrCaption(expiresAt) {
  const text = [
    '<b>Código de vinculación</b>',
    '',
    '1. Abre WhatsApp en tu teléfono.',
    '2. Entra en Ajustes y luego en Dispositivos vinculados.',
    '3. Pulsa Vincular un dispositivo.',
    '4. Escanea el código de arriba.',
    '',
    `<i>El código se renueva solo · el actual caduca a las ${when(expiresAt)}</i>`,
  ].join('\n');
  const keyboard = kb([[{ label: 'Cancelar', id: IDS.cancel }]]);
  return { text, keyboard };
}

export function qrExpiredText() {
  return '<b>El código caducó</b>\nNadie lo escaneó a tiempo. Pulsa Generar código QR en el panel para crear uno nuevo.';
}

export function qrCancelledText() {
  return '<b>Vinculación cancelada</b>\nSe agotó el tiempo de espera. Puedes volver a intentarlo desde el panel.';
}

export function qrFailedText() {
  return 'WhatsApp no respondió al intento de vinculación. Inténtalo de nuevo en unos segundos.';
}

export function linkedText(session, { alreadyLinked = false } = {}) {
  const text = [
    `<b>${alreadyLinked ? 'Ya tienes una sesión activa' : 'Dispositivo vinculado'}</b>`,
    alreadyLinked
      ? 'Tu cuenta sigue conectada, no hace falta escanear otro código.'
      : 'Tu cuenta quedó conectada correctamente.',
    '',
    `<b>Número</b>  ${escapeHtml(maskPhone(session.phone))}`,
    `<b>Conectado</b>  ${when(session.connectedAt)}`,
    `<b>Vinculado</b>  ${when(session.linkedAt)}`,
    '',
    'La sesión se mantiene activa y se reconecta sola si se cae. Ya puedes reaccionar o responder con cualquier emoji a las fotos y videos de una sola vez.',
  ].join('\n');
  const keyboard = kb([[{ label: 'Ver estado', id: IDS.status }]]);
  return { text, keyboard };
}

function whatsappBlock(whatsapp) {
  const lines = [`<b>WhatsApp</b>`, `Conexión · <b>${STATE_LABEL[whatsapp.state] ?? 'Desconocido'}</b>`];
  if (whatsapp.online) {
    lines.push(
      `Latencia · <b>${ms(whatsapp.ping)}</b>`,
      `Número · <b>${escapeHtml(maskPhone(whatsapp.phone))}</b>`,
      `Activa desde · ${when(whatsapp.since)}`,
      `Vinculada · ${when(whatsapp.linkedAt)}`,
    );
  } else if (whatsapp.needsRelink) {
    lines.push(
      `Número · <b>${escapeHtml(maskPhone(whatsapp.phone))}</b>`,
      `<i>${escapeHtml(whatsapp.lastError ?? 'WhatsApp cerró la sesión.')}</i>`,
      '<i>Tus archivos guardados siguen intactos. Pulsa Generar código QR para volver a vincular.</i>',
    );
  } else if (whatsapp.linked) {
    lines.push(
      `Número · <b>${escapeHtml(maskPhone(whatsapp.phone))}</b>`,
      'Reintentando la conexión automáticamente.',
    );
    if (whatsapp.lastError) lines.push(`<i>${escapeHtml(whatsapp.lastError)}</i>`);
  } else {
    lines.push('<i>Pulsa Generar código QR para vincular tu cuenta.</i>');
  }
  return lines.join('\n');
}

function telegramBlock(telegram) {
  return [
    '<b>Telegram</b>',
    `Conexión · <b>${telegram.online ? 'En línea' : 'Desconectado'}</b>`,
    `Latencia · <b>${ms(telegram.ping)}</b>`,
    `Respuesta · <b>${ms(telegram.roundTrip)}</b>`,
    `Encendido · ${when(telegram.since)}`,
  ].join('\n');
}

function systemBlock(system, captures) {
  return [
    '<b>Servicio</b>',
    `Cuentas vinculadas · <b>${system.linked}</b>`,
    `Cuentas en línea · <b>${system.connected}</b>`,
    ...(system.relink ? [`Pendientes de revincular · <b>${system.relink}</b>`] : []),
    `Archivos guardados · <b>${captures.stored}</b> · ${captures.size}`,
    `Entregas realizadas · <b>${captures.delivered}</b>`,
    `Memoria · <b>${humanSize(system.memory)}</b>`,
    `Node · <b>${system.node}</b>`,
    `Arrancado · ${when(system.since)}`,
  ].join('\n');
}

/** Estado personal (equivalente al botón "Ver estado" ephemeral de Discord). */
export function statusText(status, session, captures) {
  const linked = session.isLinked();
  const text = [
    `<b>${HEALTH_TITLE[status.health] ?? 'Estado del sistema'}</b>`,
    '',
    telegramBlock(status.telegram),
    '',
    whatsappBlock(status.whatsapp),
    '',
    systemBlock(status.system, captures),
    '',
    `<i>Medido ${new Date(status.at).toLocaleTimeString('es-ES')} · los datos se toman en el momento de pulsar</i>`,
  ].join('\n');
  const keyboard = kb([
    [{ label: 'Actualizar', id: IDS.statusRefresh }],
    linked ? [{ label: 'Desconectar', id: IDS.unlink }] : [{ label: 'Generar código QR', id: IDS.link }],
  ]);
  return { text, keyboard };
}

/** Panel público del grupo (equivalente a /status de Discord, se refresca solo). */
export function serviceStatusText(status) {
  const { telegram, whatsapp, system } = status;
  const text = [
    `<b>Estado del sistema</b>`,
    HEALTH_TITLE[status.health] ?? '',
    '',
    '<b>Telegram</b>',
    `Conexión · <b>${telegram.online ? 'En línea' : 'Desconectado'}</b>`,
    `Latencia · <b>${ms(telegram.ping)}</b>`,
    `Encendido · ${when(telegram.since)}`,
    '',
    '<b>WhatsApp</b>',
    `Cuentas en línea · <b>${whatsapp.connected} / ${whatsapp.linked}</b>`,
    ...(whatsapp.online ? [`Latencia media · <b>${ms(whatsapp.ping)}</b>`] : []),
    ...(whatsapp.relink ? [`Pendientes de revincular · <b>${whatsapp.relink}</b>`] : []),
    '',
    '<b>Servicio</b>',
    `Memoria · <b>${humanSize(system.memory)}</b>`,
    `Node · <b>${system.node}</b>`,
    `Arrancado · ${when(system.since)}`,
    '',
    `<i>${escapeHtml(config.brand.name)} · actualizado ${new Date(status.at).toLocaleTimeString('es-ES')}</i>`,
  ].join('\n');
  return { text };
}

export function unlinkConfirmText() {
  const text = [
    '<b>Confirmar desconexión</b>',
    'Se cerrará la sesión de WhatsApp y se eliminarán las credenciales y los archivos guardados en el servidor. Tendrás que escanear un código nuevo para volver a vincularte.',
  ].join('\n');
  const keyboard = kb([
    [{ label: 'Sí, desconectar', id: IDS.unlinkConfirm }],
    [{ label: 'Cancelar', id: IDS.cancel }],
  ]);
  return { text, keyboard };
}

export function unlinkedText() {
  return '<b>Sesión cerrada</b>\nEl dispositivo quedó desvinculado y se borraron las credenciales y los archivos guardados.';
}

export function nothingToUnlinkText() {
  return 'No tienes ninguna sesión de WhatsApp vinculada.';
}

export function cancelledText() {
  return 'Operación cancelada. No se realizó ningún cambio.';
}

export function genericErrorText() {
  return 'No se pudo completar la acción. Vuelve a intentarlo en unos segundos.';
}

export { escapeHtml };
