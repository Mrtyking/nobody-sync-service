import QRCode from 'qrcode';
import { config } from '../config.js';

/**
 * Renderiza el QR de vinculación en alta definición (PNG).
 * Se usa corrección de errores nivel H para que siga siendo legible
 * aunque Discord lo comprima o el usuario lo escanee desde otra pantalla.
 */
export async function renderQr(data) {
  return QRCode.toBuffer(data, {
    type: 'png',
    errorCorrectionLevel: 'H',
    margin: config.qr.margin,
    width: config.qr.size,
    color: {
      dark: config.qr.dark,
      light: config.qr.light,
    },
  });
}

/** Nombre único para forzar a Discord a recargar la imagen en cada renovación. */
export function qrFileName() {
  return `qr-${Date.now().toString(36)}.png`;
}
