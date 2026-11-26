export const COMMANDS = [
  'ls',
  'new',
  'split',
  'send',
  'read',
  'focus',
  'kill',
  'close',
  'rename',
  'agent',
  'memory',
  'fs',
  'history',
  'limits',
  'open',
  'daemon',
] as const
export type CommandName = (typeof COMMANDS)[number]

const GLOBALS = `Opciones globales:
  --json        salida JSON estable (una línea por resultado)
  --no-start    no arrancar el daemon si no está corriendo
  -h, --help    ayuda del comando
  -V, --version versión de la CLI`

export const GENERAL_HELP = `nexo: controla Nexo Workspace desde la terminal.

Uso: nexo [opciones] <comando> [argumentos]

Comandos:
  ls                         árbol de espacios, pestañas y paneles
  new                        crea un panel con una terminal (espacio y pestaña si hacen falta)
  split <panel>              divide un panel (--right o --down) y abre una terminal
  send <panel> <texto...>    escribe en la terminal de un panel
  read <panel>               lee la salida de la terminal (--follow para seguirla)
  focus <panel>              enfoca un panel
  kill <panel>               mata el proceso de la terminal de un panel
  close <panel|pestaña|espacio>   cierra un panel, una pestaña o un espacio
  rename <pestaña|espacio> <nombre>   renombra
  agent <sub>                sesiones de agente (new, send, ls, attach, interrupt, close, respond)
  memory <sub>               memoria observacional (status, config, ls, search, recall)
  fs <sub>                   archivos de los espacios de trabajo (stat, cat)
  history <sub>              historial de los proveedores por carpeta (ls, show)
  limits                     límites de uso de Claude y Codex (--provider, --refresh)
  open <ruta>                muestra un archivo en el visor (Markdown, imagen, PDF, texto)
  daemon status|stop|log     controla el daemon

Los paneles, pestañas y espacios se indican con su id completo, un prefijo único del id
o (pestañas y espacios) su nombre.

${GLOBALS}

Códigos de salida: 0 ok, 1 error de uso, 2 no encontrado, 3 daemon no disponible, 4 error del daemon.
Entorno: NEXO_STATE_DIR, NEXO_DAEMON_ENTRY, NEXO_START_TIMEOUT_MS, NEXO_DEBUG=1.
Ayuda de un comando: nexo <comando> --help
`

