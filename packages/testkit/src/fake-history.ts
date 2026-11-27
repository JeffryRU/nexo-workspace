import { type BlockDraft, ProviderSessionToken } from '@nexo/contracts'
import {
  HistoryError,
  type HistoryListRequest,
  type HistoryPort,
  type HistoryReadRequest,
  type HistorySessionInfo,
  type HistoryTranscript,
  normalizeProjectPath,
} from '@nexo/core'

export type FakeHistoryMessage = { role: 'user' | 'assistant'; text: string }

type Stored = { info: HistorySessionInfo; blocks: { turn: number; block: BlockDraft }[] }

/** Bloques de una conversación sencilla: cada mensaje del usuario abre un turno. */
export function messagesToBlocks(
  messages: readonly FakeHistoryMessage[],
): { turn: number; block: BlockDraft }[] {
  const out: { turn: number; block: BlockDraft }[] = []
  let turn = 0
  for (const m of messages) {
    if (m.role === 'user') {
      turn++
      out.push({ turn, block: { type: 'user', text: m.text } })
    } else {
      out.push({ turn: Math.max(1, turn), block: { type: 'text', text: m.text, complete: true } })
    }
  }
  return out
}

/**
 * Falso en memoria de `HistoryPort`. Guarda sesiones sembradas con `add`; cuenta las llamadas y puede
 * «colgarse» (`hang`) o tardar (`delayMs`) para probar plazos y cancelación. Cumple la suite de conformidad.
 */
export class FakeHistory implements HistoryPort {
  readonly providerId: string
  readonly canRead: boolean
  readonly sessions = new Map<string, Stored>()
  readonly calls = { list: 0, read: 0 }
  /** Si es `true`, `list` y `read` no responden hasta que se cancela la señal. */
  hang = false
  /** Si está, `list` y `read` rechazan con ese error. */
  failWith: Error | undefined
  #n = 0

  constructor(providerId = 'fake', options: { canRead?: boolean } = {}) {
    this.providerId = providerId
    this.canRead = options.canRead ?? true
  }

  /** Siembra una sesión; devuelve su ficha. */
  add(
    session: {
      sessionId?: string
      cwd?: string
      title?: string
      updatedAt?: number
      createdAt?: number
      resumable?: boolean
      messages?: readonly FakeHistoryMessage[]
      blocks?: { turn: number; block: BlockDraft }[]
    } = {},
  ): string {
    const sessionId = session.sessionId ?? `${this.providerId}-hist-${++this.#n}`
    const blocks = session.blocks ?? messagesToBlocks(session.messages ?? [])
    this.sessions.set(sessionId, {
      info: {
        sessionId,
        ...(session.title === undefined ? {} : { title: session.title }),
        ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
        ...(session.createdAt === undefined ? {} : { createdAt: session.createdAt }),
        updatedAt: session.updatedAt ?? 1_000 + this.#n,
        messageCount: blocks.filter((b) => b.block.type === 'user').length,
        resumable: session.resumable ?? true,
      },
      blocks,
    })
    return sessionId
  }

  async list(request: HistoryListRequest): Promise<HistorySessionInfo[]> {
    this.calls.list++
    await this.#gate(request.signal)
    const key = request.cwd === undefined ? undefined : normalizeProjectPath(request.cwd)
    return [...this.sessions.values()]
      .map((s) => s.info)
      .filter(
        (i) => key === undefined || (i.cwd !== undefined && normalizeProjectPath(i.cwd) === key),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(0, request.limit))
  }

  async read(request: HistoryReadRequest): Promise<HistoryTranscript> {
    this.calls.read++
    if (!this.canRead) throw new HistoryError('UNSUPPORTED', 'este proveedor solo lista')
    if (!ProviderSessionToken.safeParse(request.sessionId).success) {
      throw new HistoryError('INVALID', 'ficha de sesión inválida')
    }
    await this.#gate(request.signal)
    const stored = this.sessions.get(request.sessionId)
    if (stored === undefined) throw new HistoryError('NOT_FOUND', 'la sesión no existe')
    const max = Math.max(0, request.maxBlocks)
    return { blocks: stored.blocks.slice(0, max), truncated: stored.blocks.length > max }
  }

  async #gate(signal: HistoryListRequest['signal']): Promise<void> {
    if (signal?.aborted) throw new HistoryError('ABORTED', 'cancelado')
    if (this.failWith !== undefined) throw this.failWith
    if (!this.hang) return
    await new Promise<void>((_, reject) => {
      if (signal === undefined) return
      signal.addEventListener('abort', () => reject(new HistoryError('ABORTED', 'cancelado')), {
        once: true,
      })
    })
  }
}
