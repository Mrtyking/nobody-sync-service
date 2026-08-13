# Nobody Sync

Bot de Discord que publica un panel con `/setpanel`. Desde ese panel cada usuario genera un
código QR en alta definición, vincula su WhatsApp y el bot mantiene la sesión conectada de
forma permanente.

Cuando llega una foto, un video o un audio **de una sola vez**, el bot lo descarga al instante
y lo guarda. Si alguien reacciona a ese mensaje con un emoji, recibe una copia en su propio
chat de WhatsApp, donde queda guardada para siempre.

---

## Cómo funciona

**Panel (`/setpanel`)**
Publica un contenedor con un GIF de cabecera y tres botones **dentro** del propio recuadro
(Components V2 de Discord, no botones sueltos debajo): generar QR, ver estado y desconectar.
Si la versión de discord.js o del gateway no admite Components V2, el panel se degrada solo a
un embed clásico. El GIF se cambia con `PANEL_GIF`; por defecto usa `assets/nobody.gif`.

**Estado del sistema**
El botón de estado no muestra un texto fijo: mide en el momento de pulsarlo la latencia del
websocket de Discord, el tiempo de respuesta real de la interacción y la latencia contra los
servidores de WhatsApp (el mismo ping `w:p` que Baileys usa como keep-alive). Añade servidores,
cuentas vinculadas y en línea, archivos guardados, entregas hechas, memoria, versión de Node y
tiempo encendido. La barra de color cambia sola: verde si las dos mitades responden, ámbar si
WhatsApp está caído pero reconectando, rojo si Discord no responde. Incluye un botón
**Actualizar** que vuelve a medirlo todo sin salir del mensaje.

**Vinculación**
El botón abre una respuesta privada (solo la ve quien pulsó) con el QR renderizado a
1024 × 1024, corrección de errores nivel H y márgenes limpios. El código se renueva solo cada
60 segundos hasta que se escanea o pasan 5 minutos. Las credenciales quedan en
`data/sessions/<id-de-discord>/`.

**Entrega fiable**
WhatsApp es de extremo a extremo: si el teléfono de destino no consigue descifrar un mensaje no
puede pedírselo al servidor, se lo pide al emisor. El bot guarda los últimos 256 mensajes en
memoria para poder atender esas peticiones de reenvío; sin esa caché el archivo se queda
eternamente en *"Esperando el mensaje. Esto puede tomar tiempo"*.

**Consola limpia**
libsignal escribe directamente en la consola y varios de sus avisos arrastran el volcado entero
del objeto de sesión, cientos de líneas de buffers por mensaje. El bot filtra ese ruido: el
mantenimiento normal del cifrado se descarta y lo que sí importa (fallos de descifrado, errores
de sesión) se resume en una línea, sin repetirse más de una vez cada 30 segundos. Con
`BAILEYS_LOG_LEVEL=debug` se deja pasar todo.

**Conexión permanente**
La sesión se reconecta sola con retroceso exponencial (2 s → 30 s) ante cualquier caída, y
todas las sesiones vinculadas se levantan de nuevo al arrancar el bot, escalonadas para no
golpear a WhatsApp con todas a la vez.

Solo deja de reintentar cuando el dispositivo pierde la autorización de verdad (401, 403, 405,
411). El código 500 **no** cuenta como definitivo: WhatsApp lo devuelve también en cortes
pasajeros, así que se reintenta y solo tras tres seguidos se da por perdida.

En ningún caso se borran las credenciales por su cuenta. La sesión queda marcada como
"pendiente de revincular", el usuario recibe un aviso por privado en Discord explicando qué
pasó, y sus archivos guardados siguen intactos. La limpieza ocurre cuando él pide un código
nuevo o pulsa Desconectar.

**Varias cuentas a la vez**
Cada usuario de Discord tiene su propia sesión, su carpeta de credenciales y su almacén de
archivos, y son independientes: que una se caiga o haya que revincularla no afecta a las demás.
Cada socket se numera internamente, de modo que un evento tardío de una conexión ya sustituida
no puede dejar muda a la que está viva. Cuenta con unos 60–80 MB de memoria por cuenta
conectada a la hora de elegir el plan del hosting.

**Notificaciones en el teléfono**
Un dispositivo vinculado que aparezca como activo hace que WhatsApp deje de avisar en el
teléfono. El bot se anuncia siempre como no disponible: al conectar, cada cinco minutos, y de
nuevo después de cada envío, que es cuando WhatsApp podría darlo por activo.

**Rescate de "una sola vez"**
El medio se descarga **en cuanto entra al dispositivo**, no al pedirlo: si se esperara a la
petición, el emisor ya podría haberlo abierto o borrado y el archivo dejaría de existir.
Después se envía lo ya guardado, más una nota con el origen y la fecha.

Hay dos formas de pedirlo, y las dos funcionan con cualquier emoji:

- **Respondiendo al mensaje** con un emoji (mantener pulsado → Responder → mandar el emoji).
  Es lo que se hace en la práctica.
- **Reaccionando** al mensaje con un emoji.

Detalles:

- La copia llega **siempre al chat privado de quien la pide**, nunca al chat donde estaba la
  foto. Si la pides tú, aparece en tu chat contigo mismo.
- Si la pide otro participante de un grupo, le llega a su chat privado. Se desactiva con
  `ALLOW_GUEST_REACTIONS=false`.
- Solo se acepta un mensaje formado únicamente por emojis, así que responder "qué risa" no
  dispara nada. Para limitarlo a emojis concretos: `TRIGGER_EMOJIS=⭐,📥`.
