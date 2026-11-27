import type {
  HistoryBlock,
  HistoryProject,
  HistoryProviderStatus,
  HistorySession,
  MethodParams,
  MethodResult,
  ProviderInfo,
} from '@nexo/contracts'
import {
  type AgentHarnessOptions,
  FAKE_PROVIDER,
  mountAgent,
  settle,
} from '../agent/test-helpers.ts'
import { mkPane, mkTab } from '../test-helpers.ts'

export const OTHER_PROVIDER: ProviderInfo = { ...FAKE_PROVIDER, id: 'codex', name: 'Codex falso' }

export const NOW = 1_700_000_000_000

export const hs = (n: number, over: Partial<HistorySession> = {}): HistorySession => ({
  provider: 'fake',
  sessionId: `sesion-${String(n).padStart(6, '0')}`,
  title: `Sesión ${n}`,
  cwd: '/work/app',
  updatedAt: NOW - n * 60_000,
  messageCount: n,
  resumable: true,
  readable: true,
  ...over,
})

export const hblock = (index: number, block: Record<string, unknown>, turn = 1): HistoryBlock =>
  ({ index, turn, block }) as HistoryBlock

export const userBlock = (index: number, text: string) => hblock(index, { type: 'user', text })
export const textBlock = (index: number, text: string) =>
  hblock(index, { type: 'text', text, complete: true })

/** Agrupa por carpeta conservando el orden (como el daemon, ya ordenado). */
export function groupByCwd(sessions: HistorySession[]): HistoryProject[] {
  const byCwd = new Map<string, HistoryProject>()
  for (const s of sessions) {
    const key = s.cwd ?? '\u0000'
    let p = byCwd.get(key)
    if (p === undefined) {
      p = {
        cwd: s.cwd ?? null,
        name:
          s.cwd === undefined
            ? 'Sin carpeta'
            : (s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? s.cwd),
        sessions: [],
      }
      byCwd.set(key, p)
    }
    p.sessions.push(s)
  }
  return [...byCwd.values()]
}

export type HistoryHarnessOptions = AgentHarnessOptions & {
  sessions?: HistorySession[]
  /** Sesiones por página que sirve el daemon falso. */
  pageSize?: number
  statuses?: HistoryProviderStatus[]
  transcripts?: Record<string, HistoryBlock[]>
  /** Bloques por página de `history.read`. */
  blocksPage?: number
  listFails?: string
  readFails?: string
  limits?: MethodResult<'limits.status'>['providers']
}

/** Aplicación con un daemon falso que sirve `history.*` y `limits.status` (cursor = posición, como `o<n>`). */
export async function mountHistory(options: HistoryHarnessOptions = {}) {
  const state = {
    sessions: options.sessions ?? [hs(1), hs(2), hs(3, { cwd: '/work/otra' })],
    statuses: options.statuses ?? ([{ provider: 'fake', status: 'ok' }] as HistoryProviderStatus[]),
    transcripts: options.transcripts ?? {},
    listFails: options.listFails,
    readFails: options.readFails,
    limits: options.limits ?? [],
  }
  const h = await mountAgent({
    providers: [FAKE_PROVIDER, OTHER_PROVIDER],
    ...options,
    setup: (client) => {
      client.handlers.set('history.list', (p) => {
        if (state.listFails !== undefined) throw new Error(state.listFails)
        const params = p as MethodParams<'history.list'>
        const pool = state.sessions.filter(
          (s) => params.provider === undefined || s.provider === params.provider,
        )
        const from = params.cursor === undefined ? 0 : Number(params.cursor.slice(1))
        const size = Math.min(params.limit ?? 50, options.pageSize ?? 50)
        const page = pool.slice(from, from + size)
        return {
          projects: groupByCwd(page),
          nextCursor: from + size < pool.length ? `c${from + size}` : null,
          providers: state.statuses,
        }
      })
      client.handlers.set('history.read', (p) => {
        if (state.readFails !== undefined) throw new Error(state.readFails)
        const params = p as MethodParams<'history.read'>
        const all = state.transcripts[params.sessionId] ?? []
        const from = params.cursor === undefined ? 0 : Number(params.cursor.slice(1))
        const size = Math.min(params.limit ?? 100, options.blocksPage ?? 100)
        return {
          provider: params.provider,
          sessionId: params.sessionId,
          blocks: all.slice(from, from + size),
          nextCursor: from + size < all.length ? `o${from + size}` : null,
          total: all.length,
          truncated: false,
        }
      })
      client.handlers.set('limits.status', () => ({ providers: structuredClone(state.limits) }))
      client.handlers.set('tab.create', () => ({
        tab: { ...mkTab('t-new', ['p-new']), panes: [mkPane('p-new')] },
      }))
      client.handlers.set('pane.split', () => ({ pane: mkPane('p-agent', { kind: 'agent' }) }))
      client.handlers.set('pane.close', () => ({}))
      client.handlers.set('agent.create', () => ({ session: {} }))
      options.setup?.(client)
    },
  })
  return { ...h, history: state }
}

export type HistoryHarness = Awaited<ReturnType<typeof mountHistory>>

export const historyDialog = (h: { container: HTMLElement }): HTMLElement =>
  h.container.querySelector<HTMLElement>('.history-dialog') as HTMLElement

/** Abre el historial con el botón de la barra de estado y espera las consultas. */
export async function openHistory(h: HistoryHarness): Promise<void> {
  const button = h.container.querySelector<HTMLButtonElement>('.history-toggle')
  if (button === null) throw new Error('falta el botón de historial')
  button.click()
  await settle(10)
}
