/**
 * Caché de medios que Baileys consulta antes de subir un archivo. Guarda solo
 * la *referencia* al archivo ya cifrado y subido (url, claves, tamaño), no los
 * bytes, así que ocupa muy poco. Un acierto evita volver a subir el video: por
 * eso, si se pre-sube al llegar, la entrega posterior es casi instantánea.
 *
 * Implementa la interfaz mínima que Baileys espera (get/set/del/flushAll) para
 * no depender de la caché interna de la librería.
 */
export function makeMediaCache(ttlMs) {
  const store = new Map(); // clave -> { value, expires }

  const fresh = (entry) => entry && (entry.expires === 0 || entry.expires > Date.now());

  return {
    get(key) {
      const entry = store.get(key);
      if (!fresh(entry)) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      store.set(key, { value, expires: ttlMs ? Date.now() + ttlMs : 0 });
    },
    del(key) {
      store.delete(key);
    },
    flushAll() {
      store.clear();
    },
  };
}
