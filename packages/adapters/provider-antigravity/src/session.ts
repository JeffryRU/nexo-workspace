import { randomUUID } from 'node:crypto'
import { type PermissionMode, type ProviderEvent, Token } from '@nexo/contracts'
import {
  AgentProviderError,
  type AgentProviderSession,
  type AgentResponse,
  type Unsubscribe,
} from '@nexo/core'
import { LineSplitter } from './lines.ts'
import type { AgyLauncher, AgyProcess, ExitInfo } from './process.ts'
import { userMessageLine } from './protocol.ts'
import type { SecretRedactor } from './redact.ts'
import type { AgyCommand } from './resolve.ts'
import { AgyTranslator, classifyError, errorMessage } from './translator.ts'

export type LogEntry = { level: 'debug' | 'info' | 'warn' | 'error'; message: string }

export type SessionLimits = {
  /** Sin ninguna salida de `agy` durante este tiempo el turno falla. */
  idleTimeoutMs: number
  /** Tras pedir la interrupción, cuánto se espera a que `agy` acabe antes de cerrar el turno por nuestra cuenta. */
  interruptGraceMs: number
}

export const DEFAULT_LIMITS: SessionLimits = {
  idleTimeoutMs: 1_800_000,
  interruptGraceMs: 3000,
}

/** Banderas de `agy` para cada modo normalizado (verificadas con `agy --help` 1.2.0; ver ARCHITECTURE). */
export const PERMISSION_FLAGS: Record<PermissionMode, readonly string[]> = {
  ask: [],
  'accept-edits': ['--mode', 'accept-edits'],
  plan: ['--mode', 'plan'],
  bypass: ['--dangerously-skip-permissions'],
}

/** Argumentos de `agy` para un turno. La conversación solo se pasa si ya existe en `agy`. */
export function buildArgs(options: {
  conversationId?: string | undefined
  model?: string | undefined
  effort?: string | undefined
  permissionMode: PermissionMode
}): string[] {
  return [
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    ...(options.conversationId === undefined ? [] : ['--conversation', options.conversationId]),
    ...(options.model === undefined ? [] : ['--model', options.model]),
    ...(options.effort === undefined ? [] : ['--effort', options.effort]),
    ...PERMISSION_FLAGS[options.permissionMode],
  ]
}

type Turn = {
  proc: AgyProcess
  interrupting: boolean
  done: boolean
  idle: ReturnType<typeof setTimeout> | undefined
  stderr: string
  stderrLogged: number
  splitter: LineSplitter
  exit: ExitInfo | undefined
  settled: Promise<void>
  settle: () => void
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref()
  })

const STDERR_TAIL = 4096
const STDERR_LOG_LINES = 100

/** Mensaje de la línea `AGY_ERROR: {...}` que `agy` escribe en stderr cuando un turno acaba por un fallo (exit 3). */
export function agyErrorLine(stderr: string): string | undefined {
  const m = /AGY_ERROR:\s*(\{.*\})/.exec(stderr)
  if (m?.[1] === undefined) return undefined
  try {
    const data: unknown = JSON.parse(m[1])
    if (typeof data === 'object' && data !== null) {
      const d = data as Record<string, unknown>
      return errorMessage(d.message ?? d.error ?? d.status) ?? m[1].slice(0, 400)
    }
  } catch {
    // línea no JSON: se usa tal cual abajo
  }
  return m[1].slice(0, 400)
}

/**
 * Una conversación con `agy`: **un proceso por turno** (`agy --output-format stream-json --input-format
 * stream-json [--conversation id]`, el mensaje por stdin y stdin cerrado). La conversación vive en `agy`; la
 * ficha (`providerSessionId`) es su `conversation_id`, que no se conoce hasta el primer turno: antes es un UUID
 * provisional que no se pasa a `agy`, y `session-info` anuncia el real.
 *
 * Garantías: un `turn-end` por `send` (por `result`, o sintético si `agy` muere, no responde a la interrupción
 * o se agota el plazo); `close` mata el proceso en curso y emite `exit` una vez. `agy` en modo `-p` no pide
 * permisos ni hace preguntas: lo no preaprobado se deniega solo (ver ARCHITECTURE).
 */
export class AgySession implements AgentProviderSession {
  readonly #launcher: AgyLauncher
  readonly #command: AgyCommand
  readonly #env: Readonly<Record<string, string | undefined>>
  readonly #cwd: string
  readonly #model: string | undefined
  readonly #effort: string | undefined
  readonly #permissionMode: PermissionMode
  readonly #limits: SessionLimits
  readonly #log: (entry: LogEntry) => void
  readonly #redactor: SecretRedactor
  readonly #maxLineLength: number
  readonly #translator: AgyTranslator
  readonly #listeners = new Set<(event: ProviderEvent) => void>()
  #id: string
  #known: boolean
  #refs = 0
  #announced = false
  #closed = false
  #exited = false
  #active: Turn | undefined
  #closing: Promise<void> | undefined

