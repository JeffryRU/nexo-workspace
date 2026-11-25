import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ProviderEvent, ProviderEvent as ProviderEventSchema } from '@nexo/contracts'
import { ClaudeTranslator, type TranslatorOptions } from '../src/translator.ts'
import {
  type ClaudeTransport,
  type ClaudeTransportSession,
  type PermissionAsk,
  type PermissionDecision,
  TransportError,
  type TransportStartOptions,
} from '../src/transport.ts'

export function fixture(name: string): unknown[] {
  const text = readFileSync(join(import.meta.dirname, 'fixtures', `${name}.jsonl`), 'utf8')
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as unknown)
}

/** Pasa los mensajes por un traductor nuevo con un turno abierto; comprueba que todo evento sea válido. */
export function translateAll(
  messages: readonly unknown[],
  options: TranslatorOptions = {},
): { events: ProviderEvent[]; translator: ClaudeTranslator } {
  const translator = new ClaudeTranslator(options)
  translator.beginTurn()
  const events: ProviderEvent[] = []
  for (const m of messages) events.push(...translator.translate(m))
  for (const e of events) {
    const r = ProviderEventSchema.safeParse(e)
    if (!r.success) throw new Error(`evento inválido ${JSON.stringify(e)}: ${r.error.message}`)
  }
  return { events, translator }
}

export const types = (events: readonly ProviderEvent[]) => events.map((e) => e.type)

/** Cola asíncrona que hace de flujo de mensajes del SDK. */
class Channel implements AsyncIterable<unknown> {
  readonly #items: unknown[] = []
  #wake: (() => void) | undefined
  #ended = false
  #error: { value: unknown } | undefined

  push(item: unknown): void {
    this.#items.push(item)
    this.#wake?.()
  }
  end(): void {
    this.#ended = true
    this.#wake?.()
  }
  fail(error: unknown): void {
    this.#error = { value: error }
    this.#wake?.()
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    while (true) {
      const item = this.#items.shift()
      if (item !== undefined || this.#items.length > 0) {
        yield item
      } else if (this.#error !== undefined) {
        throw this.#error.value
      } else if (this.#ended) {
        return
      } else {
        await new Promise<void>((resolve) => (this.#wake = resolve))
      }
    }
  }
}

export const SESSION_UUID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

export const text = (id: string, content: string) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { id, content: [{ type: 'text', text: content }] },
})
export const result = (extra: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 5,
  num_turns: 1,
  result: 'ok',
  stop_reason: 'end_turn',
  total_cost_usd: 0.01,
  usage: { input_tokens: 1, output_tokens: 2 },
  ...extra,
})
export const streamText = (delta: string, index = 0) => ({
  type: 'stream_event',
  parent_tool_use_id: null,
  event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: delta } },
})
export const streamStart = (type: 'text' | 'thinking' = 'text', index = 0) => ({
  type: 'stream_event',
  parent_tool_use_id: null,
  event: {
    type: 'content_block_start',
    index,
    content_block:
      type === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' },
  },
})
export const streamStop = (index = 0) => ({
  type: 'stream_event',
  parent_tool_use_id: null,
  event: { type: 'content_block_stop', index },
})
export const messageStart = (id = 'msg_x') => ({
  type: 'stream_event',
  parent_tool_use_id: null,
  event: { type: 'message_start', message: { id } },
})
export const toolUse = (id: string, name: string, input: unknown) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { id: `m_${id}`, content: [{ type: 'tool_use', id, name, input }] },
})
export const toolResult = (id: string, content: unknown, isError = false) => ({
  type: 'user',
  parent_tool_use_id: null,
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
  },
})

export class FakeSdkSession implements ClaudeTransportSession {
  readonly sessionId: string
  readonly messages: AsyncIterable<unknown>
  readonly sent: string[] = []
  interrupts = 0
  closed = false
  /** El turno en curso aún no recibió su `result`. */
  turnOpen = false
  readonly #channel = new Channel()
  /** Respuesta al interrumpir; por omisión, cierra el turno con `error_during_execution`. */
  onInterrupt: (() => Promise<void>) | undefined
  onSend: ((text: string) => void) | undefined

