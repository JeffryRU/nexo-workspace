# Nexo Workspace

App de escritorio (Linux y Windows) para trabajar con varios agentes de programación (Claude Code,
Codex, Gemini, Antigravity, modelos locales) y terminales reales en pestañas y paneles, al estilo de un
multiplexor. Un daemon es la única fuente de verdad; la ventana, la CLI y el servidor MCP son clientes
iguales: cerrar la ventana no mata agentes ni terminales.

Estado: **F2 completa**. Terminales, daemon, CLI, web y escritorio (F0 y F1) están hechos. De la F2 (agente Claude Code)
va el modelo normalizado de agentes: bloques, protocolo `agent.*` y `AgentProviderPort` con su falso (F2.1), el servicio de agentes de
`core` (F2.2) y el adaptador `provider-claude` (F2.3, Claude Agent SDK; se autentica con
`ANTHROPIC_API_KEY` o `CLAUDE_CODE_OAUTH_TOKEN` del entorno del daemon, ver «Proveedor Claude» en
`docs/ARCHITECTURE.md`), el daemon, el cliente y la CLI de agentes (F2.4) el panel de agente de la interfaz web
(F2.5) y la atención en la barra con notificaciones del sistema y mediciones de rendimiento del agente (F2.6; ver
[`docs/ROADMAP.md`](docs/ROADMAP.md)).

## Requisitos

- Node.js 24 o superior
- pnpm 12 (`corepack enable` lo activa a partir del campo `packageManager`)
- Rust estable, solo para `apps/desktop` (fase F1)

## Comandos

```
pnpm install
pnpm check       # typecheck + lint + formato + pruebas con cobertura + dependency-cruiser
pnpm test        # Vitest (con cobertura; umbral 90 % en contracts y core)
pnpm typecheck
pnpm lint
pnpm format
pnpm depcruise   # reglas de dependencias entre paquetes
```

## CLI `nexo`

```
pnpm --filter @nexo/cli start -- ls        # o: node apps/cli/src/main.ts ls
```

Si el daemon no corre, la CLI lo arranca desacoplado (registro en `daemon.log` del directorio de estado);
`--no-start` lo evita. Los paneles, pestañas y espacios se indican con su id, un prefijo único o su nombre.

- `nexo ls`: árbol de espacios, pestañas y paneles.
- `nexo new [--workspace X] [--cwd R] [--name T] [-- cmd args]`: pestaña y terminal nuevas (shell por omisión).
- `nexo split <panel> --right | --down [-- cmd]`: divide un panel.
- `nexo send <panel> [--enter] [--stdin] [--] texto`: escribe en la terminal (mensajes de 64 KiB como máximo).
- `nexo read <panel> [-n N] [-f] [--raw]`: últimas N líneas sin ANSI; `-f` sigue la salida.
- `nexo focus <ref>`, `nexo kill <ref>`, `nexo close <ref>`, `nexo rename <pestaña|espacio> <nombre>`.
- `nexo agent new | send | ls | attach | interrupt | close | respond`: sesiones de agente (ver abajo).
- `nexo daemon status | stop | log`: estado, apagado limpio y registro.

Globales: `--json` (salida estable), `--no-start`, `--help`, `--version`. Salida: 0 ok, 1 uso, 2 no
encontrado, 3 daemon no disponible, 4 error del daemon. Entorno: `NEXO_STATE_DIR`, `NEXO_SHELL`,
`NEXO_DAEMON_ENTRY`, `NEXO_START_TIMEOUT_MS`, `NEXO_DEBUG=1` (trazas).

## Agentes (Claude Code)

```
nexo agent new --cwd ~/proyecto [--model sonnet] [--effort high] [--permissions ask]
nexo agent send <id> "explícame este repo"     # o --stdin
nexo agent attach <id>                         # documento en vivo; responde permisos y preguntas con el teclado
nexo agent respond <id> 1                      # lo mismo desde otra terminal (número u opción)
nexo agent ls | interrupt <id> | close <id>    # todos aceptan --json
```

