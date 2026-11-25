import {
  LIMITS,
  type PermissionOption,
  type ProviderEvent,
  type Question,
  Questions,
  utf8ByteLength,
  validateAnswers,
} from '@nexo/contracts'
import {
  AgentProviderError,
  type AgentProviderSession,
  type AgentResponse,
  type Unsubscribe,
} from '@nexo/core'
import { z } from 'zod'
import { authError, looksLikeAuthFailure } from './errors.ts'
import { body, line } from './text.ts'
import type { ClaudeTranslator } from './translator.ts'
import type { ClaudeTransportSession, PermissionAsk, PermissionDecision } from './transport.ts'

export type LogEntry = { level: 'debug' | 'warn' | 'error'; message: string }

export type SessionDeps = {
  transport: ClaudeTransportSession
  translator: ClaudeTranslator
  /** Redactor de secretos: todo texto que sale hacia logs o errores pasa por él. */
  redact: (text: string) => string
  log?: (entry: LogEntry) => void
  /** Tiempo que se espera el `result` del SDK tras pedirle interrumpir antes de dar el turno por terminado. */
  interruptTimeoutMs: number
}

type PendingRequest =
  | {
      kind: 'permission'
      options: Map<string, PermissionOption>
      input: Record<string, unknown>
      suggestions: readonly unknown[]
      resolve: (d: PermissionDecision) => void
      dispose: () => void
    }
  | {
      kind: 'question'
      questions: Question[]
      input: Record<string, unknown>
      rawQuestions: readonly { question: string }[]
      resolve: (d: PermissionDecision) => void
      dispose: () => void
    }

/** Solicitudes pendientes a la vez; más allá se deniegan (un SDK desbocado no llena la memoria). */
const MAX_PENDING = 32

const AskInput = z.looseObject({
  questions: z
    .array(
      z.looseObject({
        question: z.string().min(1),
        header: z.string().optional(),
        multiSelect: z.boolean().optional(),
        options: z.array(
          z.looseObject({ label: z.string().min(1), description: z.string().optional() }),
        ),
      }),
    )
    .min(1)
    .max(LIMITS.maxQuestions),
})

const OPT_ALLOW = 'allow'
const OPT_ALLOW_ALWAYS = 'allow-always'
const OPT_REJECT = 'reject'

/**
 * Una conversación viva con Claude Code: un proceso del SDK con entrada en streaming. Traduce los mensajes
 * con `ClaudeTranslator`, atiende `canUseTool` (permisos y `AskUserQuestion`) y cumple el contrato de
 * `AgentProviderSession`: exactamente un `turn-end` por `send`, o `exit` si el proceso muere.
 */
export class ClaudeSession implements AgentProviderSession {
  readonly providerSessionId: string
  readonly #deps: SessionDeps
  readonly #listeners = new Set<(event: ProviderEvent) => void>()
  readonly #pending = new Map<string, PendingRequest>()
  #requestCounter = 0
  #closed = false
  #exited = false
  #turn = false
  #interrupting = false
  #interruptTimer: ReturnType<typeof setTimeout> | undefined
  #pump: Promise<void> = Promise.resolve()
  #lastStderr = ''

  constructor(deps: SessionDeps) {
    this.#deps = deps
    this.providerSessionId = deps.transport.sessionId
  }

  /** Empieza a leer los mensajes del SDK. La fábrica lo llama una vez, tras construir la sesión. */
  start(): void {
    this.#pump = this.#run()
  }

