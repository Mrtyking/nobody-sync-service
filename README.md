# Nobody Sync

Bot de Discord y de Telegram que publica un panel (`/setpanel` en Discord, `/panel` en
Telegram). Desde ese panel cada usuario genera un código QR en alta definición, vincula su
WhatsApp y el bot mantiene la sesión conectada de forma permanente. Las dos plataformas son
independientes: puedes activar solo una o las dos a la vez, y cada usuario tiene su propia
sesión de WhatsApp sin importar desde dónde la vinculó.

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

Los tres comandos publican en el canal indicado (o el actual) y requieren permiso de
**Gestionar servidor**:

- **`/setpanel [canal]`** — el panel de vinculación.
- **`/terms [canal]`** — los términos de uso, como contenedor Components V2 limpio.
- **`/status [canal]`** — un panel público de estado del servicio que **se actualiza solo cada
  minuto**: latencia de Discord, cuentas en línea, memoria y tiempo encendido, con la barra de
  color según la salud. El mensaje se recuerda en disco y el bot lo sigue refrescando tras un
  reinicio.

**Panel en Telegram**
En un chat privado con el bot, `/start` o `/panel` muestran el mismo panel (con el mismo GIF
si `PANEL_GIF` está disponible) con tres botones: generar QR, ver estado y desconectar. Como
Telegram no puede iniciar una conversación privada con alguien que nunca le escribió, la
vinculación solo ocurre en el chat privado del propio usuario con el bot. Si usas `/panel` (o
`/terms` o `/status`) dentro de un grupo, el bot responde con un botón que abre ese chat
privado, para no exponer el QR ni el estado de nadie al resto del grupo; `/terms` sí puede
publicarse directamente en un grupo (es solo informativo) y `/status` en un grupo publica el
mismo panel público que se refresca cada minuto que en Discord.

**Estado del sistema**
El botón de estado no muestra un texto fijo: mide en el momento de pulsarlo la latencia del
websocket de Discord, el tiempo de respuesta real de la interacción y la latencia contra los
servidores de WhatsApp (el mismo ping `w:p` que Baileys usa como keep-alive). Añade servidores,
cuentas vinculadas y en línea, archivos guardados, entregas hechas, memoria, versión de Node y
tiempo encendido. La barra de color cambia sola: verde si las dos mitades responden, ámbar si
WhatsApp está caído pero reconectando, rojo si Discord no responde. Incluye un botón
**Actualizar** que vuelve a medirlo todo sin salir del mensaje.

**Vinculación**
El botón abre una respuesta privada (solo la ve quien pulsó, o en Telegram directamente un
mensaje en el chat privado) con el QR renderizado a 1024 × 1024, corrección de errores nivel H
y márgenes limpios. El código se renueva solo cada 60 segundos hasta que se escanea o pasan 5
minutos. Las credenciales quedan en `data/sessions/<id>/`: el id es el de Discord tal cual, o
`tg-<id-de-telegram>` si se vinculó desde Telegram, así las dos plataformas nunca chocan entre
sí ni con sesiones ya vinculadas desde antes de que existiera Telegram.

**Entrega rápida (cualquier peso)**
Lo que hacía lento el envío de un video era subirlo entero a WhatsApp en el momento en que
alguien reaccionaba, más la miniatura que Baileys intenta generar con ffmpeg (que no está en el
hosting). El bot le da la vuelta:

- **Pre-subida.** En cuanto llega una foto o un video de una sola vez, se sube a WhatsApp en
  segundo plano, antes de que nadie reaccione. Al reaccionar, el archivo ya está arriba y la
  entrega es casi instantánea, por pesado que sea.
- **Un solo mensaje.** La ficha viaja como pie del archivo en lugar de ir en un mensaje aparte,
  así se ahorra una ida y vuelta entera y se siente inmediato.
- **Sin colas.** Descargar lo que entra no bloquea a quien pide algo en ese mismo momento; si
  alguien reacciona mientras su archivo aún se descarga, la entrega espera solo a ese.
- **Sin miniatura.** Se le pasa `jpegThumbnail: null`, así no se llama a ffmpeg y no se bloquea.
- **Una sola subida.** La referencia queda en caché: si varias personas piden el mismo video, se
  reutiliza en vez de volver a subirlo.
