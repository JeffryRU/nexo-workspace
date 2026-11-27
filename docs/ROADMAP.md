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
  `memory.updated` y `nexo memory status|ls|search|recall`.
- **F3.5.3 Inyección por proveedor y renovación** (hecho): puerto `MemoryInjectionPort` con una implementación por proveedor (Claude:
  `systemPrompt.append` y hook `SessionStart` de origen `compact`; Codex: `developerInstructions` del hilo; ACP: primer bloque del primer
  `session/prompt`; Antigravity: prefijo del primer mensaje; Ollama: mensaje de sistema), con su falso y su suite de conformidad. Una
  sesión nueva en una carpeta con la memoria encendida recibe reflexiones y observaciones dentro del bloque delimitado y escapado; con
  la memoria apagada no cambia nada. Renovación opcional (`NEXO_MEMORY_RENEW_TOKENS`, apagada por omisión): sesión nueva sembrada con
  reflexiones, observaciones y los últimos turnos tal cual, en la misma pestaña. Pruebas adversariales, de propiedades y de integración.
- **F3.5.4 Interfaz y cierre** (hecho): botón y ventana de memoria (interruptor y renovación automática en caliente con
  `memory.configure`, guardados en el estado del daemon; costo del Observador y del Reflector; reflexión y observaciones de la carpeta con
  texto original y salto al bloque de origen, refrescadas con `memory.updated`), indicador en el panel de las sesiones que recibieron
  memoria (`AgentSession.memory`), renovación manual (`agent.renew`, botón y `nexo agent renew`), `nexo memory config`, E2E con dos
  proveedores falsos y el Observador falso, capturas `f3-5-*` y ADR 0007 «aceptada». `memory.search` y `memory.recall` por MCP llegaron
  con la F5.1 (`apps/mcp`).

**F3.5 completa.**

- Observador y Reflector en el daemon sobre la transcripción normalizada (`SummarizerPort`; Ollama,
  Haiku o Gemini Flash), con alcance por sesión y por proyecto.
- Inyección por proveedor (`MemoryInjectionPort`), reinyección tras la compactación de Claude Code,
  renovación opcional de sesión y `memory.search` / `memory.recall` por MCP.
- Panel de costo del Observador; se puede apagar.

## F4 — Historial, límites y visor

