import { LIMITS, sanitizeBodyText } from '@nexo/contracts'
import {
  HistoryAssembler,
  HistoryError,
  type HistoryListRequest,
  type HistoryPort,
  type HistoryReadRequest,
  type HistorySessionInfo,
  type HistoryTranscript,
} from '@nexo/core'
import { RpcClosedError, RpcError, RpcTimeoutError } from '@nexo/jsonrpc'
import { z } from 'zod'
import type { CodexClient } from './client.ts'
import type { CodexCommand } from './resolve.ts'
import { line, truncateUtf8 } from './text.ts'
import { CodexTranslator } from './translator.ts'

/** Los ids de hilo de Codex son UUID: cualquier otra cosa no llega al servidor. */
export const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Orígenes que se listan: los interactivos (CLI, VS Code) y los abiertos desde un app-server (Nexo). */
export const HISTORY_SOURCE_KINDS = ['cli', 'vscode', 'appServer'] as const

const PAGE = 100
const MAX_PAGES = 20

const Thread = z.looseObject({
  id: z.string(),
  name: z.string().nullish(),
  preview: z.string().nullish(),
  cwd: z.string().nullish(),
  createdAt: z.number().nullish(),
  updatedAt: z.number().nullish(),
  turns: z.array(z.unknown()).nullish(),
})

const ThreadList = z.looseObject({
  data: z.array(z.unknown()),
  nextCursor: z.string().nullish(),
})

const ThreadRead = z.looseObject({
  thread: z.looseObject({ turns: z.array(z.unknown()).nullish() }),
})

const Turn = z.looseObject({ id: z.string(), items: z.array(z.unknown()).nullish() })

const secondsToMs = (s: number | null | undefined): number | undefined =>
  typeof s === 'number' && Number.isFinite(s) && s >= 0 && s < 1e11
    ? Math.trunc(s * 1000)
    : undefined

export type CodexHistoryDeps = {
  /** Resuelve el ejecutable (`codex`); `error` si no está instalado. */
  command(): CodexCommand | { error: string }
  /** Lanza un `codex app-server` nuevo (sin tocar la sesión del usuario ni abrir hilos). */
  client(command: CodexCommand, cwd: string): CodexClient
  requestTimeoutMs: number
  redact(text: string): string
}

/**
 * Historial de Codex con su API de app-server: `thread/list` (paginado por cursor, con filtro de carpeta) y
 * `thread/read` con `includeTurns`. Cada consulta lanza un `codex app-server` efímero (de ahí la caché del
 * servicio de historial) y lo cierra al terminar o al cancelarse. Los items se traducen con el mismo
 * `CodexTranslator` que las sesiones en vivo. No se lee ningún archivo de `~/.codex`.
 */
export class CodexHistory implements HistoryPort {
  readonly providerId = 'codex'
  readonly canRead = true
  readonly #deps: CodexHistoryDeps

  constructor(deps: CodexHistoryDeps) {
    this.#deps = deps
  }

  async list(request: HistoryListRequest): Promise<HistorySessionInfo[]> {
    return this.#withClient(request.signal, async (client) => {
      const out: HistorySessionInfo[] = []
      let cursor: string | undefined
      for (let page = 0; page < MAX_PAGES && out.length < request.limit; page++) {
        const res = await client.call(
          'thread/list',
          {
            limit: Math.min(PAGE, request.limit - out.length),
            archived: false,
            sortKey: 'updated_at',
            sortDirection: 'desc',
            sourceKinds: [...HISTORY_SOURCE_KINDS],
            ...(cursor === undefined ? {} : { cursor }),
            ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
          },
          ThreadList,
          this.#deps.requestTimeoutMs,
        )
        for (const item of res.data) {
          const t = Thread.safeParse(item)
          if (!t.success || !CODEX_THREAD_ID.test(t.data.id)) continue
          const updatedAt = secondsToMs(t.data.updatedAt) ?? secondsToMs(t.data.createdAt)
          if (updatedAt === undefined) continue
          const title = line(t.data.name ?? t.data.preview ?? '', LIMITS.maxTitleLength)
          const createdAt = secondsToMs(t.data.createdAt)
          out.push({
            sessionId: t.data.id,
            ...(title === '' ? {} : { title: this.#deps.redact(title) }),
            ...(t.data.cwd === null || t.data.cwd === undefined || t.data.cwd === ''
              ? {}
              : { cwd: t.data.cwd }),
            ...(createdAt === undefined ? {} : { createdAt }),
            updatedAt,
            resumable: true,
          })
          if (out.length >= request.limit) break
        }
        if (res.nextCursor === null || res.nextCursor === undefined || res.nextCursor === '') break
        cursor = res.nextCursor
      }
      return out
    })
  }

