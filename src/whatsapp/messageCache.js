/**
 * Últimos mensajes vistos, por id.
 *
 * WhatsApp es de extremo a extremo: si el aparato receptor no consigue
 * descifrar algo, no puede pedírselo al servidor, se lo pide al emisor. Baileys
 * atiende esa petición llamando a `getMessage(key)`, y si no devolvemos el
 * contenido original el mensaje se queda para siempre en "Esperando el
 * mensaje". Esta caché es lo que permite responder a esos reenvíos.
 */
export class MessageCache {
  constructor(limit = 256) {
    this.limit = limit;
    this.entries = new Map();
  }

  set(id, content) {
    if (!id || !content) return;
    // Reinsertar lo mueve al final: el primero de la lista es el más antiguo.
    this.entries.delete(id);
    this.entries.set(id, content);
    if (this.entries.size > this.limit) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }

  get(id) {
    return id ? this.entries.get(id) : undefined;
  }

  get size() {
    return this.entries.size;
  }
}
