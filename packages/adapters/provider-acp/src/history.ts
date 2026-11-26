import { LIMITS } from '@nexo/contracts'
import {
  HistoryError,
  type HistoryListRequest,
  type HistoryPort,
  type HistoryReadRequest,
  type HistorySessionInfo,
  type HistoryTranscript,
} from '@nexo/core'
import { RpcClosedError, RpcError, RpcTimeoutError } from '@nexo/jsonrpc'
import type { AcpClient } from './client.ts'
import { SessionListResult, SessionSummary } from './protocol.ts'
import type { AgentCommand } from './resolve.ts'
import { line } from './text.ts'

const MAX_PAGES = 20

export type AcpHistoryDeps = {
  /** Id del proveedor (`gemini`...). */
  id: string
  displayName: string
  command(): AgentCommand | { error: string }
  client(command: AgentCommand, cwd: string): AcpClient
  requestTimeoutMs: number
  redact(text: string): string
}

/** `updatedAt` es RFC 3339; lo que no se puede leer como fecha se descarta. */
function parseTime(value: string | null | undefined): number | undefined {
  if (value === undefined || value === null) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) && ms >= 0 && ms < 1e14 ? Math.trunc(ms) : undefined
}

/**
 * Historial de un agente ACP: solo `session/list`, y solo si el agente lo anuncia en
 * `agentCapabilities.sessionCapabilities.list` al inicializar (sin anuncio, `UNSUPPORTED`: no se adivina ni se
 * leen archivos del agente). Leer la transcripción exigiría `session/load` (el agente reproduce el historial
 * con notificaciones y deja la sesión cargada), así que por ahora `read` es `UNSUPPORTED`: una sesión de la
 * lista se reanuda con `agent.create { resume }` si el agente anuncia `loadSession`.
 */
export class AcpHistory implements HistoryPort {
  readonly providerId: string
  readonly canRead = false
  readonly #deps: AcpHistoryDeps

  constructor(deps: AcpHistoryDeps) {
    this.#deps = deps
    this.providerId = deps.id
  }

  async list(request: HistoryListRequest): Promise<HistorySessionInfo[]> {
    const { signal } = request
    if (signal?.aborted) throw new HistoryError('ABORTED', 'cancelado')
    const command = this.#deps.command()
    if ('error' in command) {
      throw new HistoryError(
        'UNAVAILABLE',
        `No se encontró ${this.#deps.displayName}: ${line(command.error, 200)}`,
      )
    }
    const client = this.#deps.client(command, process.cwd())
    const onAbort = () => client.close(200)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const init = await client.handshake(this.#deps.requestTimeoutMs)
      const caps = init.agentCapabilities?.sessionCapabilities
      if (caps === null || caps === undefined || caps.list === undefined || caps.list === null) {
        throw new HistoryError(
          'UNSUPPORTED',
          `${this.#deps.displayName} no anuncia «session/list»: no tiene historial`,
        )
      }
      const resumable = init.agentCapabilities?.loadSession === true
      const out: HistorySessionInfo[] = []
      let cursor: string | undefined
      for (let page = 0; page < MAX_PAGES && out.length < request.limit; page++) {
        const res = await client.call(
          'session/list',
          {
            ...(cursor === undefined ? {} : { cursor }),
            ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
          },
          SessionListResult,
          this.#deps.requestTimeoutMs,
        )
        for (const item of res.sessions) {
          const s = SessionSummary.safeParse(item)
          if (!s.success) continue
          const updatedAt = parseTime(s.data.updatedAt)
          if (updatedAt === undefined) continue
          const title = line(s.data.title ?? '', LIMITS.maxTitleLength)
          out.push({
            sessionId: s.data.sessionId,
            ...(title === '' ? {} : { title: this.#deps.redact(title) }),
            ...(s.data.cwd === '' ? {} : { cwd: s.data.cwd }),
            updatedAt,
            resumable,
          })
          if (out.length >= request.limit) break
        }
        if (res.nextCursor === null || res.nextCursor === undefined || res.nextCursor === '') break
        cursor = res.nextCursor
      }
      return out
    } catch (error) {
      if (signal?.aborted) throw new HistoryError('ABORTED', 'cancelado')
      throw this.#fail(error, client)
    } finally {
      signal?.removeEventListener('abort', onAbort)
      client.close(500)
    }
  }

  async read(_request: HistoryReadRequest): Promise<HistoryTranscript> {
    throw new HistoryError(
      'UNSUPPORTED',
      `${this.#deps.displayName}: leer la transcripción por ACP exige cargar la sesión; solo se lista`,
    )
  }

  #fail(error: unknown, client: AcpClient): HistoryError {
    if (error instanceof HistoryError) return error
    if (error instanceof RpcTimeoutError) {
      return new HistoryError('UNAVAILABLE', `${this.#deps.displayName} no respondió a tiempo`, {
        cause: error,
      })
    }
    if (error instanceof RpcClosedError || error instanceof RpcError) {
      const tail = this.#deps.redact(client.stderrTail()).slice(-200)
      return new HistoryError(
        'UNAVAILABLE',
        line(
          `${this.#deps.displayName} no pudo listar sus sesiones${tail === '' ? '' : `: ${tail}`}`,
          300,
        ),
        { cause: error },
      )
    }
    return new HistoryError(
      'UNAVAILABLE',
      `${this.#deps.displayName} devolvió una respuesta que no se pudo usar`,
      { cause: error },
    )
  }
}
