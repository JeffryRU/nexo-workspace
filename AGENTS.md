# Reglas para agentes de código

Estas reglas valen para cualquier agente (y persona) que trabaje en este repositorio.

1. **Lee primero [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)**: es el contrato. También
   [`docs/ROADMAP.md`](docs/ROADMAP.md) y los ADR en [`docs/adr/`](docs/adr/). Si el código y el contrato
   no coinciden, corrige uno de los dos en el mismo cambio y dilo.
2. **Regla de dependencias** (la hace cumplir `dependency-cruiser`, `pnpm depcruise`):
   - `packages/contracts` no importa nada del repo (solo `zod`).
   - `packages/core` importa solo `contracts`; nada de `node:*`, `fs`, `process` ni DOM.
   - `packages/adapters/*` importan `core` y `contracts`; nunca otro adaptador ni una app.
   - `apps/*` no se importan entre sí. `packages/client` solo importa `contracts`.
   - El código de producción no importa `packages/testkit`.
3. **zod en los bordes**: todo lo que cruza un proceso se valida al recibirlo con los esquemas de
   `packages/contracts`. Los tipos salen de `z.infer`; no los dupliques a mano. Nada de `any` explícito ni
   `// @ts-ignore`.
4. **Toda funcionalidad lleva prueba unitaria y prueba adversarial** (`*.adversarial.test.ts`: entradas
   malformadas, enormes, hostiles, carreras). Las reglas de dominio y los parsers llevan además pruebas de
   propiedades (fast-check). Cada puerto nuevo trae su falso y su suite de conformidad en
   `packages/testkit`. Cobertura mínima: `core` y `contracts` 90 %.
5. **No debilites las comprobaciones**: no desactives reglas de lint, no bajes umbrales de cobertura, no
   borres pruebas para que algo pase.
6. **Antes de commitear, ejecuta `pnpm check`** (typecheck + lint + formato + pruebas con cobertura +
   dependency-cruiser). Debe pasar en Linux y Windows.
7. **Commits convencionales en español**, pequeños (`feat(core): dividir paneles`, `fix(contracts): ...`,
   `test: ...`, `docs: ...`, `chore: ...`). Sin líneas de atribución de herramientas (`Generated with ...`,
   `Co-authored-by` de un agente) en commits ni en PR.
8. Identificadores de código en inglés; documentación, commits y textos de la interfaz en español.
   Comentarios breves y solo cuando explican el porqué.
9. Procesos siempre con `spawn(cmd, args[])`, nunca con una cadena de shell. Los logs pasan por un
   redactor de secretos.

## Comandos

```
pnpm install
pnpm check        # todo lo anterior
pnpm test         # Vitest con cobertura
pnpm typecheck
pnpm lint         # Biome (lint + formato + orden de imports)
pnpm format       # Biome, aplica el formato
pnpm depcruise
```

En máquinas lentas o compartidas (un VPS con otras cargas) los plazos de las pruebas pueden quedarse cortos sin
que haya un fallo real. `NEXO_TEST_TIMEOUT_SCALE=3 pnpm check` multiplica por 3 los plazos de Vitest (los de
`vitest.config.ts` y los de las ayudas de las pruebas de integración de la CLI). Vale 1 por omisión y el CI no lo
usa; no sirve para esconder una prueba lenta de verdad, solo para compensar la máquina.