  async read(request: HistoryReadRequest): Promise<HistoryTranscript> {
    if (!CODEX_THREAD_ID.test(request.sessionId)) {
      throw new HistoryError('INVALID', 'ficha de sesión inválida')
    }
    return this.#withClient(request.signal, async (client) => {
      let res: z.infer<typeof ThreadRead>
      try {
        res = await client.call(
          'thread/read',
          { threadId: request.sessionId, includeTurns: true },
          ThreadRead,
          this.#deps.requestTimeoutMs,
        )
      } catch (error) {
        if (
          error instanceof RpcError &&
          /not found|no rollout|no such|unknown thread/i.test(error.message)
        ) {
          throw new HistoryError('NOT_FOUND', 'la sesión no existe')
        }
        throw error
      }
      return this.#translate(request.sessionId, res.thread.turns ?? [], request.maxBlocks)
    })
  }

  #translate(threadId: string, turns: readonly unknown[], maxBlocks: number): HistoryTranscript {
    const assembler = new HistoryAssembler({ maxBlocks })
    let n = 0
    const translator = new CodexTranslator({ nextRef: () => `h${++n}` })
    let cut = false
    for (const rawTurn of turns) {
      if (assembler.full) {
        cut = true
        break
      }
      const turn = Turn.safeParse(rawTurn)
      if (!turn.success) continue
      translator.beginTurn()
      translator.setTurnId(turn.data.id)
      for (const raw of turn.data.items ?? []) {
        if (assembler.full) {
          cut = true
          break
        }
        const item = raw as { type?: unknown; id?: unknown; content?: unknown }
        if (typeof item !== 'object' || item === null) continue
        if (item.type === 'userMessage') {
          const text = userText(item.content)
          if (text !== undefined) {
            assembler.startTurn()
            const clean = truncateUtf8(sanitizeBodyText(text), LIMITS.maxBlockTextBytes)
            if (clean.text !== '') assembler.add({ type: 'user', text: clean.text })
          }
          continue
        }
        for (const e of translator.notification('item/completed', {
          threadId,
          turnId: turn.data.id,
          item: raw,
        })) {
          assembler.push(e)
        }
      }
      for (const e of translator.end('end-turn')) assembler.push(e)
    }
    return { blocks: assembler.blocks(), truncated: cut || assembler.truncated }
  }

  async #withClient<T>(
    signal: HistoryListRequest['signal'],
    run: (client: CodexClient) => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) throw new HistoryError('ABORTED', 'cancelado')
    const command = this.#deps.command()
    if ('error' in command) {
      throw new HistoryError('UNAVAILABLE', `No se encontró Codex: ${line(command.error, 200)}`)
    }
    const client = this.#deps.client(command, process.cwd())
    const onAbort = () => client.close(200)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await client.handshake()
      return await run(client)
    } catch (error) {
      if (signal?.aborted) throw new HistoryError('ABORTED', 'cancelado')
      throw this.#fail(error, client)
    } finally {
      signal?.removeEventListener('abort', onAbort)
      client.close(500)
    }
  }

  #fail(error: unknown, client: CodexClient): HistoryError {
    if (error instanceof HistoryError) return error
    const tail = client.stderrTail()
    if (error instanceof RpcTimeoutError) {
      return new HistoryError('UNAVAILABLE', 'Codex no respondió a tiempo', { cause: error })
    }
    if (error instanceof RpcClosedError || error instanceof RpcError) {
      return new HistoryError(
        'UNAVAILABLE',
        line(
          `Codex no pudo consultar su historial${tail === '' ? '' : `: ${this.#deps.redact(tail).slice(-200)}`}`,
          300,
        ),
        { cause: error },
      )
    }
    return new HistoryError('UNAVAILABLE', 'Codex devolvió una respuesta que no se pudo usar', {
      cause: error,
    })
  }
}

/** Texto que escribió el usuario en un `userMessage` (`content` son entradas `{ type: 'text', text }` e imágenes). */
function userText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue
    const p = part as { type?: unknown; text?: unknown }
    if (p.type === 'text' && typeof p.text === 'string' && p.text.trim() !== '') parts.push(p.text)
  }
  return parts.length === 0 ? undefined : parts.join('\n\n')
}
