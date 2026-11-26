import {
  type IncomingNotification,
  type IncomingRequest,
  JsonRpcConnection,
  type ProtocolIssue,
  RpcError,
  type Timers,
} from '@nexo/jsonrpc'
import type { z } from 'zod'
import type { AgentLauncher, AgentProcess, ExitInfo } from './process.ts'
import { ACP_PROTOCOL_VERSION, InitializeResult } from './protocol.ts'
import type { SecretRedactor } from './redact.ts'
import type { AgentCommand } from './resolve.ts'

export type LogEntry = { level: 'debug' | 'info' | 'warn' | 'error'; message: string }

export const nodeTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** El agente habla otra versión del protocolo: no se puede seguir. */
export class AcpVersionError extends Error {
  constructor(readonly agentVersion: number) {
    super(
      `el agente usa la versión ${agentVersion} del protocolo ACP y Nexo solo habla la ${ACP_PROTOCOL_VERSION}`,
    )
    this.name = 'AcpVersionError'
  }
}

export type ClientOptions = {
  launcher: AgentLauncher
  command: AgentCommand
  cwd: string
  env: Readonly<Record<string, string | undefined>>
  log: (entry: LogEntry) => void
  redactor: SecretRedactor
  requestTimeoutMs: number
  maxLineLength: number
  clientVersion: string
  /** Texto para los mensajes («Gemini», «el agente»). */
  label: string
}

const STDERR_TAIL = 4096
const STDERR_LOG_LINES = 100

/**
 * Un proceso de agente ACP con su conexión JSON-RPC 2.0 (`@nexo/jsonrpc`). Une las tres capas de E/S: proceso →
 * texto → conexión; guarda el final de stderr para diagnóstico (redactado) y expone cuándo termina el proceso.
 */
export class AcpClient {
  readonly #process: AgentProcess
  readonly #conn: JsonRpcConnection
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
  /** Resultado de `initialize` (tras `handshake`). */
  initialized: InitializeResult | undefined

  constructor(options: ClientOptions) {
    this.#o = options
    this.#process = options.launcher({
      command: options.command,
      cwd: options.cwd,
      env: options.env,
    })
    this.#conn = new JsonRpcConnection({
      write: (line) => this.#process.write(line),
      timers: nodeTimers,
      version: '2.0',
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
              ? `${options.label} terminó (código ${info.exitCode ?? 'ninguno'}${info.signal === null ? '' : `, señal ${info.signal}`})`
              : `no se pudo lanzar ${options.label}: ${info.error.message}`,
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
    return this.#o.redactor.redact(this.#stderr).trim()
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

  /** Solicitud con su resultado validado por `schema`; `timeoutMs` 0 = sin plazo. */
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
    const parsed = schema.safeParse(result ?? {})
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

  /**
   * `initialize`: versión del protocolo y capacidades. Las del cliente van en falso: Nexo no ofrece `fs` ni
   * `terminal` (ni autenticación) al agente. Una versión distinta de la 1 es un error (`AcpVersionError`).
   */
  async handshake(timeoutMs?: number): Promise<InitializeResult> {
    let result: InitializeResult
    try {
      result = await this.call(
        'initialize',
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: {
            name: 'nexo-workspace',
            title: 'Nexo Workspace',
            version: this.#o.clientVersion,
          },
        },
        InitializeResult,
        timeoutMs,
      )
    } catch (error) {
      // Un agente solo-v2 rechaza la versión pedida con -32022 (versión no soportada).
      if (error instanceof RpcError && error.code === -32022) {
        throw new Error(
          `${this.#o.label} no soporta la versión ${ACP_PROTOCOL_VERSION} del protocolo ACP (${error.message})`,
        )
      }
      throw error
    }
    if (result.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new AcpVersionError(result.protocolVersion)
    }
    this.initialized = result
    return result
  }

  close(graceMs?: number): void {
    this.#conn.close(new Error('sesión cerrada'))
    this.#process.kill(graceMs)
  }

  #onIssue(issue: ProtocolIssue): void {
    this.#o.log({
      level: issue.kind === 'unknown-response' ? 'debug' : 'warn',
      message: `JSON-RPC de ${this.#o.label}: ${issue.kind} (${this.#o.redactor.redact(issue.detail).slice(0, 200)})`,
    })
  }

  #onStderr(text: string): void {
    this.#stderr = (this.#stderr + text).slice(-STDERR_TAIL)
    if (this.#stderrLogged >= STDERR_LOG_LINES) return
    for (const l of text.split('\n')) {
      const clean = l.trim()
      if (clean === '' || this.#stderrLogged >= STDERR_LOG_LINES) continue
      this.#stderrLogged++
      this.#o.log({
        level: 'debug',
        message: `stderr: ${this.#o.redactor.redact(clean).slice(0, 500)}`,
      })
    }
  }
}