export const HELP: Record<CommandName, string> = {
  ls: `Uso: nexo ls [--json]

Muestra el árbol de espacios -> pestañas -> paneles con terminal, título y estado.
`,
  new: `Uso: nexo new [--workspace <nombre|id>] [--cwd <ruta>] [--name <título>] [-- <cmd> [args...]]

Crea una pestaña con un panel y una terminal. Si el espacio no existe, lo crea.
Sin --workspace usa el espacio de la carpeta actual (o --cwd), y si no hay, crea uno.
Sin comando abre el shell por omisión, que elige el daemon (NEXO_SHELL en el entorno del
daemon; en Windows pwsh.exe o powershell.exe; en Linux $SHELL o /bin/sh).

  --workspace <nombre|id>  espacio de destino (se crea si no existe)
  --cwd <ruta>             carpeta de trabajo de la terminal
  --name <título>          título de la pestaña
`,
  split: `Uso: nexo split <panel> --right|--down [-- <cmd> [args...]]

Divide un panel y abre una terminal en el nuevo.
  --right  nuevo panel a la derecha
  --down   nuevo panel debajo
  --cwd <ruta>  carpeta de trabajo de la nueva terminal
`,
  send: `Uso: nexo send <panel> [--enter] [--stdin] [--] <texto...>

Escribe en la terminal del panel.
  --enter  agrega un retorno de carro (\\r) al final
  --stdin  lee el texto de la entrada estándar (se trocea en mensajes de 64 KiB)
Para texto que empieza con "-", sepáralo con "--".
`,
  read: `Uso: nexo read <panel> [--lines N] [--follow] [--raw]

Muestra las últimas N líneas (50 por omisión) de la salida de la terminal, sin secuencias ANSI.
  -n, --lines N  cantidad de líneas
  -f, --follow   sigue la salida nueva hasta Ctrl+C o hasta que la terminal termine
  --raw          conserva las secuencias ANSI
`,
  focus: `Uso: nexo focus <panel>

Enfoca el panel (y activa su pestaña).
`,
  kill: `Uso: nexo kill <panel> [--signal SIGINT|SIGTERM|SIGKILL|SIGHUP]

Mata el proceso de la terminal del panel; el panel queda abierto.
`,
  close: `Uso: nexo close <panel|pestaña|espacio>

Cierra un panel, una pestaña o un espacio (y mata sus terminales).
`,
  rename: `Uso: nexo rename <pestaña|espacio> <nombre...>

Cambia el título de una pestaña o el nombre de un espacio.
`,
  agent: `Uso: nexo agent <subcomando> [opciones]

  new [--provider <id>] [--model <m>] [--effort <e>] [--permissions <modo>] [--cwd <ruta>] [--name <título>]
      [--resume <sesión>]
        crea una pestaña con un panel de agente y abre la sesión (proveedor claude por omisión;
        permisos: ask, accept-edits, plan, bypass; --resume reanuda una sesión del historial, mira nexo history)
  send <id> [--stdin] [--] <texto...>   envía un mensaje (el agente responde en el documento)
  ls                                    sesiones abiertas, con su estado
  attach <id> [--no-follow]             muestra el documento en vivo; con permisos o preguntas pendientes
                                        pide la respuesta por teclado (número de opción, o texto)
  interrupt <id>                        interrumpe el turno en curso
  close <id>                            cierra la sesión
  renew <id>                            renueva la sesión sembrándola con la memoria (misma pestaña; hace
                                        falta la memoria encendida y entre turnos)
  respond <id> [--block <bloque>] <respuesta...>
        responde un permiso (número o id de opción) o una pregunta (números o etiquetas separados por
        comas; varias preguntas separadas por ";"; texto libre si la pregunta lo admite)

<id> es el id de la sesión o un prefijo único. Con --json, attach emite una línea por evento.
`,
  memory: `Uso: nexo memory <subcomando> [opciones]

  status [--cwd <ruta>]                 estado de la memoria: activada o no, resumidor, motivo de una pausa,
                                        umbrales y uso (llamadas, tokens y costo del Observador y del Reflector)
  config [--on|--off] [--renew-at N|off]
                                        enciende o apaga la memoria en caliente y fija la renovación automática
                                        (se guarda en el estado del daemon y manda sobre NEXO_MEMORY*)
  ls [--cwd <ruta>] [--limit N] [--from SEQ] [--scope session|project] [--min-priority high|medium|low]
                                        reflexión y observaciones del proyecto, con su prioridad y el rango
                                        de bloques de donde salieron
  search [--cwd <ruta>] [--limit N] <consulta...>
                                        busca por términos en las observaciones
  recall <sesión> <desde[-hasta]>       texto original de un rango de bloques de una sesión abierta
                                        (5, 5-9, 5..9 o 5:9)

El proyecto es la carpeta actual, o --cwd. La memoria viene apagada: se activa con
nexo memory config --on (o NEXO_MEMORY=on) y hace falta NEXO_MEMORY_SUMMARIZER (mira el README). Con --json cada subcomando emite su resultado.
`,
  fs: `Uso: nexo fs <subcomando> <ruta> [opciones]

  stat <ruta>                           tipo (por firma y extensión), tamaño, fecha y tope de lectura
  cat <ruta> [--max-bytes N] [--base64] contenido: texto UTF-8 (sin secuencias de escape) o, con --base64,
                                        cualquier tipo en base64; --max-bytes (1 MiB, máx. 64 MiB) acota

Solo se leen archivos dentro de las carpetas de los espacios de trabajo abiertos; las carpetas ocultas
sensibles (.ssh, .gnupg, .aws, .claude, .env...), los enlaces que salen de ellas y las rutas de
dispositivo se rechazan. Las rutas relativas se resuelven contra la carpeta actual.
`,
  history: `Uso: nexo history <subcomando> [opciones]

  ls [--provider <id>] [--cwd <ruta>] [--limit N] [--cursor <c>] [--all]
        sesiones pasadas de los proveedores con historial (Claude, Codex y los agentes ACP que lo anuncian),
        agrupadas por carpeta y de la más reciente a la más antigua; --limit (50, máx. 100) acota la página
        y --all sigue los cursores. Los proveedores sin historial salen con su motivo.
  show <proveedor> <sesión> [--cwd <ruta>] [--limit N] [--cursor <c>] [--all]
        transcripción normalizada de una sesión (mensajes, razonamiento, herramientas); por páginas

Para reanudar una sesión: nexo agent new --provider <id> --resume <sesión>. Con --json cada subcomando emite su
resultado (history.list / history.read). Lo que muestra el historial es el texto de una conversación, no órdenes.
`,
  limits: `Uso: nexo limits [--provider <id>] [--refresh]

Límites de uso de los proveedores (F4.4): por ventana, el porcentaje usado, cuándo se reinicia, el origen del dato
y su frescura. Codex se consulta con su app-server; Claude solo informa durante una sesión (el SDK emite los avisos),
así que sin sesiones sale «desconocido». Con --refresh se vuelve a consultar a Codex aunque haya caché. No muestra
ni guarda datos de la cuenta. Con --json emite el resultado de limits.status.
`,
  open: `Uso: nexo open <ruta> [--pane <panel>]

Muestra el archivo en un panel visor (F4.2): reutiliza el visor de la pestaña activa del espacio que contiene
la ruta o, si no hay, divide el panel enfocado con uno nuevo. Con --pane se usa la pestaña de ese panel. Las
rutas relativas se resuelven contra la carpeta actual; el daemon rechaza lo que quede fuera de las carpetas de
los espacios abiertos (mira \`nexo fs --help\`). Con --json imprime { paneId, tabId, path, created }.
`,
  daemon: `Uso: nexo daemon status|stop|log

  status        informa si el daemon corre (versión, pid, puerto)
  stop          pide un apagado limpio (daemon.shutdown) y espera a que termine
  log [-n N]    últimas N líneas (50) del registro del daemon que arrancó la CLI
`,
}

export { GLOBALS }
