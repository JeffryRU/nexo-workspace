# Nexo Workspace

App de escritorio (Linux y Windows) para trabajar con varios agentes de programación (Claude Code,
Codex, Gemini, Antigravity, modelos locales) y terminales reales en pestañas y paneles, al estilo de un
multiplexor. Un daemon es la única fuente de verdad; la ventana, la CLI y el servidor MCP son clientes
iguales: cerrar la ventana no mata agentes ni terminales.

Estado: **F2 en curso**. Terminales, daemon, CLI, web y escritorio (F0 y F1) están hechos. De la F2 (agente Claude Code)
va el modelo normalizado de agentes: bloques, protocolo `agent.*` y `AgentProviderPort` con su falso (F2.1), el servicio de agentes de
`core` (F2.2) y el adaptador `provider-claude` (F2.3, Claude Agent SDK; se autentica con
`ANTHROPIC_API_KEY` o `CLAUDE_CODE_OAUTH_TOKEN` del entorno del daemon, ver «Proveedor Claude» en
`docs/ARCHITECTURE.md`), el daemon, el cliente y la CLI de agentes (F2.4) y el panel de agente de la interfaz web
(F2.5; ver [`docs/ROADMAP.md`](docs/ROADMAP.md)).

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
(responde `Eco: …`; las palabras `permiso`, `pregunta`, `largo` y `lento` provocan cada caso).

Sin credenciales el agente responde con un bloque de error que explica las dos opciones. `NEXO_CLAUDE_EXECUTABLE`
apunta a otro ejecutable de Claude Code (por omisión se usa el que trae el SDK). Para probar sin gastar nada, el
daemon acepta `NEXO_AGENT_PROVIDERS=fake` (proveedor determinista de pruebas; `nexo agent new --provider fake`);
no lo actives en uso normal. Una prueba opcional con Claude real: `NEXO_LIVE_CLAUDE=1 pnpm --filter @nexo/adapter-provider-claude test:live`.

## Estructura

```
packages/contracts   esquemas zod del protocolo v1 y del dominio compartido
packages/core        dominio, árbol de distribución, casos de uso y puertos (sin I/O)
packages/testkit     falsos de los puertos, generadores fast-check y suites de conformidad
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