**Probarlo con Claude real.** Nexo no tiene inicio de sesión ni lee credenciales de claude.ai: el daemon usa el
entorno con el que arranca. Exporta una de estas dos variables **antes de arrancar el daemon** (si ya corre,
detenlo con `nexo daemon stop`):

- `ANTHROPIC_API_KEY`: una clave de API de Anthropic, o
- `CLAUDE_CODE_OAUTH_TOKEN`: el token propio que genera `claude setup-token` con tu suscripción.

```
export CLAUDE_CODE_OAUTH_TOKEN=...   # PowerShell: $env:CLAUDE_CODE_OAUTH_TOKEN = '...'
nexo agent new --cwd .               # arranca el daemon (si hace falta) y abre la sesión
nexo agent send <id> "hola"
nexo agent attach <id>
```

**En la interfaz.** El botón ✦ de la barra de pestañas (o `Alt+Shift+A`) abre una pestaña de agente; `Alt+Shift+E` (o ✦ en la
cabecera del panel) divide el panel actual con un agente. El panel muestra la conversación como un documento
virtualizado (Markdown seguro, razonamiento y acciones plegables con diff y salida, permisos y preguntas en línea,
plan, errores y uso), y un redactor con chips de proveedor, modelo, esfuerzo, permisos y carpeta (se fijan al enviar el
primer mensaje). Intro envía, Mayús+Intro hace un salto de línea, Esc interrumpe; en un permiso pendiente, `1`-`4`
eligen la opción y `Alt+Mayús+↓/↑` saltan entre los pendientes. Para probarlo sin gastar nada: `NEXO_AGENT_PROVIDERS=fake pnpm dev:web`
(responde `Eco: …`; las palabras `permiso`, `pregunta`, `largo`, `lento`, `editar` (diff), `ansi` (salida con colores) y
`bloques [n]` y `charla [n]` provocan cada caso).

**Atención y notificaciones.** Cada pestaña, espacio y panel muestra el estado del agente (`working` pulsa; `needs-input` lleva un
contador de permisos y preguntas pendientes; `done` se queda hasta que enfocas el panel; `error`), y el título de la ventana lleva
el número de paneles que reclaman atención. `Alt+Shift+N` salta al siguiente panel que lo necesita, en cualquier pestaña o
espacio. El interruptor «Notificaciones» del pie activa los avisos del sistema (se piden permisos con ese clic) cuando la ventana
no tiene el foco; en el escritorio usan el plugin oficial de Tauri. Se agrupan y se limita su frecuencia. Detalle en
`docs/ARCHITECTURE.md` («Atención y notificaciones (F2.6)»).

![Atención en la barra y en las pestañas](docs/capturas/f2-6-atencion.png)

Sin credenciales el agente responde con un bloque de error que explica las dos opciones. `NEXO_CLAUDE_EXECUTABLE`
apunta a otro ejecutable de Claude Code (por omisión se usa el que trae el SDK). Para probar sin gastar nada, el
daemon acepta `NEXO_AGENT_PROVIDERS=fake` (proveedor determinista de pruebas; `nexo agent new --provider fake`);
no lo actives en uso normal. Una prueba opcional con Claude real: `NEXO_LIVE_CLAUDE=1 pnpm --filter @nexo/adapter-provider-claude test:live`.

