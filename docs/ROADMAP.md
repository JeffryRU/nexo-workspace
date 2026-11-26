# Roadmap

Cada fase termina con CI verde en Linux y Windows, pruebas adversariales de lo nuevo y la documentación
al día. Una fase no empieza hasta revisar la anterior.

## F0 — Base (este PR)

- Monorepo pnpm, TypeScript estricto, Biome, Vitest + fast-check, dependency-cruiser, CI Linux/Windows.
- `packages/contracts`: sobre del protocolo v1, códigos de error, registro de métodos y eventos de la F1.
- `packages/core`: dominio de espacios/pestañas/paneles y el árbol de distribución (puro, con pruebas
  de propiedades); puertos definidos.
- `packages/testkit`: falsos de los puertos y generadores para pruebas adversariales.
- Esqueletos vacíos (compilan) de `apps/daemon`, `apps/web`, `apps/cli`, `apps/mcp`, `packages/client`.

**Hecho cuando:** `pnpm check` (typecheck + lint + test + depcruise) pasa en Linux y Windows.

## F1 — Terminal (la base tipo herdr)

- Daemon: servidor WS con token y origen, `terminal.*`, `pane.*`, `tab.*`, `workspace.*`, búfer circular,
  agrupación de salida, `daemon.json`.
- Adaptador `pty-node` con su suite de conformidad.
- Web: pestañas y paneles divididos (arrastrar para redimensionar), xterm.js con WebGL solo en visibles,
  atajos de teclado, barra lateral con espacios y atención.
- CLI: `nexo ls`, `nexo new`, `nexo split`, `nexo send`, `nexo read`, `nexo focus`.
- Desktop: Tauri 2 que arranca el daemon y carga la web.

**Hecho cuando:** cambiar de pestaña con 10 terminales activas tarda < 16 ms (medido) y la CLI puede
leer y escribir en un panel abierto en la ventana.

## F2 — Agente Claude Code

- Puerto `AgentProviderPort` y adaptador `provider-claude` (Claude Agent SDK, deltas parciales).
- Panel de agente: documento con bloques, acciones plegables con diff/salida, permisos y preguntas en
  línea, redactor con chips (proveedor, modelo, esfuerzo, permisos, carpeta).
- Atención en la barra (`working`, `needs-input`, `done`) y notificaciones del sistema.

**Hecho cuando:** un permiso o una pregunta pendiente se ve en la pestaña y la barra con su contador, avisa con una
notificación del sistema si la ventana no tiene el foco, y las mediciones de rendimiento del agente (primer delta, documento de
5 000 bloques, cambio de pestaña con agentes emitiendo) pasan en el CI. **F2 completa** (F2.1 a F2.6).

## F3 — Más proveedores

- Codex (`codex app-server`), ACP (Gemini y otros agentes ACP), Antigravity (`agy --output-format
  stream-json`).
- **F3.1 Ollama** (hecho): `packages/adapters/provider-ollama` y selector de proveedor y modelo en la interfaz
  (ver «Proveedor Ollama (F3.1)» en `docs/ARCHITECTURE.md`).
- **F3.2 Codex** (hecho): `packages/jsonrpc` (JSON-RPC 2.0 por líneas, reutilizable por ACP) y
  `packages/adapters/provider-codex` sobre `codex app-server` (ver «Proveedor Codex (F3.2)»).
- **F3.3 ACP** (hecho): `packages/adapters/provider-acp` sobre Agent Client Protocol 1 (Gemini CLI con `--acp` por omisión y
  cualquier otro agente ACP declarado en `NEXO_ACP_AGENTS`; ver «Proveedor ACP (F3.3)»).
- **F3.4 Antigravity y cierre** (hecho): `packages/adapters/provider-antigravity` sobre `agy --output-format stream-json`
  (ver «Proveedor Antigravity (F3.4)»), comprobado en vivo con `agy` 1.5.17; matriz de capacidades por proveedor, E2E y medida
  con cinco proveedores a la vez, y arreglos de F3.3 (modos `dontAsk`/`auto`, rutas relativas, prueba de Gemini determinista).

**F3 completa.**

## F3.5 — Memoria observacional (ADR 0007)

- **F3.5.1 Dominio, contratos y almacén** (hecho): dominio puro en `core` (observaciones, reflexiones, estimación de tokens, selección
  de bloques, lotes de 6k y umbral de 40k, bloque inyectable con escape), puertos `SummarizerPort` y `MemoryStorePort` con falsos y
  conformidad, contratos zod `memory.*` (sin implementar en el daemon) y `packages/adapters/store-memory-fs` (ver «Memoria
  observacional (F3.5)»).
- **F3.5.2 Observador y Reflector en el daemon** (hecho): `MemoryService` en `core` (cola por proyecto, una llamada a la vez, lotes por
  umbral, reintentos acotados, pausa visible, cancelación al cerrar; no toca el streaming), resumidores `OllamaSummarizer`
  (`packages/adapters/summarizer-ollama`) y «vía proveedor» (`ProviderSummarizer`: un turno de solo texto sin abrir pestaña), prompts en
  español con escape y sin copiar órdenes, `NEXO_MEMORY`, `NEXO_MEMORY_SUMMARIZER`, `NEXO_MEMORY_OBSERVER_TOKENS` y
  `NEXO_MEMORY_REFLECTOR_TOKENS` (apagada por omisión), contabilidad por papel, métodos `memory.*` en el registro, evento
  `memory.updated` y `nexo memory status|ls|search|recall`. F3.5.4 sigue abierta; el ADR 0007 queda «propuesta» hasta F3.5.4.
- **F3.5.3 Inyección por proveedor y renovación** (hecho): puerto `MemoryInjectionPort` con una implementación por proveedor (Claude:
  `systemPrompt.append` y hook `SessionStart` de origen `compact`; Codex: `developerInstructions` del hilo; ACP: primer bloque del primer
  `session/prompt`; Antigravity: prefijo del primer mensaje; Ollama: mensaje de sistema), con su falso y su suite de conformidad. Una
  sesión nueva en una carpeta con la memoria encendida recibe reflexiones y observaciones dentro del bloque delimitado y escapado; con
  la memoria apagada no cambia nada. Renovación opcional (`NEXO_MEMORY_RENEW_TOKENS`, apagada por omisión): sesión nueva sembrada con
  reflexiones, observaciones y los últimos turnos tal cual, en la misma pestaña. Pruebas adversariales, de propiedades y de integración.

- Observador y Reflector en el daemon sobre la transcripción normalizada (`SummarizerPort`; Ollama,
  Haiku o Gemini Flash), con alcance por sesión y por proyecto.
- Inyección por proveedor (`MemoryInjectionPort`), reinyección tras la compactación de Claude Code,
  renovación opcional de sesión y `memory.search` / `memory.recall` por MCP.
- Panel de costo del Observador; se puede apagar.

## F4 — Historial, límites y visor

- Historial de los proveedores agrupado por proyecto; límites de uso (Claude, Codex); visor lateral
  (Markdown, imágenes, PDF) con `fs-sandbox`.

## F5 — MCP y mascota

- `apps/mcp`: herramientas para listar/leer/escribir paneles y agentes, y suscribirse a estados.
- Sistema de compañeros (mascotas) intercambiables, ver ADR 0006: puerto `CompanionPort`, formato de
  paquete de mascota (manifiesto zod + recursos), selector en la configuración y la opción «sin mascota».
- La primera mascota es un proyecto aparte; Nexo funciona al 100 % sin ninguna.

## F6 — Empaquetado

- Instaladores: Windows (NSIS/MSI) y Linux (AppImage, .deb). Node empaquetado como sidecar.