  onEvent(listener: (event: ProviderEvent) => void): Unsubscribe {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Texto de stderr del proceso (ya redactado por quien lo reenvía). */
  noteStderr(text: string): void {
    this.#lastStderr = `${this.#lastStderr}${text}`.slice(-4096)
  }

  async send(text: string): Promise<void> {
    if (this.#closed) throw new AgentProviderError('CLOSED', 'la sesión está cerrada')
    if (text.trim() === '') throw new AgentProviderError('INVALID_OPTIONS', 'el mensaje está vacío')
    if (utf8ByteLength(text) > LIMITS.maxBlockTextBytes) {
      throw new AgentProviderError('INVALID_OPTIONS', 'el mensaje es demasiado largo')
    }
    if (this.#turn) throw new AgentProviderError('BUSY', 'ya hay un turno en curso')
    this.#turn = true
    this.#deps.translator.beginTurn()
    try {
      this.#deps.transport.send(body(text, LIMITS.maxBlockTextBytes).text)
    } catch (cause) {
      this.#turn = false
      this.#deps.translator.closeForDeath()
      throw new AgentProviderError('CLOSED', 'no se pudo enviar el mensaje a Claude', { cause })
    }
  }

  async interrupt(): Promise<void> {
    if (this.#closed || !this.#turn || this.#interrupting) return
    this.#interrupting = true
    this.#deps.translator.markInterrupted()
    for (const id of [...this.#pending.keys()]) this.#cancel(id, true)
    this.#interruptTimer = setTimeout(() => this.#abandon(), this.#deps.interruptTimeoutMs)
    this.#interruptTimer.unref?.()
    try {
      await Promise.race([
        this.#deps.transport.interrupt(),
        new Promise<void>((resolve) =>
          setTimeout(resolve, this.#deps.interruptTimeoutMs).unref?.(),
        ),
      ])
    } catch (error) {
      this.#note('warn', `interrupt falló: ${errorText(error)}`)
    }
  }

  async respond(response: AgentResponse): Promise<void> {
    if (this.#closed) throw new AgentProviderError('CLOSED', 'la sesión está cerrada')
    const pending = this.#pending.get(response.requestId)
    if (pending === undefined) {
      throw new AgentProviderError('UNKNOWN_REQUEST', 'solicitud desconocida o ya respondida')
    }
    if (response.type === 'permission') {
      if (pending.kind !== 'permission') {
        throw new AgentProviderError('INVALID_OPTIONS', 'la solicitud no es un permiso')
      }
      const option = pending.options.get(response.optionId)
      if (option === undefined)
        throw new AgentProviderError('INVALID_OPTIONS', 'opción desconocida')
      this.#drop(response.requestId, pending)
      pending.resolve(
        option.kind.startsWith('allow')
          ? {
              behavior: 'allow',
              updatedInput: pending.input,
              ...(option.id === OPT_ALLOW_ALWAYS
                ? { updatedPermissions: pending.suggestions }
                : {}),
            }
          : { behavior: 'deny', message: 'El usuario rechazó esta acción.' },
      )
      return
    }
    if (pending.kind !== 'question') {
      throw new AgentProviderError('INVALID_OPTIONS', 'la solicitud no es una pregunta')
    }
    const problem = validateAnswers(pending.questions, response.answers)
    if (problem !== null) throw new AgentProviderError('INVALID_OPTIONS', problem)
    const answers: Record<string, string> = {}
    pending.questions.forEach((q, i) => {
      const a = response.answers.find((x) => x.questionId === q.id)
      const key = pending.rawQuestions[i]?.question ?? q.question
      if (a === undefined) return
      const parts = [...a.selected, ...(a.text === undefined ? [] : [a.text])]
      answers[key] = parts.join(', ')
    })
    this.#drop(response.requestId, pending)
    pending.resolve({
      behavior: 'allow',
      updatedInput: { ...pending.input, questions: pending.input.questions, answers },
    })
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true
      this.#clearInterruptTimer()
      for (const [id, p] of [...this.#pending]) {
        this.#drop(id, p)
        p.resolve({ behavior: 'deny', message: 'La sesión se cerró.', interrupt: true })
      }
      try {
        this.#deps.transport.close()
      } catch (error) {
        this.#note('warn', `close falló: ${errorText(error)}`)
      }
    }
    await Promise.race([
      this.#pump,
      new Promise<void>((resolve) => setTimeout(resolve, 2000).unref?.()),
    ])
    this.#emitExit(null)
  }

  /** `canUseTool` del SDK: permisos y `AskUserQuestion`. */
  async ask(ask: PermissionAsk): Promise<PermissionDecision> {
    if (this.#closed || !this.#turn || ask.signal.aborted) {
      return { behavior: 'deny', message: 'No hay un turno en curso.', interrupt: true }
    }
    if (this.#pending.size >= MAX_PENDING) {
      return { behavior: 'deny', message: 'Demasiadas solicitudes pendientes.' }
    }
    return ask.toolName === 'AskUserQuestion' ? this.#askQuestion(ask) : this.#askPermission(ask)
  }

  // ---- solicitudes ----

  #askPermission(ask: PermissionAsk): Promise<PermissionDecision> {
    const requestId = this.#newRequestId()
    const suggestions = ask.suggestions ?? []
    const options: PermissionOption[] = [
      { id: OPT_ALLOW, label: 'Permitir', kind: 'allow-once' },
      ...(suggestions.length > 0
        ? [{ id: OPT_ALLOW_ALWAYS, label: 'Permitir siempre', kind: 'allow-always' as const }]
        : []),
      { id: OPT_REJECT, label: 'Rechazar', kind: 'reject-once' },
    ]
    const tool = line(ask.toolName, 128, 'herramienta')
    const title = line(
      ask.title ?? ask.displayName ?? `Claude quiere usar ${tool}`,
      LIMITS.maxTitleLength,
      `Claude quiere usar ${tool}`,
    )
    const detailText = [ask.description, ask.blockedPath, safeJson(ask.input)]
      .filter((t): t is string => t !== undefined && t !== '')
      .join('\n')
    const detail = body(this.#deps.redact(detailText), LIMITS.maxBlockInputBytes).text
    return new Promise<PermissionDecision>((resolve) => {
      this.#register(requestId, ask.signal, (dispose) => ({
        kind: 'permission',
        options: new Map(options.map((o) => [o.id, o])),
        input: ask.input,
        suggestions,
        resolve,
        dispose,
      }))
      this.#emit({
        type: 'permission-request',
        requestId,
        tool,
        title,
        ...(detail === '' ? {} : { detail }),
        options,
      })
    })
  }

  #askQuestion(ask: PermissionAsk): Promise<PermissionDecision> {
    const parsed = AskInput.safeParse(ask.input)
    if (!parsed.success) {
      return Promise.resolve({
        behavior: 'deny',
        message: 'La pregunta no tiene un formato válido.',
      })
    }
    const raw = parsed.data.questions
    const questions: Question[] = raw.map((q, i) => {
      const header = line(q.header ?? '', 64)
      return {
        id: `q${i + 1}`,
        ...(header === '' ? {} : { header }),
        question: body(q.question, 4096).text,
        options: q.options.slice(0, LIMITS.maxBlockOptions).map((o) => {
          const description = line(o.description ?? '', 1024)
          return {
            label: line(o.label, LIMITS.maxTitleLength, 'opción'),
            ...(description === '' ? {} : { description }),
          }
        }),
        multiSelect: q.multiSelect === true,
        allowText: true,
      }
    })
    const valid = Questions.safeParse(questions)
    if (!valid.success) {
      return Promise.resolve({
        behavior: 'deny',
        message: 'La pregunta no tiene un formato válido.',
      })
    }
    const requestId = this.#newRequestId()
    return new Promise<PermissionDecision>((resolve) => {
      this.#register(requestId, ask.signal, (dispose) => ({
        kind: 'question',
        questions,
        input: ask.input,
        rawQuestions: raw,
        resolve,
        dispose,
      }))
      this.#emit({ type: 'question-request', requestId, questions })
    })
  }

  #register(
    requestId: string,
    signal: AbortSignal,
    make: (dispose: () => void) => PendingRequest,
  ): void {
    const onAbort = () => {
      if (this.#pending.has(requestId)) this.#cancel(requestId, false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    this.#pending.set(
      requestId,
      make(() => signal.removeEventListener('abort', onAbort)),
    )
  }

  #drop(id: string, pending: PendingRequest): void {
    pending.dispose()
    this.#pending.delete(id)
  }

  /** Retira una solicitud: avisa con `request-cancelled` y deniega al SDK. */
  #cancel(id: string, interrupt: boolean): void {
    const pending = this.#pending.get(id)
    if (pending === undefined) return
    this.#drop(id, pending)
    if (!this.#closed) this.#emit({ type: 'request-cancelled', requestId: id })
    pending.resolve({ behavior: 'deny', message: 'La solicitud se canceló.', interrupt })
  }

  #newRequestId(): string {
    return `req-${++this.#requestCounter}`
  }

  // ---- lectura del SDK ----

  async #run(): Promise<void> {
    let failure: unknown
    try {
      for await (const message of this.#deps.transport.messages) {
        if (this.#closed) break
        this.#handle(message)
      }
    } catch (error) {
      failure = error
    }
    if (this.#closed) return
    this.#die(failure)
  }

  #handle(message: unknown): void {
    let events: ProviderEvent[]
    try {
      events = this.#deps.translator.translate(message)
    } catch (error) {
      this.#note('error', `la traducción falló: ${errorText(error)}`)
      return
    }
    for (const event of events) {
      this.#emit(event)
      if (event.type === 'turn-end') this.#turnEnded()
    }
  }

  #turnEnded(): void {
    this.#turn = false
    this.#interrupting = false
    this.#clearInterruptTimer()
    // El servicio ya cancela lo pendiente al recibir `turn-end`: aquí solo se libera al SDK.
    for (const [id, p] of [...this.#pending]) {
      this.#drop(id, p)
      p.resolve({ behavior: 'deny', message: 'El turno terminó.' })
    }
  }

  /** El SDK no contestó a la interrupción a tiempo: se da el turno por terminado. */
  #abandon(): void {
    this.#interruptTimer = undefined
    if (this.#closed || !this.#turn) return
    for (const event of this.#deps.translator.abandonTurn('interrupted')) {
      this.#emit(event)
      if (event.type === 'turn-end') this.#turnEnded()
    }
  }

  /** El proceso terminó sin que se pidiera. */
  #die(failure: unknown): void {
    this.#closed = true
    this.#clearInterruptTimer()
    for (const [id, p] of [...this.#pending]) {
      this.#drop(id, p)
      p.resolve({ behavior: 'deny', message: 'El proceso terminó.', interrupt: true })
    }
    const detail = `${errorText(failure)}\n${this.#lastStderr}`
    const code = /exited with code (\d+)/i.exec(detail)
    for (const event of this.#deps.translator.closeForDeath()) this.#emit(event, true)
    this.#turn = false
    const auth = looksLikeAuthFailure(detail)
    this.#emit(
      {
        type: 'error',
        error: auth
          ? authError()
          : {
              code: 'PROCESS_DIED',
              message: body(
                this.#deps.redact(
                  `El proceso de Claude terminó de forma inesperada${
                    failure === undefined ? '.' : `: ${errorText(failure)}`
                  }`,
                ),
                8 * 1024 - 8,
              ).text,
              fatal: true,
              retryable: false,
            },
      },
      true,
    )
    this.#emitExit(code === null ? null : Number(code[1]))
  }

  #emitExit(exitCode: number | null): void {
    if (this.#exited) return
    this.#exited = true
    this.#emit({ type: 'exit', exitCode, signal: null }, true)
  }

  #emit(event: ProviderEvent, force = false): void {
    if (this.#closed && !force && event.type !== 'exit') return
    if (this.#exited && event.type !== 'exit') return
    for (const listener of [...this.#listeners]) {
      try {
        listener(event)
      } catch (error) {
        this.#note('warn', `un oyente falló: ${errorText(error)}`)
      }
    }
  }

  #clearInterruptTimer(): void {
    if (this.#interruptTimer !== undefined) clearTimeout(this.#interruptTimer)
    this.#interruptTimer = undefined
  }

  #note(level: LogEntry['level'], message: string): void {
    this.#deps.log?.({ level, message: this.#deps.redact(message) })
  }
}

function errorText(error: unknown): string {
  if (error === undefined) return ''
  return line(error instanceof Error ? error.message : String(error), 1024, 'error desconocido')
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    return ''
  }
}
