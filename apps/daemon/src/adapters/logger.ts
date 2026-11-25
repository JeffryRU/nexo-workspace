import type { LogFields, LoggerPort } from '@nexo/core'
import type { Redactor } from '../redact.ts'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export type JsonLoggerOptions = {
  redactor: Redactor
  level?: LogLevel
  /** Destino de cada línea ya redactada (stderr por omisión). */
  sink?: (line: string) => void
  now?: () => Date
}

/** Logger de líneas JSON. Todo (mensaje y campos) pasa por el redactor antes de salir. */
export class JsonLogger implements LoggerPort {
  readonly #redactor: Redactor
  readonly #min: number
  readonly #sink: (line: string) => void
  readonly #now: () => Date

  constructor(options: JsonLoggerOptions) {
    this.#redactor = options.redactor
    this.#min = ORDER[options.level ?? 'info']
    this.#sink = options.sink ?? ((line) => process.stderr.write(`${line}\n`))
    this.#now = options.now ?? (() => new Date())
  }

  debug(message: string, fields?: LogFields): void {
    this.#log('debug', message, fields)
  }
  info(message: string, fields?: LogFields): void {
    this.#log('info', message, fields)
  }
  warn(message: string, fields?: LogFields): void {
    this.#log('warn', message, fields)
  }
  error(message: string, fields?: LogFields): void {
    this.#log('error', message, fields)
  }

  #log(level: LogLevel, message: string, fields: LogFields | undefined): void {
    if (ORDER[level] < this.#min) return
    try {
      const safe = fields === undefined ? undefined : this.#redactor.redactValue(fields)
      const record = {
        ...(typeof safe === 'object' && safe !== null ? safe : {}),
        time: this.#now().toISOString(),
        level,
        msg: this.#redactor.redactString(message),
      }
      this.#sink(JSON.stringify(record))
    } catch {
      // Un fallo al registrar nunca debe tumbar al daemon.
    }
  }
}
