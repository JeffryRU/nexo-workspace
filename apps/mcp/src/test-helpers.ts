import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { NexoClientError } from '@nexo/client'
import type {
  AgentSession,
  Block,
  EventName,
  MethodName,
  MethodParams,
  MethodResult,
  Workspace,
} from '@nexo/contracts'
import { DEFAULTS, type McpConfig } from './config.ts'
import { DaemonLink, type LinkClient } from './link.ts'
import { createNexoMcp, type NexoMcp } from './server.ts'

type Handler = (params: unknown) => unknown

/** Cliente del daemon falso: respuestas por método, llamadas registradas y eventos emitibles a mano. */
export class FakeClient implements LinkClient {
  readonly calls: { method: string; params: unknown }[] = []
  readonly handlers = new Map<string, Handler>()
  readonly #listeners = new Map<string, Set<(...args: never[]) => void>>()
  workspaces: Workspace[] = []
  sessions: AgentSession[] = []
  closed = false
  subscribed: EventName[] | undefined

  constructor() {
    this.handlers.set('workspace.list', () => ({ workspaces: this.workspaces }))
    this.handlers.set('agent.list', () => ({ sessions: this.sessions }))
  }

  on(event: string, handler: (...args: never[]) => void): () => void {
    let set = this.#listeners.get(event)
    if (set === undefined) {
      set = new Set()
      this.#listeners.set(event, set)
    }
    set.add(handler)
    return () => set.delete(handler)
  }

  emit(event: EventName, data: unknown): void {
    for (const h of [...(this.#listeners.get(event) ?? [])]) (h as (d: unknown) => void)(data)
  }

  emitState(state: string): void {
    for (const h of [...(this.#listeners.get('state') ?? [])]) (h as (s: string) => void)(state)
  }

  emitResync(): void {
    for (const h of [...(this.#listeners.get('resync') ?? [])]) (h as (i: unknown) => void)({})
  }

  listenerCount(event: string): number {
    return this.#listeners.get(event)?.size ?? 0
  }

  async subscribe(events?: EventName[]): Promise<MethodResult<'events.subscribe'>> {
    this.subscribed = events
    return { seq: 0 }
  }

  close(): void {
    this.closed = true
  }

  async call<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    this.calls.push({ method, params })
    const handler = this.handlers.get(method)
    if (handler === undefined) return {} as MethodResult<M>
    return handler(params) as MethodResult<M>
  }

  callsTo(method: string): unknown[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.params)
  }
}

export const clientError = (code: NexoClientError['code'], message: string = code) =>
  new NexoClientError(code, message)

export const WS_ID = 'ws-aaaa1111'
export const TAB_ID = 'tab-bbbb2222'
export const PANE_ID = 'pane-cccc3333'
export const TERM_ID = 'term-dddd4444'
export const SESSION_ID = 'agent-eeee5555'

export function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: WS_ID,
    name: 'proyecto',
    cwd: '/work/proyecto',
    activeTabId: TAB_ID,
    tabs: [
      {
        id: TAB_ID,
        title: 'servidor',
        layout: { type: 'leaf', paneId: PANE_ID },
        panes: [
          {
            id: PANE_ID,
            kind: 'terminal',
            title: 'bash',
            terminalId: TERM_ID,
            attention: 'idle',
          },
        ],
        focusedPaneId: PANE_ID,
      },
    ],
    ...over,
  } as unknown as Workspace
}

export function session(over: Record<string, unknown> = {}): AgentSession {
  return {
    id: SESSION_ID,
    provider: 'fake',
    paneId: 'pane-ffff6666',
    permissionMode: 'ask',
    cwd: '/work/proyecto',
    status: 'idle',
    turn: 0,
    blockCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as AgentSession
}

export function block(n: number, fields: Record<string, unknown>): Block {
  return {
    id: `blk-${String(n).padStart(8, '0')}`,
    index: n,
    turn: 1,
    seq: 0,
    createdAt: 1,
    ...fields,
  } as Block
}

export function config(over: Partial<McpConfig> = {}): McpConfig {
  return { write: false, allowPermissions: false, ...DEFAULTS, ...over }
}

export type Pair = {
  client: Client
  fake: FakeClient
  mcp: NexoMcp
  link: DaemonLink
  logs: string[]
  updates: string[]
  listChanges: { count: number }
  close(): Promise<void>
}

/** Servidor MCP real conectado en memoria a un `Client` del SDK, con el daemon falso detrás. */
export async function connectPair(
  options: {
    config?: Partial<McpConfig>
    connect?: () => Promise<LinkClient>
    flushMs?: number
    fake?: FakeClient
  } = {},
): Promise<Pair> {
  const fake = options.fake ?? new FakeClient()
  const logs: string[] = []
  const link = new DaemonLink({
    connect: options.connect ?? (async () => fake),
    logger: (m) => logs.push(m),
    failureCooldownMs: 0,
  })
  const mcp = createNexoMcp({
    link,
    config: config(options.config),
    logger: (m) => logs.push(m),
    flushMs: options.flushMs ?? 5,
  })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await mcp.server.connect(serverSide)
  const client = new Client({ name: 'prueba', version: '0.0.0' })
  const updates: string[] = []
  const listChanges = { count: 0 }
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
    updates.push(n.params.uri)
  })
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === 'notifications/resources/list_changed') listChanges.count++
  }
  await client.connect(clientSide)
  return {
    client,
    fake,
    mcp,
    link,
    logs,
    updates,
    listChanges,
    async close() {
      await client.close()
      await mcp.close()
    },
  }
}

export type Outcome = { error: boolean; text: string; structured?: Record<string, unknown> }

/** Llama a una herramienta y unifica «error de protocolo» y «resultado con isError». */
export async function callTool(
  pair: Pair,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Outcome> {
  try {
    const r = await pair.client.callTool({ name, arguments: args })
    const content = (r.content ?? []) as { type: string; text?: string }[]
    return {
      error: r.isError === true,
      text: content.map((c) => c.text ?? '').join('\n'),
      ...(r.structuredContent === undefined
        ? {}
        : { structured: r.structuredContent as Record<string, unknown> }),
    }
  } catch (error) {
    return { error: true, text: error instanceof Error ? error.message : String(error) }
  }
}

export async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error('tiempo agotado esperando una condición')
    await new Promise((r) => setTimeout(r, 5))
  }
}

export const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms))
