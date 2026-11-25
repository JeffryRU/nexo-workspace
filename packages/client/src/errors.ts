import type { ErrorCode } from '@nexo/contracts'

/** Códigos del servidor más los que solo existen del lado cliente. */
export type ClientErrorCode =
  | ErrorCode
  | 'TIMEOUT'
  | 'DISCONNECTED'
  | 'ABORTED'
  | 'CLOSED'
  | 'INVALID_RESPONSE'

export class NexoClientError extends Error {
  readonly code: ClientErrorCode
  readonly data?: unknown

  constructor(code: ClientErrorCode, message: string, data?: unknown) {
    super(message)
    this.name = 'NexoClientError'
    this.code = code
    if (data !== undefined) this.data = data
  }
}
