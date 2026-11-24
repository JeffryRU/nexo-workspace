# Arquitectura de Atalaya

Atalaya es una app de escritorio (Linux y Windows) para trabajar con varios agentes de programación
(Claude Code, Codex, Gemini, Antigravity, modelos locales) y terminales reales en pestañas y paneles,
al estilo de un multiplexor. Este documento es el **contrato** del proyecto: si el código y este
documento no coinciden, se corrige uno de los dos en el mismo PR.

Las decisiones con su porqué están en [`docs/adr/`](adr/). El plan por fases, en [`ROADMAP.md`](ROADMAP.md).

## Objetivos (en orden de prioridad)

1. **Rápida:** cambiar de pestaña o de panel en menos de un cuadro (16 ms), sin recargar nada; el texto
   del agente se ve en cuanto llega.
2. **Una sola fuente de verdad:** el daemon. La ventana, la CLI y el servidor MCP son clientes iguales.
   Cerrar la ventana no mata agentes ni terminales.
3. **Probada:** cada parte tiene pruebas unitarias, de contrato y adversariales.
4. **Extensible:** agregar un proveedor de agente, un tipo de panel o un cliente nuevo (p. ej. la mascota)
   no toca el núcleo.

## Procesos

```
┌──────────────────────────┐       spawn / vigila        ┌──────────────────────────────────┐
│ apps/desktop (Tauri 2)   │ ──────────────────────────▶ │ apps/daemon (Node 24, TS)        │
│ Rust delgado: ventana,   │                             │ raíz de composición:             │
│ bandeja, atajo global,   │   WebView (WebView2 /       │ core + adaptadores               │
│ instancia única          │   WebKitGTK) carga apps/web │ HTTP + WebSocket en 127.0.0.1    │
└──────────────────────────┘            │                └──────────────────────────────────┘
                                        │ WS + token               ▲            ▲
                             ┌──────────▼─────────┐     WS + token │            │ WS + token
                             │ apps/web (SolidJS) │                │            │
                             └────────────────────┘      ┌─────────┴──┐   ┌─────┴───────┐
                                                         │ apps/cli   │   │ apps/mcp    │
                                                         │ `atalaya`  │   │ stdio MCP   │
                                                         └────────────┘   └─────────────┘
                                         daemon ─ spawn ─▶ PTYs (shells) y CLIs de agentes
```

- **Daemon** (`apps/daemon`): dueño de todo el estado (espacios, pestañas, paneles, terminales, agentes).
  Escucha solo en `127.0.0.1`, exige un token aleatorio y comprueba el `Origin`. Si ya hay uno vivo,
  los clientes lo reutilizan.
- **Descubrimiento:** el daemon escribe `daemon.json` (`{ version, port, pid, startedAt }`) y `token`
  (permisos 600) en el directorio de estado:
  Linux `$XDG_STATE_HOME/atalaya` (o `~/.local/state/atalaya`), Windows `%LOCALAPPDATA%\Atalaya`.
- **Shell de escritorio** (`apps/desktop`): solo ventana, bandeja, atajo global, instancia única y arrancar
  el daemon si no está vivo. Le pasa a la página el puerto y el token por un comando de Tauri.
  No contiene lógica de negocio: se compila pocas veces.
- **Web** (`apps/web`): la misma interfaz sirve dentro de Tauri y en un navegador (modo desarrollo o
  `atalaya open --browser`).

## Capas (hexagonal)

```
packages/contracts   esquemas zod del protocolo y del dominio compartido (sin dependencias de runtime)
        ▲
packages/core        dominio + casos de uso + puertos (interfaces). Sin Node, sin I/O.
        ▲
packages/adapters/*  implementan los puertos: pty-node, provider-claude, provider-codex, provider-acp,
                     provider-antigravity, provider-ollama, store-fs, notifier, fs-sandbox, ...
        ▲
apps/*               raíces de composición: daemon (une core + adaptadores), web, cli, mcp, desktop
```

**Regla de dependencias** (la comprueba `dependency-cruiser` en CI):

- `contracts` no importa nada del repo.
- `core` importa solo `contracts`. Nada de `node:*`, `fs`, `child_process`, `process`, ni del DOM.
- `adapters/*` importan `core` y `contracts`; nunca otro adaptador ni una app.
- `apps/*` importan lo que necesiten; ninguna app importa a otra.
- `packages/client` (SDK tipado del protocolo) lo usan `web`, `cli` y `mcp`; solo importa `contracts`.

### Dominio (core)

