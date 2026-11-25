import { NexoClientError } from '@nexo/client'
import { DiscoveryError } from '@nexo/client/node'

/** Códigos de salida estables de la CLI. */
export const EXIT = { ok: 0, usage: 1, notFound: 2, unavailable: 3, daemon: 4 } as const
export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

export type ErrorKind = 'USAGE' | 'NOT_FOUND' | 'DAEMON_UNAVAILABLE' | 'DAEMON_ERROR'

const EXIT_OF: Record<ErrorKind, ExitCode> = {
  USAGE: EXIT.usage,
  NOT_FOUND: EXIT.notFound,
  DAEMON_UNAVAILABLE: EXIT.unavailable,
  DAEMON_ERROR: EXIT.daemon,
}

export class CliError extends Error {
  readonly kind: ErrorKind
  constructor(kind: ErrorKind, message: string) {
    super(message)
    this.name = 'CliError'
    this.kind = kind
  }
  get exitCode(): ExitCode {
    return EXIT_OF[this.kind]
  }
}

export const usageError = (message: string) => new CliError('USAGE', message)
export const notFoundError = (message: string) => new CliError('NOT_FOUND', message)
export const unavailableError = (message: string) => new CliError('DAEMON_UNAVAILABLE', message)

const DISCOVERY_MESSAGES: Record<string, string> = {
  NOT_RUNNING: 'Nexo no está corriendo (no uses --no-start para que la CLI lo arranque)',
  STALE: 'daemon.json existe pero el daemon no responde; revisa `nexo daemon log`',
  CORRUPT: 'los archivos de estado del daemon no son válidos',
  START_TIMEOUT: 'el daemon no arrancó a tiempo; revisa `nexo daemon log`',
}

/** Convierte cualquier error en un `CliError` con mensaje en español y código estable. */
export function classifyError(error: unknown): CliError {
  if (error instanceof CliError) return error
  if (error instanceof DiscoveryError) {
    return unavailableError(DISCOVERY_MESSAGES[error.code] ?? 'el daemon no está disponible')
  }
  if (error instanceof NexoClientError) {
    switch (error.code) {
      case 'NOT_FOUND':
        return notFoundError(error.message)
      case 'INVALID_PARAMS':
        return usageError(error.message)
      case 'TIMEOUT':
      case 'DISCONNECTED':
      case 'CLOSED':
      case 'ABORTED':
        return unavailableError(`sin conexión con el daemon: ${error.message}`)
      default:
        return new CliError(
          'DAEMON_ERROR',
          `el daemon respondió con error (${error.code}): ${error.message}`,
        )
    }
  }
  return new CliError('DAEMON_ERROR', 'error inesperado (usa NEXO_DEBUG=1 para más detalle)')
}
