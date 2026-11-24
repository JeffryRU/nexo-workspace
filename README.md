# Atalaya

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

## Estructura

```
packages/contracts   esquemas zod del protocolo v1 y del dominio compartido
packages/core        dominio, árbol de distribución, casos de uso y puertos (sin I/O)
packages/testkit     falsos de los puertos, generadores fast-check y suites de conformidad
packages/client      SDK tipado del protocolo (esqueleto)
apps/daemon          raíz de composición (esqueleto)
apps/web             interfaz SolidJS + Vite (esqueleto)
apps/cli, apps/mcp   clientes (esqueletos)
```

## Documentación

- [Arquitectura](docs/ARCHITECTURE.md) (el contrato del proyecto)
- [Roadmap](docs/ROADMAP.md)
- [Decisiones de arquitectura (ADR)](docs/adr/)
- [Reglas para agentes de código](AGENTS.md)

## Créditos

La idea de leer cada conversación como un documento, con permisos en línea y varios agentes a la vista,
viene de [MegaloIV/lyra-agentes](https://github.com/MegaloIV/lyra-agentes) (MIT). La organización en
espacios, pestañas y paneles controlables por CLI está inspirada en herdr. Atalaya no copia código de
ninguno de los dos.
