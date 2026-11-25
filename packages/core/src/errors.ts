import type { ErrorCode } from '@nexo/contracts'

/** Error de dominio con un código estable del protocolo. */
export class DomainError extends Error {
  readonly code: ErrorCode
  readonly data?: unknown

  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(message)
    this.name = 'DomainError'
    this.code = code
    if (data !== undefined) this.data = data
  }
}