| Concepto       | Qué es                                                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Workspace`    | Grupo de pestañas, normalmente una carpeta de proyecto (`cwd`).                                                                                                      |
| `Tab`          | Una pestaña: su contenido es un **árbol de distribución** de paneles.                                                                                                |
| `Layout`       | Árbol inmutable: hoja = panel; nodo = división `row`/`column` con proporciones que suman 1.                                                                          |
| `Pane`         | Panel. `kind`: `terminal` o `agent` (más adelante `viewer`).                                                                                                         |
| `Terminal`     | Proceso en un PTY con un búfer circular de salida (para reconectar y para `terminal.read`).                                                                          |
| `AgentSession` | Conversación con un proveedor; su contenido es una lista de `Block` (documento).                                                                                     |
| `Block`        | Pieza del documento: mensaje del usuario, texto del agente (Markdown), acción plegable (leer, editar con diff, ejecutar con salida), permiso, pregunta, plan, error. |
| `Attention`    | Estado visible en la barra: `idle`, `working`, `needs-input`, `done`, `error`.                                                                                       |

### Puertos (interfaces en `core/ports`)

`PtyPort`, `AgentProviderPort`, `SessionStorePort`, `EventBusPort`, `ClockPort`, `IdPort`,
`NotifierPort`, `FileSystemPort`, `LoggerPort`, `ProcessLauncherPort`. Cada puerto tiene en
`packages/testkit` un **falso** en memoria y una **suite de conformidad** que se ejecuta contra el falso
y contra cada adaptador real: así el falso no miente.

## Protocolo (v1)

Todo mensaje que cruza un límite de proceso se valida con zod **al recibirlo** (el daemon valida lo que
llega de clientes; los clientes validan lo que llega del daemon). Los esquemas viven en
`packages/contracts` y de ellos salen los tipos TS (`z.infer`): no hay tipos escritos a mano duplicados.

Transporte: WebSocket con mensajes JSON de texto. Tamaño máximo de mensaje: 1 MiB (configurable).

```ts
// cliente → daemon
{ v: 1, id: string, method: string, params: unknown }
// daemon → cliente (respuesta)
{ v: 1, id: string, ok: true, result: unknown } | { v: 1, id: string, ok: false, error: { code, message, data? } }
// daemon → cliente (evento, tras events.subscribe)
{ v: 1, event: string, seq: number, data: unknown }
```

- `seq` crece de uno en uno por conexión; si un cliente detecta un hueco pide un `snapshot`.
- Códigos de error estables (`INVALID_PARAMS`, `NOT_FOUND`, `UNAUTHORIZED`, `CONFLICT`, `INTERNAL`,
  `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`).
- Cada método tiene su esquema de `params` y de `result` en un registro (`methods.ts`), y cada evento el
  suyo (`events.ts`). Agregar un método = agregarlo al registro; el servidor y el cliente se generan del
  registro.
- Autenticación: el token va en el primer mensaje (`auth`) o en la cabecera `Sec-WebSocket-Protocol`,
  nunca en logs. Comparación en tiempo constante.

Métodos de la fase 1 (terminal): `daemon.info`, `snapshot`, `events.subscribe`,
`workspace.{list,create,rename,close}`, `tab.{create,close,focus,move,rename}`,
`pane.{split,close,focus,resize,swap}`, `terminal.{spawn,write,resize,read,kill}`.
Eventos: `layout.changed`, `terminal.output`, `terminal.exit`, `pane.title`, `pane.attention`.

Detalles fijados en F0 (la fuente exacta es `packages/contracts`):

- `Layout`: hoja `{ type: 'leaf', paneId }`; división `{ type: 'split', direction: 'row' | 'column',
  children, ratios }` con 2 o más hijos. Se valida de forma iterativa (sin recursión de zod) para que
  árboles muy profundos no desborden la pila; por eso `Layout` es uno de los pocos tipos escritos a mano.
  Máximo 1024 paneles por pestaña.
- Método o evento desconocido → `NOT_FOUND`. Cualquier clave `__proto__` en un mensaje → `INVALID_PARAMS`.
- Peticiones estrictas (claves extra se rechazan); mensajes del servidor tolerantes (claves extra se
  ignoran), para que un cliente viejo no se rompa con un daemon nuevo.
- Títulos y nombres rechazan caracteres de control; `terminal.write` sí acepta ANSI/OSC.
- `terminal.output` lleva `offset` (posición absoluta en el búfer) y `terminal.read` devuelve
  `{ data, offset }`, para reconectar sin perder ni duplicar salida.

Versiones fijadas: TypeScript 6.x (dependency-cruiser aún no soporta TS 7) y solid-js 1.9
(`@tanstack/solid-query` y `vite-plugin-solid` piden Solid 1.x). Se revisan al subir esas dependencias.

## Rendimiento

Presupuestos (los mide una prueba de rendimiento en CI, con margen):

- **Cambio de pestaña < 16 ms.** Las pestañas y los paneles **no se desmontan** al ocultarse
  (`display: none` / `content-visibility`); las instancias de xterm.js persisten.
- **WebGL de xterm solo en terminales visibles:** los navegadores limitan los contextos WebGL (~16). Al
  ocultar un panel se libera su `WebglAddon` y al mostrarlo se vuelve a cargar (el búfer de xterm se
  conserva).
- **Salida de PTY agrupada** en el daemon: se envía cada ~8 ms o cada 64 KiB, lo que ocurra antes. En la
  web, las escrituras a xterm y las actualizaciones del documento se agrupan por `requestAnimationFrame`.
- **Documento virtualizado:** conversaciones largas solo dibujan los bloques visibles.
- **Agentes rápidos:** el texto se transmite en parcial (deltas); el proceso del proveedor se precalienta
  al abrir una pestaña de agente o enfocar el redactor; Codex usa un solo `app-server` para todos los hilos.
- **Reactividad fina:** SolidJS actualiza solo los nodos que cambian; el estado en vivo vive en stores de
  Solid alimentados por eventos, no en re-render de árboles completos.

## Interfaz (apps/web)

- **SolidJS + Vite.** Estado del servidor por petición/respuesta (historial, modelos, límites de uso,
  configuración) con **`@tanstack/solid-query`**; estado en vivo (salida de terminales, bloques en
  streaming, atención) con stores de Solid alimentados por el flujo de eventos.
- **zod en el borde:** todo lo que llega del daemon pasa por el cliente de `packages/client`, que valida.
- Terminal: `@xterm/xterm` + addons `fit`, `webgl`, `web-links`, `unicode11`, `search`.
- Textos de la interfaz en español, desde un diccionario (`i18n/es.ts`) para poder traducir.

## Seguridad

- Solo `127.0.0.1`; token aleatorio de 32 bytes; `Origin` permitido: `tauri://localhost`,
  `http://tauri.localhost` (Windows), y el origen de Vite solo con `ATALAYA_DEV=1`.