- **F4.1 fs-sandbox y archivos en el daemon** (hecho): `FileSystemPort` en `core` y adaptador `packages/adapters/fs-sandbox` (solo lectura dentro de
  las carpetas de los espacios abiertos, `realpath`, rutas sensibles, UNC, `\\?\`, dispositivos de Windows, comprobación del descriptor), tipo por
  firma y extensión con topes por tipo, métodos `fs.stat` y `fs.read` (trozos UTF-8 o base64), código de error `FORBIDDEN`, panel `viewer` en
  contratos y core (`pane.split { kind: 'viewer', path }`, `viewer.open`), `fsApi` en `@nexo/client`, `nexo fs stat|cat` y marcador mínimo en la
  web. Ver «Archivos y visor (F4.1)».
- **F4.2 Visor lateral en la interfaz** (hecho): panel `viewer` real con Markdown seguro (sin HTML crudo ni recursos remotos, imágenes relativas por
  `fs.read`, enlaces a archivos que abren en el visor), imágenes y SVG como `<img>`, PDF local con pdf.js (worker empaquetado, sin scripts), texto
  plano, recarga con `expectMtimeMs`; se abre desde las rutas de los bloques del agente y con `nexo open <ruta>`; CSP con `blob:` para imágenes.
  Ver «Visor lateral (F4.2)».
- **F4.3 Historial de los proveedores por proyecto** (hecho): `HistoryPort` (capacidad opcional de `AgentProviderPort`) con la API de cada proveedor
  (Claude: `listSessions`/`getSessionMessages` del SDK; Codex: `thread/list`/`thread/read`; ACP: `session/list` si el agente lo anuncia; Antigravity y
  Ollama no tienen), métodos `history.list` (agrupado por carpeta, paginado con cursor) y `history.read` (bloques normalizados con topes), caché,
  plazos y cancelación, `historyApi`, `nexo history ls|show`, `nexo agent new --resume` y suites de conformidad. Sin ADR 0008: ningún proveedor
  obligó a leer sus archivos. Ver «Historial de los proveedores (F4.3)».
- **F4.4 Límites de uso (Claude, Codex)** (hecho): `UsageLimitsPort` (capacidad opcional de `AgentProviderPort`) con `account/rateLimits/read` y la notificación
  `account/rateLimits/updated` de Codex y los `rate_limit_event` del Agent SDK de Claude (solo informan durante una sesión; sin ellos, «desconocido»), métodos
  `limits.status` y evento `limits.updated` (ventanas con porcentaje usado, reinicio, origen y frescura; caché, plazos y contención de avisos), `limitsApi`,
  `nexo limits` y suites de conformidad. Sin datos de la cuenta en ningún borde. Ver «Límites de uso de los proveedores (F4.4)».
- **F4.5 Interfaz de historial y límites, y cierre de F4** (hecho): ventana «Historial» (por proyecto, filtro por proveedor en el daemon, búsqueda en el
  cliente, paginación incremental, estado por proveedor, «Reanudar en una pestaña»), sesión antigua de solo lectura con el render de bloques del panel
  de agente y enlaces que abren el visor, e indicador de límites en la barra de estado (peor porcentaje por proveedor, umbrales, «desconocido»,
  detalle con reinicio local, frescura y origen, refresco y actualización con `limits.updated`). Pruebas unitarias, adversariales, de propiedades y E2E
  con proveedores falsos; capturas `f4-5-*`. Ver «Interfaz de historial y límites (F4.5)».

**F4 completa** (fs-sandbox, visor, historial, límites e interfaz). Queda fuera, y está dicho en cada sección: leer sesiones de ACP (solo listan), el historial de
Antigravity y de Ollama, una consulta propia de los límites de Claude (solo informa el SDK dentro de una sesión) y la verificación en vivo de su `utilization`.

## F5 — MCP y mascota

- **F5.1 Servidor MCP** (hecho): `apps/mcp` por stdio con el SDK oficial, cliente más del daemon por `@nexo/client`. Herramientas de lectura
  (espacios, salida de terminal limpia, agentes y bloques, `memory_search`/`memory_recall`, historial, límites), herramientas de escritura solo con
  `NEXO_MCP_WRITE=1` (con topes de tamaño y de frecuencia; responder permisos aparte con `NEXO_MCP_ALLOW_PERMISSIONS=1`) y recursos suscribibles
  (`nexo://attention`, `nexo://agents/<id>/status`, `nexo://limits`...) con avisos de cambio a partir de los eventos del daemon. Pruebas
  unitarias, adversariales, de propiedades y de integración con un cliente MCP real. Ver «Servidor MCP (F5.1)».
- **F5.2 Compañeros: dominio, paquetes y daemon** (hecho): `CompanionService` + `CompanionStateMachine` (atención de los agentes a estados de mascota con las
  prioridades de `nexo://attention`, tiempos mínimos y reloj inyectable), formato `companion.json` con zod (PNG/WebP/GIF/SVG, hojas de sprites), puerto
  `CompanionPort` con `companion-fs` (topes, rutas validadas, sin enlaces, bytes mágicos, SVG validado y servido solo como imagen), métodos
  `companion.list|get|select|asset|state` y evento `companion.state`, «sin mascota» por omisión y persistido, `companionApi`, `nexo companion`,
  paquete de prueba, falso y suite de conformidad en el testkit. Ver «Compañeros (F5.2)».
- **F5.3 Interfaz de la mascota** (#72, hecho): selector con «sin mascota» de primera clase, la mascota en la esquina de la ventana que reacciona a `companion.state`
  (recursos como `<img>` desde un caché por id sin fugas de URL, `idle` de respaldo, hojas de sprites, `prefers-reduced-motion`, ocultable, `aria-live` discreto),
  guía [`docs/mascotas.md`](mascotas.md) (crear un paquete y conectar una mascota externa por MCP/WebSocket), pruebas unitarias, adversariales, de propiedades y E2E,
  capturas `f5-*`. Ver «Interfaz de la mascota (F5.3)». **F5 completa.**
- **F5.4 Pulido visual y responsive** (#76, hecho): iconos SVG propios (trazo de 1.75 px, `currentColor`; trazos de Lucide, ISC, ver `NOTICE`) en lugar de glifos Unicode, cabecera de diálogo común con cerrar por
  icono y foco atrapado, barra de estado en dos grupos, compositor y chips alineados, pestañas con desplazamiento y activa siempre visible, barra lateral colapsable (carril con la mascota) y cajón superpuesto
  por debajo de 760 px, paneles con tamaño mínimo y cabecera adaptable, tablas numéricas a la derecha, variables de diseño únicas y ventana mínima de 480 × 360. Pruebas unitarias, adversariales y E2E a cinco anchos
  con comprobación de desbordes; capturas `f5-4-*`. Ver «Pulido visual y responsive (F5.4)».
- La primera mascota es un proyecto aparte; Nexo funciona al 100 % sin ninguna.

## F6 — Empaquetado

- Instaladores: Windows (NSIS/MSI) y Linux (AppImage, .deb). Node empaquetado como sidecar.
