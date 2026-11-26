import {
  type IncomingNotification,
  type IncomingRequest,
  JsonRpcConnection,
  type ProtocolIssue,
  type Timers,
} from '@nexo/jsonrpc'
import type { z } from 'zod'
import type { CodexLauncher, CodexProcess, ExitInfo } from './process.ts'
import { InitializeResult } from './protocol.ts'
import type { SecretRedactor } from './redact.ts'
import type { CodexCommand } from './resolve.ts'

export type LogEntry = { level: 'debug' | 'info' | 'warn' | 'error'; message: string }

export const nodeTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export type ClientOptions = {
  launcher: CodexLauncher
  command: CodexCommand
  cwd: string
  env: Readonly<Record<string, string | undefined>>
  log: (entry: LogEntry) => void
  redactor: SecretRedactor
  requestTimeoutMs: number
  maxLineLength: number
  clientVersion: string
}

const STDERR_TAIL = 4096
const STDERR_LOG_LINES = 100

/**
 * Un proceso `codex app-server` con su conexión JSON-RPC (`@nexo/jsonrpc`, sin el campo `jsonrpc`, que
 * Codex omite). Une las tres capas de E/S: proceso → texto → conexión; guarda el final de stderr para
 * diagnóstico (redactado) y expone cuándo termina el proceso.
 */
export class CodexClient {
  readonly #process: CodexProcess
  readonly #conn: JsonRpcConnection
  readonly #log: (entry: LogEntry) => void
  readonly #redactor: SecretRedactor
  readonly #o: ClientOptions
  #stderr = ''
  #stderrLogged = 0
  #exitInfo: ExitInfo | undefined
  #exitListeners: ((info: ExitInfo) => void)[] = []
  #notification: (n: IncomingNotification) => void = () => {}
  #request: (r: IncomingRequest) => unknown = () => {
    throw new Error('sin atendedor')
  }
  readonly exited: Promise<ExitInfo>

  constructor(options: ClientOptions) {
    this.#o = options
    this.#log = options.log
    this.#redactor = options.redactor
    this.#process = options.launcher({
      command: options.command,
      cwd: options.cwd,
      env: options.env,
    })
    this.#conn = new JsonRpcConnection({
      write: (line) => this.#process.write(line),
      timers: nodeTimers,
      version: 'omit',
      maxLineLength: options.maxLineLength,
      requestTimeoutMs: options.requestTimeoutMs,
      onNotification: (n) => this.#notification(n),
      onRequest: (r) => this.#request(r),
      onIssue: (issue) => this.#onIssue(issue),
    })
    this.exited = new Promise((resolve) => {
      this.#process.onExit((info) => {
        this.#exitInfo = info
        this.#conn.end(
          new Error(
            info.error === undefined
              ? `codex app-server terminó (código ${info.exitCode ?? 'ninguno'}${info.signal === null ? '' : `, señal ${info.signal}`})`
              : `no se pudo lanzar codex: ${info.error.message}`,
          ),
        )
        for (const l of this.#exitListeners.splice(0)) l(info)
        resolve(info)
      })
    })
    this.#process.onStdout((text) => this.#conn.feed(text))
    this.#process.onStderr((text) => this.#onStderr(text))
  }

  get closed(): boolean {
    return this.#conn.closed
  }
  get exitInfo(): ExitInfo | undefined {
    return this.#exitInfo
  }
  /** Final de stderr, redactado (para el mensaje cuando el proceso muere). */
  stderrTail(): string {
    return this.#redactor.redact(this.#stderr).trim()
  }

  setHandlers(handlers: {
    onNotification: (n: IncomingNotification) => void
    onRequest: (r: IncomingRequest) => unknown
  }): void {
    this.#notification = handlers.onNotification
    this.#request = handlers.onRequest
  }

  onExit(listener: (info: ExitInfo) => void): void {
    if (this.#exitInfo !== undefined) listener(this.#exitInfo)
    else this.#exitListeners.push(listener)
  }

  /** Solicitud con su resultado validado por `schema`; rechaza con `RpcError`, `RpcTimeoutError` o `RpcClosedError`. */
  async call<S extends z.ZodType>(
    method: string,
    params: unknown,
    schema: S,
    timeoutMs?: number,
  ): Promise<z.infer<S>> {
    const result = await this.#conn.request(
      method,
      params,
      timeoutMs === undefined ? {} : { timeoutMs },
    )
    const parsed = schema.safeParse(result)
    if (!parsed.success) throw new Error(`respuesta inválida de «${method}»`)
    return parsed.data
  }

  /** Solicitud sin validar el resultado. */
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    return this.#conn.request(method, params, timeoutMs === undefined ? {} : { timeoutMs })
  }

  notify(method: string, params?: unknown): void {
    this.#conn.notify(method, params)
  }

  /** `initialize` + `initialized`. */
  async handshake(): Promise<void> {
    await this.call(
      'initialize',
      {
        clientInfo: {
          name: 'nexo-workspace',
          title: 'Nexo Workspace',
          version: this.#o.clientVersion,
        },
        capabilities: { experimentalApi: false, requestAttestation: false },
      },
      InitializeResult,
    )
    this.notify('initialized')
  }

  close(graceMs?: number): void {
    this.#conn.close(new Error('sesión cerrada'))
    this.#process.kill(graceMs)
  }

  #onIssue(issue: ProtocolIssue): void {
    this.#log({
      level: issue.kind === 'unknown-response' ? 'debug' : 'warn',
      message: `JSON-RPC de codex: ${issue.kind} (${this.#redactor.redact(issue.detail).slice(0, 200)})`,
    })
  }

  #onStderr(text: string): void {
    this.#stderr = (this.#stderr + text).slice(-STDERR_TAIL)
    if (this.#stderrLogged >= STDERR_LOG_LINES) return
    for (const l of text.split('\n')) {
      const clean = l.trim()
      if (clean === '' || this.#stderrLogged >= STDERR_LOG_LINES) continue
      this.#stderrLogged++
      this.#log({
        level: 'debug',
        message: `stderr: ${this.#redactor.redact(clean).slice(0, 500)}`,
      })
    }
  }
}
