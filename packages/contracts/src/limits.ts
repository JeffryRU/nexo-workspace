/** Límites del protocolo v1. Son parte del contrato: cambiarlos es cambiar el protocolo. */
export const LIMITS = {
  /** Tamaño máximo de un mensaje (bytes UTF-8), configurable por el receptor. */
  maxMessageBytes: 1024 * 1024,
  /** Máximo de `data` en `terminal.write` (bytes UTF-8). */
  maxWriteBytes: 64 * 1024,
  /** Máximo de bytes que devuelve `terminal.read`. */
  maxReadBytes: 1024 * 1024,
  minTerminalSize: 1,
  maxTerminalSize: 1000,
  maxTitleLength: 256,
  maxIdLength: 64,
  maxMethodLength: 64,
  maxPathLength: 4096,
  maxArgs: 256,
  maxArgLength: 4096,
  maxEnvEntries: 256,
  maxEnvValueLength: 32 * 1024,
  /** Paneles por pestaña (acota la profundidad y el tamaño del árbol). */
  maxPanesPerTab: 1024,
  /** Profundidad máxima del camino de nodo en `pane.resize`. */
  maxLayoutPathDepth: 64,
  maxErrorMessageLength: 4096,
  /** Tolerancia de la suma de proporciones de un `Layout`. */
  ratioTolerance: 1e-6,
  // Agentes (F2.1). Los topes de bytes son UTF-8. Un campo de 128 KiB con escapes JSON (`\u001b`) llega a
  // 768 KiB, por eso ningún campo pasa de 128 KiB; aun así, quien emite un bloque (el daemon) comprueba
  // el tamaño serializado contra `maxMessageBytes` antes de enviarlo.
  /** Texto de un bloque (mensaje, Markdown, razonamiento, salida de acción, diff). */
  maxBlockTextBytes: 128 * 1024,
  /** Entrada de una acción (JSON del proveedor, resumido) y detalle de un permiso. */
  maxBlockInputBytes: 16 * 1024,
  /** Un delta de texto (`agent.delta`). */
  maxDeltaBytes: 32 * 1024,
  /** Bloques por sesión; más allá, el daemon rechaza turnos nuevos con `CONFLICT`. */
  maxBlocksPerSession: 10_000,
  /** Sesiones de agente por daemon (`CONFLICT` al excederlo). */
  maxAgentSessions: 64,
  /** Bloques por página de `agent.snapshot`. */
  maxSnapshotBlocks: 200,
  /** Opciones de un permiso o de una pregunta. */
  maxBlockOptions: 16,
  /** Preguntas de un bloque `question`. */
  maxQuestions: 4,
  /** Entradas de un plan. */
  maxPlanEntries: 256,
  /** Modelos que declara un proveedor. */
  maxProviderModels: 128,
  // Memoria observacional (F3.5.1).
  /** Texto de una observación (bytes UTF-8). */
  maxObservationBytes: 2 * 1024,
  /** Texto de una reflexión (bytes UTF-8). */
  maxReflectionBytes: 16 * 1024,
  /** Observaciones por proyecto (el dominio descarta las menos útiles al pasarse). */
  maxObservationsPerProject: 2000,
  /** Rangos de origen que conserva una reflexión. */
  maxReflectionSources: 64,
  /** Sesiones con progreso del Observador guardado por proyecto. */
  maxMemorySessions: 256,
  /** Observaciones por página de `memory.list` y resultados de `memory.search`. */
  maxMemoryPage: 100,
  /** Texto de una consulta de `memory.search`. */
  maxMemoryQueryChars: 256,
  /** Bloques que cubre un rango de `memory.recall` (y que devuelve como máximo). */
  maxRecallBlocks: 200,
  // Archivos (F4.1, `fs.*`). Los trozos acotan el mensaje: el texto va en UTF-8 y un JSON con escapes (un
  // byte de control sale como seis caracteres) llega a 6x, por eso su trozo es menor que el binario (base64: 4/3).
  /** Bytes que devuelve como máximo un `fs.read` en base64 (binario). */
  maxFsChunkBytes: 512 * 1024,
  /** Bytes que devuelve como máximo un `fs.read` en UTF-8 (texto). */
  maxFsTextChunkBytes: 128 * 1024,
  /** Tope de tamaño de archivo legible por tipo: más grande y `fs.read` responde `PAYLOAD_TOO_LARGE`. */
  maxFsTextBytes: 8 * 1024 * 1024,
  maxFsSvgBytes: 2 * 1024 * 1024,
  maxFsImageBytes: 32 * 1024 * 1024,
  maxFsPdfBytes: 64 * 1024 * 1024,
  maxFsBinaryBytes: 16 * 1024 * 1024,
  // Historial de los proveedores (F4.3, `history.*`).
  /** Sesiones por página de `history.list`. */
  maxHistoryPage: 100,
  /** Sesiones que se piden como máximo a cada proveedor por listado (lo demás se ignora). */
  maxHistorySessionsPerProvider: 500,
  /** Bloques por página de `history.read` (además del tope de bytes de la página). */
  maxHistoryBlocksPage: 100,
  /** Bloques que se leen como máximo de una transcripción; lo demás se descarta. */
  maxHistoryBlocks: 10_000,
  /** Bytes de JSON de los bloques de una página de `history.read`: se corta antes de pasarlo (salvo un bloque solo). */
  maxHistoryPageBytes: 128 * 1024,
  /** Un bloque cuyo JSON pasa de esto se sustituye por un aviso (con escapes cabe en un mensaje). */
  maxHistoryBlockJsonBytes: 600 * 1024,
  maxHistoryCursorLength: 1024,
} as const
