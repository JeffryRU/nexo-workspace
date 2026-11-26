import { type ProviderEvent, utf8ByteLength } from '@nexo/contracts'
import {
  AgentProviderError,
  type AgentProviderSession,
  type AgentResponse,
  type Unsubscribe,
} from '@nexo/core'
import { type ChatRequest, type OllamaClient, OllamaRequestError, readBody } from './client.ts'
import { NdjsonSplitter } from './ndjson.ts'
import { OllamaTranslator, type TurnProblem } from './translator.ts'

export type LogEntry = { level: 'debug' | 'info' | 'warn' | 'error'; message: string }

export type SessionLimits = {
  /** Tope en bytes (UTF-8) del historial que se reenvía en cada petición; se descartan los mensajes más antiguos. */
  maxHistoryBytes: number
  /** Una línea NDJSON más larga se considera una respuesta rota. */
  maxLineBytes: number
  /** Bytes totales que se aceptan de la respuesta de un turno. */
  maxTurnBytes: number
  /** Sin recibir nada (ni cabeceras ni datos) durante este tiempo, el turno falla. */
  idleTimeoutMs: number
}

export const DEFAULT_LIMITS: SessionLimits = {
  maxHistoryBytes: 2 * 1024 * 1024,
  maxLineBytes: 1024 * 1024,
  maxTurnBytes: 8 * 1024 * 1024,
  idleTimeoutMs: 300_000,
}

type Message = { role: 'user' | 'assistant'; content: string; bytes: number }

type Turn = {
  ctrl: AbortController
  done: Promise<void>
  interrupted: boolean
  translator: OllamaTranslator
}

class IdleTimeout extends Error {
  constructor(ms: number) {
    super(`sin datos de Ollama durante ${Math.round(ms / 1000)} s`)
    this.name = 'IdleTimeout'
  }
}

export class OllamaSession implements AgentProviderSession {
  readonly providerSessionId: string
  readonly #client: OllamaClient
  readonly #model: string
  readonly #think: boolean | undefined
  readonly #limits: SessionLimits
  readonly #log: (entry: LogEntry) => void
  readonly #listeners = new Set<(event: ProviderEvent) => void>()
  readonly #effort: string | undefined
  readonly #system: string | undefined
  #history: Message[] = []
  #historyBytes = 0
  #closed = false
  #exited = false
  #announced = false
  #refs = 0
  #active: Turn | undefined

  constructor(options: {
    id: string
    client: OllamaClient
    model: string
    effort?: string
    think?: boolean
    limits: SessionLimits
    log: (entry: LogEntry) => void
    /** Mensaje de sistema (bloque de memoria); no cuenta en el historial ni se descarta. */
    system?: string
  }) {
    this.providerSessionId = options.id
    this.#client = options.client
    this.#model = options.model
    this.#effort = options.effort
    this.#think = options.think
    this.#limits = options.limits
    this.#log = options.log
    this.#system = options.system
  }

  onEvent(listener: (event: ProviderEvent) => void): Unsubscribe {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Bytes del historial retenido (para pruebas y diagnóstico). */
  get historyBytes(): number {
    return this.#historyBytes
  }

  async send(text: string): Promise<void> {
    if (this.#closed) throw new AgentProviderError('CLOSED', 'la sesión está cerrada')
    if (text.length === 0) throw new AgentProviderError('INVALID_OPTIONS', 'mensaje vacío')
    if (this.#active !== undefined) throw new AgentProviderError('BUSY', 'ya hay un turno en curso')
    const bytes = utf8ByteLength(text)
    if (bytes > this.#limits.maxHistoryBytes) {
      throw new AgentProviderError('INVALID_OPTIONS', 'el mensaje supera el tope del historial')
    }
    if (!this.#announced) {
      this.#announced = true
      this.#emit({
        type: 'session-info',
        providerSessionId: this.providerSessionId,
        model: this.#model,
        ...(this.#effort === undefined ? {} : { effort: this.#effort }),
        permissionMode: 'ask',
      })
    }
    this.#push({ role: 'user', content: text, bytes })
    const ctrl = new AbortController()
    const translator = new OllamaTranslator({ nextRef: () => `block-${++this.#refs}` })
    const turn: Turn = { ctrl, interrupted: false, translator, done: Promise.resolve() }
    this.#active = turn
    turn.done = this.#run(turn).catch((error: unknown) => {
      this.#log({ level: 'error', message: `turno de Ollama: ${String(error)}` })
    })
  }

