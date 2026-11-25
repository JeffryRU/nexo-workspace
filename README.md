# Nexo Workspace

App de escritorio (Linux y Windows) para trabajar con varios agentes de programación (Claude Code,
Codex, Gemini, Antigravity, modelos locales) y terminales reales en pestañas y paneles, al estilo de un
multiplexor. Un daemon es la única fuente de verdad; la ventana, la CLI y el servidor MCP son clientes
iguales: cerrar la ventana no mata agentes ni terminales.

Estado: **F0 (base)**. Monorepo, contratos del protocolo, núcleo de dominio y utilidades de prueba. Aún no
hay daemon ni interfaz funcional (ver [`docs/ROADMAP.md`](docs/ROADMAP.md)).

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

| Comando | Qué hace |
| --- | --- |
| `nexo ls` | árbol de espacios, pestañas y paneles |
| `nexo new [--workspace X] [--cwd R] [--name T] [-- cmd args]` | pestaña y terminal nuevas (shell por omisión si no hay comando) |
| `nexo split <panel> --right|--down [-- cmd]` | divide un panel |
| `nexo send <panel> [--enter] [--stdin] [--] texto` | escribe en la terminal (trocea en mensajes de 64 KiB) |
| `nexo read <panel> [-n N] [-f] [--raw]` | últimas N líneas sin ANSI; `-f` sigue la salida |
| `nexo focus|kill|close <ref>`, `nexo rename <pestaña|espacio> <nombre>` | gestión |
| `nexo daemon status|stop|log` | estado, apagado limpio y registro |

Globales: `--json` (salida estable), `--no-start`, `--help`, `--version`. Salida: 0 ok, 1 uso, 2 no
encontrado, 3 daemon no disponible, 4 error del daemon. Entorno: `NEXO_STATE_DIR`, `NEXO_SHELL`,
`NEXO_DAEMON_ENTRY`, `NEXO_START_TIMEOUT_MS`, `NEXO_DEBUG=1` (trazas).

## Estructura

```
packages/contracts   esquemas zod del protocolo v1 y del dominio compartido
packages/core        dominio, árbol de distribución, casos de uso y puertos (sin I/O)
packages/testkit     falsos de los puertos, generadores fast-check y suites de conformidad
packages/client      SDK tipado del protocolo (esqueleto)
apps/daemon          raíz de composición (esqueleto)
apps/web             interfaz SolidJS + Vite (esqueleto)
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
