import { LIMITS } from '@nexo/contracts'
import {
  HistoryAssembler,
  HistoryError,
  type HistoryListRequest,
  type HistoryPort,
  type HistoryReadRequest,
  type HistorySessionInfo,
  type HistoryTranscript,
} from '@nexo/core'
import { z } from 'zod'
import { body, line } from './text.ts'
import { ClaudeTranslator } from './translator.ts'
import { type ClaudeTransport, TransportError } from './transport.ts'

/** Las fichas de Claude Code son UUID: cualquier otra cosa no llega al SDK. */
export const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Mensajes de una transcripción que se piden al SDK como máximo (cada uno da uno o varios bloques). */
const MAX_MESSAGES = 20_000

/** Forma mínima de `SDKSessionInfo` (el SDK añade campos: se ignoran). */
const SessionInfo = z.looseObject({
  sessionId: z.string(),
  summary: z.string().optional(),
  customTitle: z.string().optional(),
  firstPrompt: z.string().optional(),
  cwd: z.string().optional(),
  lastModified: z.number(),
  createdAt: z.number().optional(),
})

const Message = z.looseObject({
  type: z.string(),
  message: z.unknown(),
  parent_tool_use_id: z.string().nullable().optional(),
})

const isMillis = (n: number | undefined): n is number =>
  n !== undefined && Number.isSafeInteger(Math.trunc(n)) && n >= 0

/**
 * Historial de Claude Code con la API del propio SDK (`listSessions` y `getSessionMessages`): Nexo no abre
 * ni interpreta los archivos de sesión de `~/.claude`, los lee el SDK. La transcripción se traduce con el
 * mismo `ClaudeTranslator` que las sesiones en vivo.
 */
export class ClaudeHistory implements HistoryPort {
  readonly providerId = 'claude'
  readonly canRead = true
  readonly #transport: ClaudeTransport
  readonly #scrub: (text: string) => string
  readonly #redact: (text: string) => string

  constructor(options: {
    transport: ClaudeTransport
    scrub?: (text: string) => string
    redact?: (text: string) => string
  }) {
    this.#transport = options.transport
    this.#scrub = options.scrub ?? ((t) => t)
    this.#redact = options.redact ?? ((t) => t)
  }

  async list(request: HistoryListRequest): Promise<HistorySessionInfo[]> {
    if (request.signal?.aborted) throw new HistoryError('ABORTED', 'cancelado')
    const list = this.#transport.listSessions?.bind(this.#transport)
    if (list === undefined) throw new HistoryError('UNSUPPORTED', 'Claude Code no lista sesiones')
    let raw: unknown[]
    try {
      raw = await list({
        limit: request.limit,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      })
    } catch (error) {
      throw this.#fail(error)
    }
    if (request.signal?.aborted) throw new HistoryError('ABORTED', 'cancelado')
    const out: HistorySessionInfo[] = []
    for (const item of Array.isArray(raw) ? raw : []) {
      const p = SessionInfo.safeParse(item)
      if (
        !p.success ||
        !CLAUDE_SESSION_ID.test(p.data.sessionId) ||
        !isMillis(p.data.lastModified)
      ) {
        continue
      }
      const title = line(
        p.data.customTitle ?? p.data.summary ?? p.data.firstPrompt ?? '',
        LIMITS.maxTitleLength,
      )
      out.push({
        sessionId: p.data.sessionId,
        ...(title === '' ? {} : { title: this.#redact(title) }),
        ...(p.data.cwd === undefined || p.data.cwd === '' ? {} : { cwd: p.data.cwd }),
        ...(isMillis(p.data.createdAt) ? { createdAt: Math.trunc(p.data.createdAt) } : {}),
        updatedAt: Math.trunc(p.data.lastModified),
        resumable: true,
      })
      if (out.length >= request.limit) break
    }
    return out
  }

  async read(request: HistoryReadRequest): Promise<HistoryTranscript> {
    if (!CLAUDE_SESSION_ID.test(request.sessionId)) {
      throw new HistoryError('INVALID', 'ficha de sesión inválida')
    }
    if (request.signal?.aborted) throw new HistoryError('ABORTED', 'cancelado')
    const readSession = this.#transport.readSession?.bind(this.#transport)
    if (readSession === undefined)
      throw new HistoryError('UNSUPPORTED', 'Claude Code no lee sesiones')
    let result: { exists: boolean; messages: unknown[] }
    try {
      result = await readSession({
        sessionId: request.sessionId,
        maxMessages: MAX_MESSAGES,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      })
    } catch (error) {
      throw this.#fail(error)
    }
    if (request.signal?.aborted) throw new HistoryError('ABORTED', 'cancelado')
    if (!result.exists) throw new HistoryError('NOT_FOUND', 'la sesión no existe')
    return this.#translate(Array.isArray(result.messages) ? result.messages : [], request.maxBlocks)
  }

  #translate(messages: readonly unknown[], maxBlocks: number): HistoryTranscript {
    const assembler = new HistoryAssembler({ maxBlocks })
    const translator = new ClaudeTranslator({ scrub: this.#scrub, redact: this.#redact })
    translator.beginTurn()
    let cut = false
    for (const raw of messages) {
      if (assembler.full) {
        cut = true
        break
      }
      const m = Message.safeParse(raw)
      if (!m.success) continue
      if (m.data.type === 'user') {
        const text = userText(m.data.message)
        if ((m.data.parent_tool_use_id ?? null) === null && text !== undefined) {
          assembler.startTurn()
          const clean = body(this.#scrub(text), LIMITS.maxBlockTextBytes)
          if (clean.text !== '') assembler.add({ type: 'user', text: clean.text })
          continue
        }
      }
      if (m.data.type !== 'user' && m.data.type !== 'assistant') continue
      for (const event of translator.translate(raw)) assembler.push(event)
    }
    for (const event of translator.closeForDeath()) assembler.push(event)
    return { blocks: assembler.blocks(), truncated: cut || assembler.truncated }
  }

  #fail(error: unknown): HistoryError {
    if (error instanceof HistoryError) return error
    if (error instanceof TransportError) {
      return new HistoryError('UNAVAILABLE', 'Claude Code no está disponible', { cause: error })
    }
    return new HistoryError('UNAVAILABLE', 'no se pudo consultar el historial de Claude Code', {
      cause: error,
    })
  }
}

/** Texto que escribió el usuario en un mensaje `user` (no los `tool_result`); `undefined` si no hay. */
function userText(message: unknown): string | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content.trim() === '' ? undefined : content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue
    const p = part as { type?: unknown; text?: unknown }
    if (p.type === 'text' && typeof p.text === 'string' && p.text.trim() !== '') parts.push(p.text)
  }
  return parts.length === 0 ? undefined : parts.join('\n\n')
}