- Procesos siempre con `spawn(cmd, args[])`, **nunca** con una cadena de shell.
- Rutas: el visor y cualquier lectura de archivos pasan por `fs-sandbox` (resuelve enlaces simbólicos,
  bloquea carpetas ocultas sensibles, rutas UNC, `\\?\`, nombres de dispositivo de Windows).
- Límites: tamaño de mensaje, frecuencia de escritura a PTY, número de terminales y agentes por daemon.
- Los logs pasan por un redactor de secretos (tokens, claves de API).

## Pruebas

| Tipo                   | Dónde                                                        | Herramienta            |
| ---------------------- | ------------------------------------------------------------ | ---------------------- |
| Unitarias              | junto al código (`*.test.ts`)                                | Vitest                 |
| Propiedades            | parsers, árbol de distribución, protocolo                    | fast-check             |
| Conformidad de puertos | `packages/testkit/conformance` contra falso y adaptador real | Vitest                 |
| Integración            | daemon real + node-pty real, Linux y Windows                 | Vitest                 |
| Extremo a extremo      | web servida por el daemon, en navegador                      | Playwright             |
| Rust                   | `apps/desktop`                                               | `cargo test`, `clippy` |

**Pruebas adversariales obligatorias** (`*.adversarial.test.ts`) en cada funcionalidad: entradas
malformadas, enormes o binarias; tokens y orígenes incorrectos; carreras (cerrar un panel mientras
escribe, matar el proceso a mitad de salida); inyección de escapes ANSI/OSC en títulos; recorridos de
ruta; proveedores falsos que emiten JSON roto, se cuelgan o mueren. Un PR que agrega una funcionalidad sin
su prueba adversarial no se fusiona.

Cobertura mínima: `core` y `contracts` 90 %; adaptadores 80 %.

## Convenciones

- Monorepo **pnpm**; TypeScript `strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`.
- **Biome** para formato y lint. Sin `any` explícito fuera de los bordes validados por zod.
- Identificadores de código en inglés; documentación, commits y textos de la interfaz en español.
- Commits convencionales (`feat(core): ...`). Sin atribución automática de herramientas en commits o PRs.
- CI (GitHub Actions) en `ubuntu-latest` y `windows-latest`: typecheck, lint, pruebas, dependency-cruiser,
  y `cargo` para `apps/desktop`.

## Créditos

La idea de leer cada conversación como un documento, con permisos en línea y varios agentes a la vista,
viene de [MegaloIV/lyra-agentes](https://github.com/MegaloIV/lyra-agentes) (MIT). La organización en
espacios, pestañas y paneles controlables por CLI viene de herdr. Atalaya no copia código de ninguno.
