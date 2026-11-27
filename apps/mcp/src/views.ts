import {
  type AgentSession,
  AgentSessionId,
  type Attention,
  type ProviderLimits,
  type Workspace,
} from '@nexo/contracts'
import type { LinkEvent } from './link.ts'
import { oneLine } from './text.ts'

// ---- URIs de los recursos ----

export const URI = {
  attention: 'nexo://attention',
  workspaces: 'nexo://workspaces',
  agents: 'nexo://agents',
  limits: 'nexo://limits',
} as const

export const agentStatusUri = (id: string): string => `nexo://agents/${id}/status`

/** Id de sesión de una URI `nexo://agents/<id>/status`; `undefined` si no tiene esa forma o el id es raro. */
export function parseAgentStatusUri(uri: string): string | undefined {
  const m = /^nexo:\/\/agents\/([^/?#]+)\/status$/.exec(uri)
  if (m === null) return undefined
  const parsed = AgentSessionId.safeParse(m[1])
  return parsed.success ? parsed.data : undefined
}

/** URI en su forma canónica (la que usa `new URL`); sirve para comparar suscripciones. */
export function canonicalUri(uri: string): string | undefined {
  try {
    return new URL(uri).toString()
  } catch {
    return undefined
  }
}

// ---- Atención ----

/** De más a menos urgente: lo que necesita al usuario manda sobre lo que trabaja. */
const RANK: Record<Attention, number> = {
  'needs-input': 4,
  error: 3,
  working: 2,
  done: 1,
  idle: 0,
}

export function attentionRank(a: Attention): number {
  return RANK[a]
}

/** El estado más urgente de una lista (`idle` si está vacía). */
export function worstAttention(list: readonly Attention[]): Attention {
  let worst: Attention = 'idle'
  for (const a of list) if (RANK[a] > RANK[worst]) worst = a
  return worst
}

export type AttentionView = {
  /** Estado agregado: el más urgente de todos los paneles. */
  state: Attention
  counts: Record<Attention, number>
  /** Paneles que no están en reposo (hasta 200). */
  panes: {
    workspaceId: string
    workspaceName: string
    tabId: string
    tabTitle: string
    paneId: string
    kind: string
    title: string
    attention: Attention
    agentSessionId?: string
  }[]
}

const MAX_ATTENTION_PANES = 200

export function buildAttention(workspaces: readonly Workspace[]): AttentionView {
  const counts: Record<Attention, number> = {
    idle: 0,
    working: 0,
    'needs-input': 0,
    done: 0,
    error: 0,
  }
  const panes: AttentionView['panes'] = []
  for (const w of workspaces) {
    for (const t of w.tabs) {
      for (const p of t.panes) {
        counts[p.attention]++
        if (p.attention === 'idle' || panes.length >= MAX_ATTENTION_PANES) continue
        panes.push({
          workspaceId: w.id,
          workspaceName: oneLine(w.name, 120),
          tabId: t.id,
          tabTitle: oneLine(t.title, 120),
          paneId: p.id,
          kind: p.kind,
          title: oneLine(p.title, 120),
          attention: p.attention,
          ...(p.agentSessionId === undefined ? {} : { agentSessionId: p.agentSessionId }),
        })
      }
    }
  }
  panes.sort((a, b) => RANK[b.attention] - RANK[a.attention])
  const state = worstAttention((Object.keys(counts) as Attention[]).filter((k) => counts[k] > 0))
  return { state, counts, panes }
}

// ---- Espacios ----

export type WorkspaceView = {
  id: string
  name: string
  cwd?: string
  activeTabId?: string
  tabs: {
    id: string
    title: string
    focusedPaneId: string
    panes: {
      id: string
      kind: string
      title: string
      attention: Attention
      terminalId?: string
      agentSessionId?: string
      viewerPath?: string
    }[]
  }[]
}

export function buildWorkspaces(workspaces: readonly Workspace[]): WorkspaceView[] {
  return workspaces.map((w) => ({
    id: w.id,
    name: oneLine(w.name, 120),
    ...(w.cwd === undefined ? {} : { cwd: oneLine(w.cwd, 400) }),
    ...(w.activeTabId === undefined ? {} : { activeTabId: w.activeTabId }),
    tabs: w.tabs.map((t) => ({
      id: t.id,
      title: oneLine(t.title, 120),
      focusedPaneId: t.focusedPaneId,
      panes: t.panes.map((p) => ({
        id: p.id,
        kind: p.kind,
        title: oneLine(p.title, 120),
        attention: p.attention,
        ...(p.terminalId === undefined ? {} : { terminalId: p.terminalId }),
        ...(p.agentSessionId === undefined ? {} : { agentSessionId: p.agentSessionId }),
        ...(p.viewerPath === undefined ? {} : { viewerPath: oneLine(p.viewerPath, 400) }),
      })),
    })),
  }))
}

// ---- Agentes ----

export type AgentStatusView = {
  sessionId: string
  provider: string
  title?: string
  status: Attention
  turn: number
  blockCount: number
  permissionMode: string
  paneId: string
  updatedAt: number
  /** Motivo breve de `error` o `needs-input`, si el último `agent.status` lo trajo. */
  reason?: string
}

export function buildAgentStatus(session: AgentSession, reason?: string): AgentStatusView {
  return {
    sessionId: session.id,
    provider: session.provider,
    ...(session.title === undefined ? {} : { title: oneLine(session.title, 120) }),
    status: session.status,
    turn: session.turn,
    blockCount: session.blockCount,
    permissionMode: session.permissionMode,
    paneId: session.paneId,
    updatedAt: session.updatedAt,
    ...(reason === undefined || reason === '' ? {} : { reason: oneLine(reason, 300) }),
  }
}

// ---- Límites ----

export type LimitsView = {
  /** El mayor porcentaje usado entre todas las ventanas conocidas; `null` si no hay datos. */
  worstUsedPercent: number | null
  providers: {
    provider: string
    status: string
    reached?: boolean
    fresh?: boolean
    observedAt?: number
    worstUsedPercent: number | null
    windows: {
      id: string
      label?: string
      usedPercent: number
      resetsAt?: number
      state?: string
    }[]
    reason?: string
  }[]
}

export function buildLimits(providers: readonly ProviderLimits[]): LimitsView {
  let overall: number | null = null
  const out: LimitsView['providers'] = providers.map((p) => {
    let worst: number | null = null
    for (const w of p.windows) {
      if (worst === null || w.usedPercent > worst) worst = w.usedPercent
    }
    if (worst !== null && (overall === null || worst > overall)) overall = worst
    return {
      provider: p.provider,
      status: p.status,
      ...(p.reached === undefined ? {} : { reached: p.reached }),
      ...(p.fresh === undefined ? {} : { fresh: p.fresh }),
      ...(p.observedAt === undefined ? {} : { observedAt: p.observedAt }),
      worstUsedPercent: worst,
      windows: p.windows.map((w) => ({
        id: w.id,
        ...(w.label === undefined ? {} : { label: oneLine(w.label, 64) }),
        usedPercent: w.usedPercent,
        ...(w.resetsAt === undefined ? {} : { resetsAt: w.resetsAt }),
        ...(w.state === undefined ? {} : { state: w.state }),
      })),
      ...(p.reason === undefined ? {} : { reason: oneLine(p.reason, 300) }),
    }
  })
  return { worstUsedPercent: overall, providers: out }
}

// ---- Qué recursos cambian con cada evento ----

export type Invalidation = {
  /** URIs de recursos cuyo contenido pudo cambiar. */
  uris: string[]
  /** `true` si la lista de recursos (sesiones de agente) cambió. */
  listChanged: boolean
}

/** Pura: de un evento del daemon, qué recursos hay que avisar como cambiados. */
export function invalidationFor(event: LinkEvent, knownAgents: ReadonlySet<string>): Invalidation {
  const none: Invalidation = { uris: [], listChanged: false }
  switch (event.name) {
    case 'pane.attention':
      return { uris: [URI.attention, URI.workspaces], listChanged: false }
    case 'agent.status':
      return {
        uris: [URI.attention, URI.agents, agentStatusUri(event.data.sessionId)],
        listChanged: false,
      }
    case 'agent.session': {
      const data = event.data
      if ('removed' in data) {
        return {
          uris: [URI.attention, URI.agents, agentStatusUri(data.sessionId)],
          listChanged: true,
        }
      }
      return {
        uris: [URI.agents, agentStatusUri(data.session.id)],
        listChanged: !knownAgents.has(data.session.id),
      }
    }
    case 'limits.updated':
      return { uris: [URI.limits], listChanged: false }
    case 'layout.changed':
    case 'workspace.changed':
      return { uris: [URI.workspaces, URI.attention], listChanged: false }
    case 'resync':
      return { uris: [URI.attention, URI.workspaces, URI.agents, URI.limits], listChanged: true }
    default:
      return none
  }
}