  async interrupt(): Promise<void> {
    const turn = this.#active
    if (turn === undefined || this.#closed) return
    turn.interrupted = true
    turn.ctrl.abort(new DOMException('interrumpido', 'AbortError'))
    await turn.done
  }

  respond(_response: AgentResponse): Promise<void> {
    return Promise.reject(
      new AgentProviderError(
        'UNKNOWN_REQUEST',
        'Ollama no hace solicitudes de permiso ni preguntas',
      ),
    )
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const turn = this.#active
    turn?.ctrl.abort(new DOMException('cerrado', 'AbortError'))
    this.#history = []
    this.#historyBytes = 0
    this.#emitExit()
    await turn?.done
  }

  #emitExit(): void {
    if (this.#exited) return
    this.#exited = true
    this.#deliver({ type: 'exit', exitCode: 0, signal: null })
  }

  #emit(event: ProviderEvent): void {
    if (this.#closed) return
    this.#deliver(event)
  }

  #deliver(event: ProviderEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event)
      } catch (error) {
        this.#log({ level: 'warn', message: `un oyente falló: ${String(error)}` })
      }
    }
  }

  #push(message: Message): void {
    this.#history.push(message)
    this.#historyBytes += message.bytes
    // Se descartan los más antiguos, y no se deja un historial que empiece por una respuesta suelta.
    while (
      this.#history.length > 1 &&
      (this.#historyBytes > this.#limits.maxHistoryBytes || this.#history[0]?.role === 'assistant')
    ) {
      const dropped = this.#history.shift()
      this.#historyBytes -= dropped?.bytes ?? 0
    }
  }

  #emitAll(turn: Turn, events: ProviderEvent[]): void {
    for (const event of events) {
      if (event.type === 'turn-end') this.#settle(turn)
      this.#emit(event)
    }
  }

  /** Fija el historial según cómo acabó el turno y libera la sesión para el siguiente `send`. */
  #settle(turn: Turn): void {
    const reason = turn.translator.stopReason
    if (this.#active === turn) this.#active = undefined
    if (this.#closed) return
    if (reason === 'error') {
      // El turno falló: se retira la pregunta para que reintentar no la duplique.
      const last = this.#history[this.#history.length - 1]
      if (last?.role === 'user') {
        this.#history.pop()
        this.#historyBytes -= last.bytes
      }
      return
    }
    const content = turn.translator.content
    if (content !== '') this.#push({ role: 'assistant', content, bytes: utf8ByteLength(content) })
  }

  async #run(turn: Turn): Promise<void> {
    const { ctrl, translator } = turn
    let timer: ReturnType<typeof setTimeout> | undefined
    const touch = () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(
        () => ctrl.abort(new IdleTimeout(this.#limits.idleTimeoutMs)),
        this.#limits.idleTimeoutMs,
      )
    }
    const request: ChatRequest = {
      model: this.#model,
      messages: [
        ...(this.#system === undefined ? [] : [{ role: 'system' as const, content: this.#system }]),
        ...this.#history.map(({ role, content }) => ({ role, content })),
      ],
      ...(this.#think === undefined ? {} : { think: this.#think }),
    }
    try {
      touch()
      const res = await this.#client.chat(request, ctrl.signal)
      touch()
      const splitter = new NdjsonSplitter(this.#limits.maxLineBytes)
      let total = 0
      let overflow: TurnProblem | undefined
      read: for await (const chunk of readBody(res, ctrl.signal)) {
        touch()
        total += chunk.length
        if (total > this.#limits.maxTurnBytes) {
          overflow = {
            code: 'RESPONSE_TOO_LARGE',
            message: 'La respuesta de Ollama superó el tope de tamaño y se cortó.',
          }
          break
        }
        for (const text of splitter.push(chunk)) {
          this.#emitAll(turn, translator.feed(text))
          if (translator.finished) break read
        }
        if (splitter.overflowed) {
          overflow = {
            code: 'INVALID_RESPONSE',
            message: 'Ollama envió una línea demasiado larga; se cortó la respuesta.',
          }
          break
        }
      }
      if (!translator.finished && overflow === undefined) {
        for (const text of splitter.flush()) {
          this.#emitAll(turn, translator.feed(text))
          if (translator.finished) break
        }
      }
      if (translator.invalid > 0) {
        this.#log({ level: 'warn', message: `${translator.invalid} línea(s) ignoradas de Ollama` })
      }
      if (!translator.finished) {
        this.#emitAll(
          turn,
          translator.end(
            'error',
            overflow ?? {
              code: 'STREAM_TRUNCATED',
              message: 'Ollama cerró la conexión antes de terminar la respuesta.',
              retryable: true,
            },
          ),
        )
      }
    } catch (error) {
      if (!translator.finished) {
        const interrupted = turn.interrupted
        this.#emitAll(
          turn,
          interrupted
            ? translator.end('interrupted')
            : translator.end('error', this.#problemOf(error, ctrl.signal)),
        )
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (this.#active === turn) this.#active = undefined
    }
  }

  #problemOf(error: unknown, signal: AbortSignal): TurnProblem {
    if (signal.aborted && signal.reason instanceof IdleTimeout) {
      return {
        code: 'TIMEOUT',
        message: `Ollama no respondió: ${signal.reason.message}.`,
        retryable: true,
      }
    }
    if (error instanceof OllamaRequestError) {
      if (error.kind === 'unreachable') {
        return {
          code: 'OLLAMA_UNREACHABLE',
          message: 'No se pudo conectar con Ollama. ¿Sigue en marcha («ollama serve»)?',
          retryable: true,
        }
      }
      if (error.kind === 'http') {
        const detail = error.serverMessage === undefined ? '' : `: ${error.serverMessage}`
        if (error.status === 404) {
          return {
            code: 'MODEL_NOT_FOUND',
            message: `Ollama no tiene el modelo «${this.#model}»${detail}. Instálalo con «ollama pull ${this.#model}».`,
          }
        }
        if (error.status === 400 && /think/i.test(error.serverMessage ?? '')) {
          return {
            code: 'THINK_UNSUPPORTED',
            message: `El modelo «${this.#model}» no admite razonamiento${detail}. Elige «no-think» o deja el esfuerzo por omisión.`,
          }
        }
        return {
          code: 'OLLAMA_HTTP_ERROR',
          message: `Ollama respondió con el estado ${error.status ?? '?'}${detail}`,
          retryable: (error.status ?? 500) >= 500,
        }
      }
    }
    return {
      code: 'STREAM_FAILED',
      message: `La conexión con Ollama falló: ${error instanceof Error ? error.message : String(error)}`,
      retryable: true,
    }
  }
}