  constructor(options: {
    launcher: AgyLauncher
    command: AgyCommand
    env: Readonly<Record<string, string | undefined>>
    cwd: string
    resume?: string | undefined
    model?: string | undefined
    effort?: string | undefined
    permissionMode: PermissionMode
    limits: SessionLimits
    log: (entry: LogEntry) => void
    redactor: SecretRedactor
    maxLineLength: number
  }) {
    this.#launcher = options.launcher
    this.#command = options.command
    this.#env = options.env
    this.#cwd = options.cwd
    this.#model = options.model
    this.#effort = options.effort
    this.#permissionMode = options.permissionMode
    this.#limits = options.limits
    this.#log = options.log
    this.#redactor = options.redactor
    this.#maxLineLength = options.maxLineLength
    this.#id = options.resume ?? randomUUID()
    this.#known = options.resume !== undefined
    this.#translator = new AgyTranslator({
      nextRef: () => `step-${++this.#refs}`,
      cwd: options.cwd,
    })
  }

  get providerSessionId(): string {
    return this.#id
  }

  onEvent(listener: (event: ProviderEvent) => void): Unsubscribe {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  send(text: string): Promise<void> {
    if (this.#closed)
      return Promise.reject(new AgentProviderError('CLOSED', 'la sesión está cerrada'))
    if (text.length === 0)
      return Promise.reject(new AgentProviderError('INVALID_OPTIONS', 'mensaje vacío'))
    if (this.#active !== undefined) {
      return Promise.reject(new AgentProviderError('BUSY', 'ya hay un turno en curso'))
    }
    if (!this.#announced) {
      this.#announced = true
      this.#emit({
        type: 'session-info',
        ...(this.#known ? { providerSessionId: this.#id } : {}),
        ...(this.#model !== undefined && Token.safeParse(this.#model).success
          ? { model: this.#model }
          : {}),
        ...(this.#effort === undefined ? {} : { effort: this.#effort }),
        permissionMode: this.#permissionMode,
      })
    }
    this.#translator.beginTurn()
    const args = buildArgs({
      conversationId: this.#known ? this.#id : undefined,
      model: this.#model,
      effort: this.#effort,
      permissionMode: this.#permissionMode,
    })
    let settle: () => void = () => {}
    const turn: Turn = {
      proc: this.#launcher({ command: this.#command, args, cwd: this.#cwd, env: this.#env }),
      interrupting: false,
      done: false,
      idle: undefined,
      stderr: '',
      stderrLogged: 0,
      splitter: new LineSplitter({
        maxLength: this.#maxLineLength,
        onLine: (l) => this.#onLine(turn, l),
        onOverflow: () =>
          this.#log({ level: 'warn', message: 'línea de agy descartada: supera el tamaño máximo' }),
      }),
      exit: undefined,
      settled: new Promise<void>((r) => {
        settle = r
      }),
      settle: () => settle(),
    }
    this.#active = turn
    this.#touch(turn)
    turn.proc.onStdout((chunk) => {
      this.#touch(turn)
      if (!turn.done) turn.splitter.push(chunk)
    })
    turn.proc.onStderr((chunk) => this.#onStderr(turn, chunk))
    turn.proc.onExit((info) => this.#onProcessExit(turn, info))
    turn.proc.writeAndClose(userMessageLine(text))
    return Promise.resolve()
  }

  async interrupt(): Promise<void> {
    const turn = this.#active
    if (turn === undefined || this.#closed) return
    if (!turn.interrupting) {
      turn.interrupting = true
      turn.proc.interrupt(this.#limits.interruptGraceMs)
    }
    await Promise.race([turn.settled, delay(this.#limits.interruptGraceMs + 1500)])
    if (this.#active === turn) this.#emitAll(turn, this.#translator.end('interrupted'))
    turn.proc.kill(500)
  }

  respond(response: AgentResponse): Promise<void> {
    return Promise.reject(
      new AgentProviderError(
        'UNKNOWN_REQUEST',
        response.type === 'permission'
          ? 'Antigravity no pide permisos en modo no interactivo'
          : 'Antigravity no hace preguntas en modo no interactivo',
      ),
    )
  }

  close(): Promise<void> {
    this.#closing ??= this.#close()
    return this.#closing
  }

  async #close(): Promise<void> {
    this.#closed = true
    const turn = this.#active
    let info: ExitInfo | undefined
    if (turn !== undefined) {
      this.#finishTurn(turn)
      turn.proc.kill(1500)
      info = await Promise.race([
        new Promise<ExitInfo>((resolve) => turn.proc.onExit(resolve)),
        delay(3500).then(() => undefined),
      ])
    }
    this.#emitExit(info ?? { exitCode: 0, signal: null })
  }

  // ---- entrada de agy ----

  #onLine(turn: Turn, text: string): void {
    if (turn.done || this.#closed || this.#active !== turn) return
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      this.#log({
        level: 'debug',
        message: `línea de agy que no es JSON: ${this.#redactor.redact(text).slice(0, 200)}`,
      })
      return
    }
    const events = this.#translator.feed(value)
    const id = this.#translator.conversationId
    if (id !== undefined) {
      this.#id = id
      this.#known = true
    }
    this.#emitAll(turn, events)
  }

  #onStderr(turn: Turn, chunk: string): void {
    this.#touch(turn)
    turn.stderr = (turn.stderr + chunk).slice(-STDERR_TAIL)
    if (turn.stderrLogged >= STDERR_LOG_LINES) return
    for (const l of chunk.split('\n')) {
      const clean = l.trim()
      if (clean === '' || turn.stderrLogged >= STDERR_LOG_LINES) continue
      turn.stderrLogged++
      this.#log({
        level: 'debug',
        message: `stderr: ${this.#redactor.redact(clean).slice(0, 500)}`,
      })
    }
  }

  #onProcessExit(turn: Turn, info: ExitInfo): void {
    turn.exit = info
    turn.splitter.flush()
    if (turn.done) return
    if (this.#active !== turn) return
    if (this.#closed) {
      this.#finishTurn(turn)
      return
    }
    if (turn.interrupting) {
      this.#emitAll(turn, this.#translator.end('interrupted'))
      return
    }
    if (info.error !== undefined) {
      // No se pudo lanzar (el ejecutable desapareció, sin permisos...): la sesión no sirve.
      this.#closed = true
      this.#deliver({
        type: 'error',
        error: {
          code: 'AGY_EXITED',
          message: `No se pudo lanzar «agy»: ${this.#redactor.redact(info.error.message)}`.slice(
            0,
            2000,
          ),
          fatal: true,
        },
      })
      this.#finishTurn(turn)
      this.#emitExit(info)
      return
    }
    const tail = this.#redactor.redact(turn.stderr).trim()
    const fromLine = agyErrorLine(tail)
    const how = `terminó sin dar un resultado (código ${info.exitCode ?? 'ninguno'}${info.signal === null ? '' : `, señal ${info.signal}`})`
    const problem =
      fromLine !== undefined
        ? classifyError(fromLine)
        : {
            code: 'AGY_EXITED',
            message:
              `«agy» ${how}.${tail === '' ? '' : ` Últimas líneas de stderr: ${tail.slice(-600)}`}`.replace(
                /\s+/g,
                ' ',
              ),
          }
    this.#emitAll(turn, this.#translator.end('error', problem))
  }

  // ---- salida ----

  #emitExit(info: ExitInfo): void {
    if (this.#exited) return
    this.#exited = true
    this.#deliver({
      type: 'exit',
      exitCode: info.exitCode,
      signal: info.signal === null ? null : info.signal.slice(0, 32),
    })
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

  #emitAll(turn: Turn, events: ProviderEvent[]): void {
    for (const event of events) {
      if (event.type === 'turn-end') {
        this.#finishTurn(turn)
        // Pedir interrumpir gana a un resultado que llegó justo antes de que la señal surtiera efecto.
        const stopReason =
          turn.interrupting && event.stopReason !== 'error' ? 'interrupted' : event.stopReason
        this.#emit({ ...event, stopReason })
      } else this.#emit(event)
    }
  }

  /** Libera la sesión para el siguiente `send`. Un proceso que no acaba solo tras el resultado se mata. */
  #finishTurn(turn: Turn): void {
    if (turn.idle !== undefined) clearTimeout(turn.idle)
    turn.idle = undefined
    turn.done = true
    if (this.#active === turn) this.#active = undefined
    if (turn.exit === undefined) {
      const timer = setTimeout(() => turn.proc.kill(500), 5000)
      timer.unref()
    }
    turn.settle()
  }

  #touch(turn: Turn): void {
    if (turn.idle !== undefined) clearTimeout(turn.idle)
    turn.idle = undefined
    if (turn.done) return
    turn.idle = setTimeout(() => this.#onIdle(turn), this.#limits.idleTimeoutMs)
    turn.idle.unref()
  }

  #onIdle(turn: Turn): void {
    if (this.#active !== turn || this.#closed) return
    this.#log({ level: 'warn', message: 'turno de agy sin actividad: se da por fallido' })
    turn.interrupting = true
    turn.proc.kill(500)
    this.#emitAll(
      turn,
      this.#translator.end('error', {
        code: 'TIMEOUT',
        message: `Antigravity no dio señales durante ${Math.round(this.#limits.idleTimeoutMs / 1000)} s; se cortó el turno.`,
        retryable: true,
      }),
    )
  }
}