- Si el archivo no estaba guardado (el bot no estaba conectado cuando llegó), se intenta bajar
  de la copia citada que viaja dentro de la propia respuesta. Si tampoco se puede, avisa por
  privado en lugar de quedarse callado.
- Los archivos se borran del servidor a las `MEDIA_TTL_HOURS` horas (24 por defecto).

---

## Instalación

```bash
npm install
```

Copia `.env.example` a `.env` y rellena al menos `DISCORD_TOKEN` y `DISCORD_CLIENT_ID`.

```bash
npm start
```

### Configuración del bot en Discord

1. En el [portal de desarrolladores](https://discord.com/developers/applications) crea la
   aplicación y copia el **Application ID** (`DISCORD_CLIENT_ID`) y el **token** del bot.
2. No hacen falta intents privilegiados: el bot solo usa comandos y botones.
3. Invítalo con los permisos `bot` y `applications.commands`, y con permiso para **Ver canal**
   y **Enviar mensajes** en el canal del panel.
4. Pon tu `DISCORD_GUILD_ID` mientras pruebas: los comandos aparecen al instante en lugar de
   tardar hasta una hora.

---

## Despliegue en Veltramon

En el panel de **Bots y aplicaciones**, runtime Node.js 20 o superior:

1. Sube el proyecto (o conéctalo por Git). No subas `node_modules`, `.env` ni `data/`.
2. Comando de arranque: `npm start`.
3. Define las variables de entorno del `.env` desde la sección de variables del panel.
4. Deja `DATA_DIR` dentro del directorio del servidor (`./data` por defecto) para que las
   sesiones sobrevivan a los reinicios. **Si esa carpeta se borra, todos los usuarios tendrán
   que volver a escanear el QR.**

---

## Variables de entorno

| Variable | Por defecto | Para qué sirve |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | Token del bot. Obligatorio. |
| `DISCORD_CLIENT_ID` | — | Application ID. Obligatorio. |
| `DISCORD_GUILD_ID` | vacío | Registra los comandos solo en ese servidor, al instante. |
| `BRAND_NAME` | `Nobody Sync` | Nombre que aparece en el panel y en el dispositivo vinculado. |
| `PANEL_COLOR` | `#5865F2` | Color de la barra lateral del contenedor. |
| `PANEL_GIF` | `assets/nobody.gif` | GIF de cabecera del panel. Ruta relativa o absoluta. |
| `STATUS_OK_COLOR` | `#3BA55D` | Barra del estado cuando todo responde. |
| `STATUS_WARN_COLOR` | `#F0B232` | Barra cuando WhatsApp está reconectando. |
| `STATUS_DOWN_COLOR` | `#ED4245` | Barra cuando el servicio está caído. |
| `QR_SIZE` | `1024` | Lado del PNG en píxeles (256–2048). |
| `QR_MARGIN` | `2` | Margen del QR en módulos. |
| `QR_DARK` / `QR_LIGHT` | `#0B0B0F` / `#FFFFFF` | Colores del código. Mantén el contraste alto. |
| `QR_TIMEOUT_MS` | `60000` | Vida de cada código antes de renovarse. |
| `MEDIA_TTL_HOURS` | `24` | Horas que se guardan los archivos rescatados. |
| `TRIGGER_EMOJIS` | vacío | Emojis que activan el envío. Vacío = cualquiera. |
| `ALLOW_GUEST_REACTIONS` | `true` | Permite que otros participantes reciban su copia. |
| `NOTIFY_CAPTURES` | `true` | Aviso por DM en Discord con cada rescate. |
| `DATA_DIR` | `./data` | Carpeta persistente de sesiones y archivos. |
| `BAILEYS_LOG_LEVEL` | `silent` | `silent`, `error`, `warn`, `info` o `debug`. |

---

## Estructura

```
src/
  index.js              Arranque, avisos por DM y apagado limpio
  config.js             Lectura y validación del entorno
  status.js             Métricas en vivo de Discord, WhatsApp y proceso
  discord/
    commands.js         Definición y registro de /setpanel
    interactions.js     Router de comandos y botones, flujo del QR
  ui/
    render.js           Components V2 con fallback automático a embed
    views.js            Textos y estructura de cada pantalla
  utils/
    assets.js           Carga y cachea el GIF del panel
    console.js          Filtra el ruido que libsignal escribe por su cuenta
    logger.js           Log propio y logger de Baileys
    qr.js               Render del QR en HD
  whatsapp/
    baileys.js          Normaliza la API de Baileys entre versiones
    session.js          Socket, reconexión y ciclo de vida
    manager.js          Registro de sesiones y limpieza periódica
    mediaStore.js       Archivos en disco con caducidad
    messageCache.js     Últimos mensajes, para atender reenvíos
    viewOnce.js         Detección, descarga, disparadores y entrega
assets/                 GIF del panel
data/                   Credenciales y medios (no versionar)
```

---

## Antes de ponerlo en producción

- Baileys es una implementación no oficial de WhatsApp Web. Usarla va contra los términos de
  servicio de WhatsApp y la cuenta vinculada puede ser bloqueada. Prueba primero con un número
  secundario.
- La carpeta `data/` contiene credenciales de sesión completas y copias de fotos y videos
  privados. Restringe el acceso al servidor y no la incluyas en copias públicas.
- Guardar contenido de una sola vez elude una función pensada para que no quede copia. Si el
  bot lo van a usar terceros, avísales de que las reacciones dejan copias en el servidor.
