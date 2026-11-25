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
  maxErrorMessageLength: 4096,
  /** Tolerancia de la suma de proporciones de un `Layout`. */
  ratioTolerance: 1e-6,
} as const