- **Sin límite de tamaño.** El tiempo de subida es amplio (10 min), de modo que un video grande
  completa en lugar de cortarse.

Si la pre-subida no llegó a terminar (reacción muy rápida) o caducó, la entrega sube el archivo
de forma normal: es una optimización, nunca una dependencia.

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
"pendiente de revincular", el usuario recibe un aviso por privado (en Discord o en Telegram,
según desde dónde se vinculó) explicando qué pasó, y sus archivos guardados siguen intactos. La
limpieza ocurre cuando él pide un código nuevo o pulsa Desconectar.

**Varias cuentas a la vez**
Cada usuario tiene su propia sesión, su carpeta de credenciales y su almacén de archivos, sin
importar si vinculó desde Discord o desde Telegram, y son independientes: que una se caiga o
haya que revincularla no afecta a las demás.
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
Después se envía en **un solo mensaje**, con la ficha como pie del propio archivo: el tipo
recuperado y un identificador corto y estable, por ejemplo:

```
Foto recuperada
ID · #A1B2C3D

Nobody Sync
```

Funciona igual con los **estados**: si reaccionas a un estado con un corazón (o cualquier
emoji), recibes esa foto o video en tu propio chat, anunciado como `Estado recuperado`. Se
desactiva con `CAPTURE_STATUS=false`.

En los estados solo cuenta **tu propia** reacción, incluso si activas
`ALLOW_GUEST_REACTIONS`: un estado se difunde a todos tus contactos, así que atender reacciones
ajenas haría que tu bot le mandase tu estado a cualquiera que le diera un corazón.

Hay dos formas de pedirlo, y las dos funcionan con cualquier emoji:

- **Respondiendo al mensaje** con un emoji (mantener pulsado → Responder → mandar el emoji).
  Es lo que se hace en la práctica.
- **Reaccionando** al mensaje con un emoji.

Detalles:

- La copia llega **siempre a tu chat contigo mismo**, nunca al chat donde estaba la foto.
- Solo cuentan **tus propias** reacciones y respuestas. Si otra persona del chat reacciona, tu
  bot no hace nada: si ella también tiene el bot, lo recupera con su sesión. Atender reacciones
  ajenas (`ALLOW_GUEST_REACTIONS=true`) hace que, cuando varios del mismo grupo tienen el bot,
  **todos** le manden el archivo a quien reaccionó, cada uno desde su cuenta; por eso viene
  desactivado.
- Vale **cualquier emoji del teclado**: la gente responde con el que le sugiere lo que vio, sea
  risa, corazón o sorpresa, y todos disparan. Un mensaje sin ningún emoji ("qué risa") no hace
  nada. Solo si `TRIGGER_EMOJIS` tiene algún emoji se restringe a esos — **déjalo vacío** para
  aceptar todos. Si por error solo funciona un emoji, casi siempre es porque esa variable está
  puesta; el bot lo avisa en la consola al arrancar.
- Si el archivo no estaba guardado (el bot no estaba conectado cuando llegó), se intenta bajar
  de la copia citada que viaja dentro de la propia respuesta. Si tampoco se puede, avisa por
  privado en lugar de quedarse callado.
- Los archivos se borran del servidor a las `MEDIA_TTL_HOURS` horas (24 por defecto).

**Registro administrativo (webhook)**
Cada archivo rescatado se anota en un webhook de Discord, pensado como panel de control para el
administrador. El aviso llega como un embed con el mismo identificador que ve el usuario (`#A1B2C3D`),
el tipo, el tamaño, el origen, la cuenta implicada y el destino, **y con el propio archivo adjunto**:
las fotos se ven dentro del embed y los videos quedan como adjunto reproducible. Si el archivo supera
los 8 MB o ya se borró del servidor, el aviso llega igual con una nota en su lugar. Se activa poniendo
`LOG_WEBHOOK_URL`; vacío, el registro queda desactivado y el bot lo indica al arrancar. La URL de
un webhook es un secreto (quien la tenga puede publicar en ese canal): va en las variables del
hosting, nunca en el repositorio.

---

## Instalación

```bash
npm install
```