**Probarlo con Ollama (local, sin cuentas).** Instala [Ollama](https://ollama.com), arráncalo y descarga un modelo
(`ollama pull llama3.2`). Habilita el proveedor al arrancar el daemon y úsalo desde la CLI o desde los chips del
panel (proveedor, modelo y esfuerzo `think`/`no-think`; si Ollama no responde, el proveedor sale deshabilitado con su motivo):

```
export NEXO_AGENT_PROVIDERS=claude,ollama      # PowerShell: $env:NEXO_AGENT_PROVIDERS = 'claude,ollama'
export NEXO_OLLAMA_URL=http://127.0.0.1:11434  # opcional: es el valor por omisión (solo http/https)
nexo agent new --provider ollama --model llama3.2 --cwd .
```

Ollama no guarda conversaciones: Nexo guarda el historial en memoria (con un tope de 2 MiB) y no se puede reanudar una
sesión; solo hay texto y razonamiento, sin herramientas ni permisos. Una prueba opcional con un Ollama real:
`NEXO_LIVE_OLLAMA=1 pnpm --filter @nexo/adapter-provider-ollama test:live`.

![Selector de proveedor, modelo y esfuerzo con Ollama](docs/capturas/f3-1-selector.png)

**Usar Codex (la CLI de OpenAI).** Instala la CLI (`npm i -g @openai/codex`) e inicia sesión **tú** con `codex login`: Nexo
no hace login ni lee tus credenciales, solo lanza `codex app-server` y usa la sesión que ya tengas. Habilita el proveedor
y úsalo desde la CLI o desde los chips del panel (modelos y esfuerzos salen del propio Codex; las aprobaciones de comandos
y de cambios de archivo aparecen en línea). Sin la CLI o sin sesión, el proveedor sale deshabilitado con su motivo:

```
export NEXO_AGENT_PROVIDERS=claude,codex       # PowerShell: $env:NEXO_AGENT_PROVIDERS = 'claude,codex'
export NEXO_CODEX_EXECUTABLE=/ruta/a/codex     # opcional: por omisión se busca «codex» en el PATH
nexo agent new --provider codex --permissions accept-edits --cwd .
```

Los modos de permiso se traducen a la política de aprobación y al sandbox de Codex (`ask` → `untrusted` +
`workspace-write`, `accept-edits` → `on-request` + `workspace-write`, `plan` → `on-request` + `read-only`, `bypass` →
`never` + `danger-full-access`; tabla en [la arquitectura](docs/ARCHITECTURE.md)). En Windows Nexo lanza el `codex.exe` (o,
si solo hay el `codex.cmd` de npm, su `codex.js` con Node) sin pasar por un shell. Una prueba opcional con Codex real
(usa tu cuenta y consume cuota): `NEXO_LIVE_CODEX=1 pnpm --filter @nexo/adapter-provider-codex test:live`.

![Aprobación de un comando de Codex en línea](docs/capturas/f3-2-aprobacion.png)

**Usar Gemini u otro agente ACP.** Nexo habla el [Agent Client Protocol](https://agentclientprotocol.com) con cualquier agente que lo
implemente; cada agente es un proveedor. Por omisión existe `gemini` (Gemini CLI: `npm i -g @google/gemini-cli`; Nexo lo lanza con
`gemini --acp`). Inicia sesión **tú** en el agente (Nexo no hace login ni lee credenciales); sin el comando o sin sesión, el
proveedor sale deshabilitado con su motivo:

```
export NEXO_AGENT_PROVIDERS=claude,gemini      # PowerShell: $env:NEXO_AGENT_PROVIDERS = 'claude,gemini'
nexo agent new --provider gemini --cwd .
```

Para **declarar otro agente ACP** se usa `NEXO_ACP_AGENTS` (JSON: lista de `{ id, name, command, args?, env? }`; el `id` no puede ser
`claude`, `codex`, `antigravity`, `ollama` ni `fake`) y se añade su id a `NEXO_AGENT_PROVIDERS`:

```
export NEXO_ACP_AGENTS='[{"id":"mi-agente","name":"Mi agente","command":"mi-agente-cli","args":["--acp"]}]'
export NEXO_AGENT_PROVIDERS=claude,gemini,mi-agente
nexo agent new --provider mi-agente --cwd .
```

Declarar un agente con id `gemini` sustituye al de omisión (p. ej. para cambiar sus argumentos). Los modos de permiso, los modelos
y la reanudación salen de lo que anuncie el agente (los modos `default`, `autoEdit`, `plan` y `yolo` de Gemini equivalen a `ask`,
`accept-edits`, `plan` y `bypass`; tabla en [la arquitectura](docs/ARCHITECTURE.md)). Nexo no ofrece `fs` ni `terminal` al agente.
Una prueba opcional con un agente real (usa tu cuenta y consume cuota): `NEXO_LIVE_ACP=1 pnpm --filter @nexo/adapter-provider-acp test:live`.

![Plan de un agente ACP](docs/capturas/f3-3-plan.png)

**Usar Antigravity (la CLI `agy`).** Instala la CLI de Antigravity e inicia sesión **tú** con ella (`agy`): Nexo no hace login ni
lee tus credenciales, solo lanza `agy` con salida `stream-json` y usa la sesión que ya tengas. Cada mensaje es un proceso `agy`
que retoma la conversación (`--conversation`); los modelos salen de `agy models`. Sin la CLI o sin sesión, el proveedor sale
deshabilitado con su motivo:

```
export NEXO_AGENT_PROVIDERS=claude,antigravity   # PowerShell: $env:NEXO_AGENT_PROVIDERS = 'claude,antigravity'
export NEXO_AGY_EXECUTABLE=/ruta/a/agy           # opcional: por omisión se busca «agy» en el PATH
nexo agent new --provider antigravity --permissions accept-edits --cwd .
```

`agy` en modo no interactivo **no pide permisos ni hace preguntas**: `ask` deniega lo que no esté preaprobado en los ajustes de `agy`,
`accept-edits` y `plan` usan `--mode` y `bypass` usa `--dangerously-skip-permissions`; tampoco emite el texto del razonamiento. El
formato `stream-json` sale de la documentación oficial y de las banderas de `agy` 1.2.0, pero no se ha comprobado con un turno real: la
prueba en vivo (usa tu cuenta y consume cuota) es `NEXO_LIVE_AGY=1 pnpm --filter @nexo/adapter-provider-antigravity test:live`, y
[la arquitectura](docs/ARCHITECTURE.md) dice qué está verificado y qué no.

![Acciones de Antigravity con su diff](docs/capturas/f3-4-agy-acciones.png)

**Varios proveedores a la vez.** Cada panel de agente tiene su proveedor: puedes tener Claude, Codex, Gemini, Antigravity y Ollama en
pestañas distintas, trabajando al mismo tiempo, y cambiar entre ellas sin perder lo de cada uno (el cambio de pestaña se mide en el
CI con los cinco emitiendo). La tabla de qué ofrece cada proveedor (razonamiento, acciones, diffs, permisos, preguntas, plan,
reanudar, modelos, esfuerzos…) está en [la arquitectura](docs/ARCHITECTURE.md#matriz-de-capacidades-por-proveedor-cierre-de-f3).

![Cinco proveedores de agente a la vez](docs/capturas/f3-4-varios-proveedores.png)

## Estructura

```
packages/contracts   esquemas zod del protocolo v1 y del dominio compartido
packages/core        dominio, árbol de distribución, casos de uso y puertos (sin I/O)
packages/testkit     falsos de los puertos, generadores fast-check y suites de conformidad
packages/jsonrpc     JSON-RPC 2.0 por líneas (puro; lo usan los adaptadores de Codex y ACP)
packages/adapters    pty-node, pty-host y los proveedores: claude, codex, acp, antigravity, ollama
packages/client      SDK tipado del protocolo (esqueleto)
apps/daemon          raíz de composición (esqueleto)
apps/web             interfaz SolidJS + Vite (terminales y panel de agente)
apps/cli            CLI `nexo`
apps/mcp            cliente MCP (esqueleto)
```

## Documentación

- [Arquitectura](docs/ARCHITECTURE.md) (el contrato del proyecto)
- [Roadmap](docs/ROADMAP.md)
- [Decisiones de arquitectura (ADR)](docs/adr/)
- [Reglas para agentes de código](AGENTS.md)

## Créditos

La idea de leer cada conversación como un documento, con permisos en línea y varios agentes a la vista,
viene de [MegaloIV/lyra-agentes](https://github.com/MegaloIV/lyra-agentes) (MIT). La organización en
espacios, pestañas y paneles controlables por CLI está inspirada en herdr. Nexo no copia código de
ninguno de los dos.
