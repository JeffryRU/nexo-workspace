import {
  type AgentSession,
  AgentSessionId,
  type Block,
  BlockId,
  type ProviderInfo,
} from '@nexo/contracts'
import { mountApp } from '../test-app.tsx'
import { FakeClient, mkPane, mkTab, mkWorkspace, pid, snapshotOf } from '../test-helpers.ts'

export const SID = AgentSessionId.parse('agent-session-00000001')
export const bid = (n: number) => BlockId.parse(`block-${String(n).padStart(8, '0')}`)

export const tick = () => new Promise((r) => setTimeout(r, 0))
export async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await tick()
}

export function mkSession(over: Partial<AgentSession> = {}): AgentSession {
  return {
    id: SID,
    provider: 'fake',
    paneId: pid('p1'),
    permissionMode: 'ask',
    cwd: '/work',
    status: 'idle',
    turn: 1,
    blockCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

type Common = { id: BlockId; index: number; turn: number; seq: number; createdAt: number }
const base = (n: number): Common => ({ id: bid(n), index: n, turn: 1, seq: 0, createdAt: 1 })

/** Fábricas de bloques válidos (sin pasar por zod: son datos de prueba, el borde ya los valida). */
export const blocks = {
  user: (n: number, text = 'hola'): Block => ({ ...base(n), type: 'user', text }),
  text: (n: number, text = 'texto', over: Record<string, unknown> = {}): Block =>
    ({ ...base(n), type: 'text', text, complete: true, ...over }) as Block,
  reasoning: (n: number, text = 'pienso', over: Record<string, unknown> = {}): Block =>
    ({ ...base(n), type: 'reasoning', text, complete: true, ...over }) as Block,
  action: (n: number, over: Record<string, unknown> = {}): Block =>
    ({
      ...base(n),
      type: 'action',
      kind: 'exec',
      status: 'ok',
      tool: 'Bash',
      title: 'ls -la',
      ...over,
    }) as Block,
  permission: (n: number, over: Record<string, unknown> = {}): Block =>
    ({
      ...base(n),
      type: 'permission',
      tool: 'Bash',
      title: 'Ejecutar rm -rf build',
      options: [
        { id: 'once', label: 'Permitir una vez', kind: 'allow-once' },
        { id: 'always', label: 'Permitir siempre', kind: 'allow-always' },
        { id: 'no', label: 'Rechazar', kind: 'reject-once' },
        { id: 'never', label: 'Rechazar siempre', kind: 'reject-always' },
      ],
      state: 'pending',
      ...over,
    }) as Block,
  question: (n: number, over: Record<string, unknown> = {}): Block =>
    ({
      ...base(n),
      type: 'question',
      state: 'pending',
      questions: [
        {
          id: 'q1',
          header: 'Color',
          question: '¿Qué color prefieres?',
          options: [{ label: 'Rojo' }, { label: 'Azul', description: 'el frío' }],
          multiSelect: false,
          allowText: true,
        },
      ],
      ...over,
    }) as Block,
  plan: (n: number): Block =>
    ({
      ...base(n),
      type: 'plan',
      entries: [
        { text: 'Leer', status: 'completed' },
        { text: 'Editar', status: 'in-progress' },
        { text: 'Probar', status: 'pending' },
      ],
    }) as Block,
  error: (n: number, over: Record<string, unknown> = {}): Block =>
    ({
      ...base(n),
      type: 'error',
      code: 'BOOM',
      message: 'algo falló',
      fatal: false,
      ...over,
    }) as Block,
  usage: (n: number): Block =>
    ({
      ...base(n),
      type: 'usage',
      stopReason: 'end-turn',
      usage: { inputTokens: 1200, outputTokens: 340, costUsd: 0.0123, durationMs: 2500 },
    }) as Block,
}

export const FAKE_PROVIDER: ProviderInfo = {
  id: 'fake',
  name: 'Proveedor falso',
  available: true,
  capabilities: {
    models: [
      { id: 'm1', label: 'Modelo uno', efforts: ['low', 'high'] },
      { id: 'm2', label: 'Modelo dos' },
    ],
    defaultModel: 'm1',
    efforts: ['low', 'medium', 'high'],
    permissionModes: ['ask', 'accept-edits', 'plan', 'bypass'],
    resume: false,
    warmup: false,
    streaming: true,
  },
}

export type AgentHarnessOptions = {
  blocks?: Block[]
  session?: Partial<AgentSession>
  /** `false`: panel de agente sin sesión todavía (pantalla de inicio con los chips). */
  withSession?: boolean
  providers?: ProviderInfo[]
  providersFail?: boolean
}

/** Aplicación montada con un panel de agente y un daemon falso que sirve `agent.snapshot` y `agent.providers`. */
export async function mountAgent(options: AgentHarnessOptions = {}) {
  const state = {
    blocks: options.blocks ?? [],
    session: mkSession(options.session),
  }
  const withSession = options.withSession ?? true
  const client = new FakeClient()
  client.handlers.set('agent.snapshot', (params) => {
    const from = (params as { fromIndex?: number }).fromIndex ?? 0
    const limit = (params as { limit?: number }).limit ?? 100
    const rest = state.blocks.filter((b) => b.index >= from)
    const page = rest.slice(0, limit)
    return {
      session: state.session,
      blocks: page,
      nextIndex: rest.length > limit ? (rest[limit]?.index ?? null) : null,
    }
  })
  client.handlers.set('agent.providers', () => {
    if (options.providersFail === true) throw new Error('sin proveedores')
    return { providers: options.providers ?? [FAKE_PROVIDER] }
  })
  const pane = mkPane('p1', { kind: 'agent', ...(withSession ? { agentSessionId: SID } : {}) })
  const tab = { ...mkTab('t1', ['p1']), panes: [pane] }
  const app = await mountApp(snapshotOf([mkWorkspace('w1', [tab])]), client)
  await settle()
  app.frames.flush()
  await settle()

  return {
    ...app,
    state,
    model: app.model.agents.ensure('p1'),
    appModel: app.model,
    emitBlock(block: Block) {
      client.emit('agent.block', { sessionId: SID, block })
    },
    emitDelta(blockId: BlockId, seq: number, text: string, field: 'text' | 'output' = 'text') {
      client.emit('agent.delta', { sessionId: SID, blockId, field, seq, text })
    },
    emitStatus(status: AgentSession['status']) {
      client.emit('agent.status', { sessionId: SID, status, updatedAt: 2 })
    },
    /** Vacía los fotogramas pendientes y deja correr las promesas. */
    async flush() {
      app.frames.flush()
      await settle(3)
      app.frames.flush()
    },
  }
}