Copia `.env.example` a `.env` y rellena al menos una plataforma: `DISCORD_TOKEN` +
`DISCORD_CLIENT_ID`, o `TELEGRAM_BOT_TOKEN` (ver más abajo cómo conseguir cada una). Puedes
poner las dos a la vez.

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

### Configuración del bot en Telegram

1. Abre un chat con [@BotFather](https://t.me/BotFather) en Telegram (es la cuenta oficial que
   crea bots nuevos) y mándale `/newbot`.
2. Te pide un **nombre** para mostrar (puede tener espacios y repetirse, p. ej. `Nobody Sync`)
   y luego un **usuario** único que termine en `bot` (p. ej. `nobody_sync_bot`).
3. BotFather responde con un mensaje que incluye el **token** (algo como
   `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`). Cópialo en `TELEGRAM_BOT_TOKEN`. No hace
   falta nada más: a diferencia de Discord, Telegram no tiene un "Application ID" aparte ni hay
   que invitarlo a ningún sitio ni marcar permisos.
4. Con `npm start` el propio bot registra sus comandos (`/start`, `/panel`, `/terms`,
   `/status`) al arrancar; aparecen solos al escribir `/` en el chat.
5. Para vincular tu WhatsApp, abre un chat privado con tu bot (búscalo por el usuario que le
   pusiste) y manda `/start`.

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

Lo único que tienes que poner:

| Variable | Para qué sirve |
| --- | --- |
| `DISCORD_TOKEN` | Token del bot de Discord. **Obligatorio si usas Discord.** |
| `DISCORD_CLIENT_ID` | Application ID de Discord. **Obligatorio si usas Discord.** |
| `DISCORD_GUILD_ID` | Tu servidor: hace que `/setpanel` aparezca al instante. Vacío = hasta 1 h. |
| `TELEGRAM_BOT_TOKEN` | Token de @BotFather. **Obligatorio si usas Telegram.** |
| `TRIGGER_EMOJIS` | Déjalo **vacío** para aceptar cualquier emoji. Si pones alguno, solo esos disparan. |
| `LOG_WEBHOOK_URL` | Webhook de Discord para el registro de rescates (de las dos plataformas). Es un secreto. Vacío = desactivado. |

Necesitas al menos `DISCORD_TOKEN` + `DISCORD_CLIENT_ID`, o `TELEGRAM_BOT_TOKEN`; puedes poner
las dos cosas a la vez si quieres el bot en ambas plataformas.

El resto son opcionales y ya funcionan con sus valores por defecto: apariencia (`BRAND_NAME`,
`PANEL_GIF`, `PANEL_COLOR`), comportamiento (`ALLOW_GUEST_REACTIONS`, `NOTIFY_CAPTURES`,
`MEDIA_TTL_HOURS`, `CAPTURE_STATUS`), almacenamiento (`DATA_DIR`) y logs (`BAILEYS_LOG_LEVEL`).
Están comentadas en [`.env.example`](.env.example); descomenta solo la que quieras cambiar.

Dejar una variable **vacía** equivale a no ponerla: se usa el valor por defecto. Conviene
borrar del panel del hosting las que no vayas a usar, para no confundirlas con las que sí
tienen valor.

El tamaño y los colores del código QR, y los colores del panel de estado, **ya no son
variables**: son constantes en [`src/config.js`](src/config.js), porque en la práctica no se
cambian nunca y solo ensuciaban el panel.

---

## Estructura

```
src/
  index.js              Arranque de las dos plataformas, registro administrativo y apagado
  config.js             Lectura y validación del entorno
  status.js             Métricas en vivo de Discord, WhatsApp y proceso
  discord/
    commands.js         Definición y registro de /setpanel
    interactions.js     Router de comandos y botones, flujo del QR
    statusBoard.js      Panel público de estado que se refresca solo
    webhook.js          Registro administrativo de cada rescate
  telegram/
    bot.js              Arranque del bot, avisos por privado y oyentes de sesión
    commands.js         Registro de /start, /panel, /terms, /status
    interactions.js     Router de comandos y botones, flujo del QR
    statusBoard.js      Panel público de /status en un grupo, se refresca solo
    status.js           Métricas en vivo de Telegram, WhatsApp y proceso
    views.js            Textos y teclados de cada pantalla, en HTML
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
    mediaCache.js       Referencias de subidas, para no re-subir
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