  constructor(
    readonly options: TransportStartOptions,
    sessionId: string,
  ) {
    this.sessionId = sessionId
    this.messages = this.#channel
  }

  emit(...messages: unknown[]): void {
    for (const m of messages) this.#channel.push(m)
  }
  end(): void {
    this.#channel.end()
  }
  fail(error: unknown): void {
    this.#channel.fail(error)
  }
  /** Emite el `result` del turno una sola vez. */
  finish(extra: Record<string, unknown> = {}): void {
    if (!this.turnOpen) return
    this.turnOpen = false
    this.emit(result(extra))
  }
  ask(ask: Partial<PermissionAsk> & { toolName: string }): Promise<PermissionDecision> {
    return this.options.canUseTool({
      input: {},
      toolUseId: `tu_${randomUUID().slice(0, 8)}`,
      signal: new AbortController().signal,
      ...ask,
    })
  }

  send(textToSend: string): void {
    if (this.closed) throw new Error('entrada cerrada')
    this.sent.push(textToSend)
    this.turnOpen = true
    this.onSend?.(textToSend)
  }

  async interrupt(): Promise<void> {
    this.interrupts++
    if (this.onInterrupt !== undefined) return this.onInterrupt()
    if (this.turnOpen) {
      this.turnOpen = false
      this.emit({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        duration_ms: 1,
        num_turns: 1,
        errors: ['aborted'],
        total_cost_usd: 0.01,
        usage: {},
      })
    }
  }

  close(): void {
    this.closed = true
    this.#channel.end()
  }
}

/** Guion por mensaje de usuario: las pruebas lo cambian según el caso. */
export type FakeScript = (text: string, session: FakeSdkSession) => void

export const defaultScript: FakeScript = (prompt, session) => {
  if (prompt === 'long') {
    session.emit(messageStart('m_long'), streamStart(), streamText('empiezo...'))
    return
  }
  if (prompt === 'permission') {
    session.emit(toolUse('tool_perm', 'Bash', { command: 'ls' }))
    void session
      .ask({ toolName: 'Bash', input: { command: 'ls' }, toolUseId: 'tool_perm' })
      .then((d) => {
        if (!session.turnOpen) return
        session.emit(
          toolResult(
            'tool_perm',
            d.behavior === 'allow' ? 'a.ts' : 'rechazado',
            d.behavior !== 'allow',
          ),
        )
        session.finish()
      })
    return
  }
  session.emit(
    messageStart('m_simple'),
    streamStart(),
    streamText('Hola'),
    streamText(' mundo'),
    streamStop(),
  )
  session.finish()
}

export class FakeTransport implements ClaudeTransport {
  readonly sessions: FakeSdkSession[] = []
  readonly known = new Set<string>()
  available = true
  script: FakeScript = defaultScript
  startError: unknown
  warmed: string[] = []
  models: { id: string; label?: string; efforts?: string[] }[] | undefined
  modelCalls = 0

  isAvailable(): Promise<boolean> {
    return Promise.resolve(this.available)
  }

  start(options: TransportStartOptions): Promise<ClaudeTransportSession> {
    if (this.startError !== undefined) return Promise.reject(this.startError)
    if (options.resume !== undefined && !this.known.has(options.resume)) {
      return Promise.reject(new TransportError('UNKNOWN_SESSION', 'no existe'))
    }
    const id = options.resume ?? randomUUID()
    this.known.add(id)
    const session = new FakeSdkSession(options, id)
    session.onSend = (t) => this.script(t, session)
    this.sessions.push(session)
    return Promise.resolve(session)
  }

  warmUp({ cwd }: { cwd: string }): Promise<void> {
    this.warmed.push(cwd)
    return Promise.resolve()
  }

  listModels(): Promise<{ id: string; label?: string; efforts?: string[] }[]> {
    this.modelCalls++
    if (this.models === undefined) return Promise.reject(new Error('sin modelos'))
    return Promise.resolve(this.models)
  }

  get last(): FakeSdkSession {
    const s = this.sessions[this.sessions.length - 1]
    if (s === undefined) throw new Error('sin sesión')
    return s
  }
}

export function tempDir(): { path: string; remove: () => void } {
  const path = mkdtempSync(join(tmpdir(), 'nexo-claude-'))
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) }
}
