import { NexoClientError } from '@nexo/client'
import { DiscoveryError } from '@nexo/client/node'
import { oneLine, redact } from './text.ts'

/** No se pudo hablar con el daemon (no corre, token viejo, conexión caída). */
export class DaemonUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonUnavailableError'
  }
}

/** Error esperado de una herramienta (permiso, tope, argumento): se devuelve tal cual al modelo. */
export class ToolError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ToolError'
    this.code = code
  }
}

const HINTS: Record<string, string> = {
  NOT_FOUND: 'no existe; vuelve a listar (el id pudo cambiar o cerrarse)',
  INVALID_PARAMS: 'el daemon rechazó los argumentos',
  CONFLICT: 'el estado actual no lo permite (¿turno en curso, algo ya resuelto?)',
  FORBIDDEN: 'prohibido por el daemon',
  UNAUTHORIZED: 'el daemon rechazó la autenticación',
  PROVIDER_UNAVAILABLE: 'el proveedor no está disponible',
  PAYLOAD_TOO_LARGE: 'el mensaje es demasiado grande',
  RATE_LIMITED: 'el daemon limita la frecuencia; espera un momento',
  TIMEOUT: 'el daemon no respondió a tiempo',
  DISCONNECTED: 'se perdió la conexión con el daemon; reintenta',
  CLOSED: 'la conexión con el daemon está cerrada; reintenta',
  INVALID_RESPONSE: 'respuesta inesperada del daemon',
  INTERNAL: 'error interno del daemon',
}

export type Described = { code: string; message: string }

/** Traduce cualquier error a un código y un mensaje cortos, saneados y sin credenciales. */
export function describeError(error: unknown): Described {
  if (error instanceof ToolError) {
    return { code: error.code, message: oneLine(redact(error.message), 400) }
  }
  if (error instanceof DaemonUnavailableError) {
    return { code: 'DAEMON_UNAVAILABLE', message: oneLine(redact(error.message), 400) }
  }
  if (error instanceof DiscoveryError) {
    return { code: 'DAEMON_UNAVAILABLE', message: daemonDownMessage(error) }
  }
  if (error instanceof NexoClientError) {
    const hint = HINTS[error.code] ?? 'error del daemon'
    const detail = oneLine(redact(error.message), 300)
    return { code: error.code, message: `${hint}${detail === '' ? '' : ` (${detail})`}` }
  }
  return { code: 'INTERNAL', message: 'error inesperado en el servidor MCP' }
}

export function daemonDownMessage(error: DiscoveryError): string {
  const why =
    error.code === 'NOT_RUNNING'
      ? 'no está corriendo'
      : error.code === 'STALE'
        ? 'dejó un registro viejo (se cerró mal)'
        : error.code === 'CORRUPT'
          ? 'tiene un registro ilegible'
          : 'no respondió a tiempo'
  return `El daemon de Nexo ${why}. Abre Nexo (o ejecuta \`nexo status\`) y vuelve a intentarlo.`
}
