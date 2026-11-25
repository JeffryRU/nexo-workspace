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
  daemon: `Uso: nexo daemon status|stop|log

  status        informa si el daemon corre (versión, pid, puerto)
  stop          pide un apagado limpio (daemon.shutdown) y espera a que termine
  log [-n N]    últimas N líneas (50) del registro del daemon que arrancó la CLI
`,
}

export { GLOBALS }
