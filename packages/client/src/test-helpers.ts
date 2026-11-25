import { type AgentSession, AgentSessionId, type Block, BlockId, PaneId } from '@nexo/contracts'
import type { Transport } from './transport.ts'

export type Request = { v: 1; id: string; method: string; params: unknown }
export type Reply = { result: unknown } | { error: { code: string; message: string } } | 'silent'

/** Transporte falso: el servidor de la prueba ve lo enviado y empuja mensajes. */
export class FakeTransport implements Transport {
  readonly sent: Request[] = []
  token: string | undefined
  authMode: 'subprotocol' | 'message' | undefined
  closed = false
  #onMessage: (text: string) => void = () => {}
  #onClose: (info: { code?: number; reason?: string }) => void = () => {}
  readonly #server: FakeServer

  constructor(server: FakeServer) {
    this.#server = server
    this.token = server.token
    this.authMode = server.authMode
  }

  async connect(): Promise<void> {
    if (this.#server.connectGate !== undefined) await this.#server.connectGate
    if (this.#server.failConnects > 0) {
      this.#server.failConnects--
      throw new Error('conexión rechazada')
    }
  }

  send(text: string): void {
    if (this.closed) throw new Error('cerrado')
    const request = JSON.parse(text) as Request
    this.sent.push(request)
    const reply = this.#server.handler(request, this) ?? defaultHandler(request)
    if (reply === 'silent') return
    if ('error' in reply) this.push({ v: 1, id: request.id, ok: false, error: reply.error })
    else this.push({ v: 1, id: request.id, ok: true, result: reply.result })
  }

  close(): void {
    this.closed = true
  }

  onMessage(handler: (text: string) => void): void {
    this.#onMessage = handler
  }

  onClose(handler: (info: { code?: number; reason?: string }) => void): void {
    this.#onClose = handler
  }

  push(message: unknown): void {
    this.#onMessage(typeof message === 'string' ? message : JSON.stringify(message))
  }

  pushEvent(event: string, seq: number, data: unknown): void {
    this.push({ v: 1, event, seq, data })
  }

  /** El servidor corta la conexión. */
  drop(code = 1006): void {
    this.closed = true
    this.#onClose({ code })
  }
}

export const EMPTY_SNAPSHOT = { seq: 0, workspaces: [] }

export function defaultHandler(request: Request): Reply {
  switch (request.method) {
    case 'auth':
      return { result: {} }
    case 'events.subscribe':
      return { result: { seq: 0 } }
    case 'snapshot':
      return { result: EMPTY_SNAPSHOT }
    case 'daemon.info':
      return {
        result: { version: '0', protocol: 1, pid: 1, startedAt: '2026-01-01T00:00:00.000Z' },
      }
    default:
      return { result: {} }
  }
}

export class FakeServer {
  readonly transports: FakeTransport[] = []
  handler: (request: Request, transport: FakeTransport) => Reply | undefined = defaultHandler
  failConnects = 0
  connectGate: Promise<void> | undefined
  token: string | undefined
  authMode: 'subprotocol' | 'message' | undefined

  readonly factory = (): FakeTransport => {
    const transport = new FakeTransport(this)
    this.transports.push(transport)
    return transport
  }

  get last(): FakeTransport {
    const t = this.transports.at(-1)
    if (t === undefined) throw new Error('sin transportes')
    return t
  }
}

export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export const SID = AgentSessionId.parse('agent-session-00000001')

export const session = (over: Partial<AgentSession> = {}): AgentSession => ({
  id: SID,
  provider: 'fake',
  paneId: PaneId.parse('pane-00000001'),
  permissionMode: 'ask',
  cwd: '/w',
  status: 'idle',
  turn: 1,
  blockCount: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

export function textBlock(n: number, text = '', over: Record<string, unknown> = {}): Block {
  return {
    id: BlockId.parse(`block-${String(n).padStart(8, '0')}`),
    index: n,
    turn: 1,
    seq: 0,
    createdAt: 1,
    type: 'text',
    text,
    complete: false,
    ...over,
  } as Block
}

/** Servidor falso de `agent.snapshot` con páginas de `pageLen` bloques. */
export function snapshotServer(server: FakeServer, blocks: () => Block[], pageLen = 2): Request[] {
  const requests: Request[] = []
  server.handler = (req): Reply | undefined => {
    if (req.method !== 'agent.snapshot') return undefined
    requests.push(req)
    const p = req.params as { fromIndex?: number }
    const from = p.fromIndex ?? 0
    const all = blocks().filter((b) => b.index >= from)
    const page = all.slice(0, pageLen)
    const next = all.length > pageLen ? (all[pageLen]?.index ?? null) : null
    return {
      result: { session: session({ blockCount: blocks().length }), blocks: page, nextIndex: next },
    }
  }
  return requests
}
