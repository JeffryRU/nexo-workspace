import type { Attention } from '@nexo/contracts'
import { createSignal } from 'solid-js'
import type { AgentRegistry } from '../agent/registry.ts'
import { aggregateAttention } from '../layout/tree.ts'
import type { AppState, TabState, WorkspaceState } from '../state/model.ts'
import type { AppStore } from '../state/store.ts'

/** Orden de salto: primero lo que espera una respuesta, luego los errores y por último lo terminado. */
const JUMP_ORDER: readonly Attention[] = ['needs-input', 'error', 'done']

export type PaneRef = { paneId: string; workspaceId: string; tabId: string; attention: Attention }

/**
 * Atención tal como se muestra al usuario. El servidor guarda el estado de la sesión (`Pane.attention`); que un
 * `done` ya se haya visto es cosa de cada cliente (dos ventanas pueden tener visto distinto), así que se
 * resuelve aquí: un `done` visto se muestra como `idle` hasta que el panel cambie de estado.
 */
export function createAttentionModel(deps: { store: AppStore; agents: AgentRegistry }) {
  const { store, agents } = deps
  const [seen, setSeen] = createSignal<ReadonlySet<string>>(new Set())

  const shown = (paneId: string, attention: Attention): Attention =>
    attention === 'done' && seen().has(paneId) ? 'idle' : attention

  /** Cuántas respuestas espera un panel: los permisos y preguntas pendientes (al menos 1 si pide atención). */
  const panePending = (paneId: string, attention: Attention): number => {
    if (attention !== 'needs-input') return 0
    return Math.max(1, agents.get(paneId)?.pendingIds().length ?? 0)
  }

  const tabAttention = (tab: TabState): Attention =>
    aggregateAttention(tab.panes.map((p) => ({ attention: shown(p.id, p.attention) })))

  const workspaceAttention = (w: WorkspaceState): Attention =>
    aggregateAttention(w.tabs.map((t) => ({ attention: tabAttention(t) })))

  const tabPending = (tab: TabState): number =>
    tab.panes.reduce((n, p) => n + panePending(p.id, p.attention), 0)

  const workspacePending = (w: WorkspaceState): number =>
    w.tabs.reduce((n, t) => n + tabPending(t), 0)

  /** Paneles que reclaman al usuario: esperan respuesta, fallaron o terminaron sin que se vieran. */
  const demanding = (): PaneRef[] => collect(store.state, shown)

  return {
    paneAttention: shown,
    tabAttention,
    workspaceAttention,
    panePending,
    tabPending,
    workspacePending,
    demanding,
    /** Total para el título de la ventana: paneles que reclaman atención. */
    count: () => demanding().length,
    /** Marca como visto el `done` de un panel (al enfocarlo). Devuelve `true` si cambió algo. */
    markSeen(paneId: string): boolean {
      if (seen().has(paneId)) return false
      setSeen((prev) => new Set(prev).add(paneId))
      return true
    },
    /** Olvida lo visto de los paneles que ya no están en `done` (para que el siguiente `done` sí se muestre). */
    forgetSeen(): void {
      const s = seen()
      if (s.size === 0) return
      const live = new Map<string, Attention>()
      for (const w of store.state.workspaces)
        for (const t of w.tabs) for (const p of t.panes) live.set(p.id, p.attention)
      const next = new Set([...s].filter((id) => live.get(id) === 'done'))
      if (next.size !== s.size) setSeen(next)
    },
    /** El siguiente panel que necesita atención tras `currentPaneId` (cíclico, en cualquier pestaña o espacio). */
    next(currentPaneId: string | undefined): PaneRef | undefined {
      return nextPane(demanding(), currentPaneId)
    },
  }
}

export type AttentionModel = ReturnType<typeof createAttentionModel>

function collect(
  state: AppState,
  shown: (paneId: string, attention: Attention) => Attention,
): PaneRef[] {
  const out: PaneRef[] = []
  for (const w of state.workspaces) {
    for (const t of w.tabs) {
      for (const p of t.panes) {
        const attention = shown(p.id, p.attention)
        if (JUMP_ORDER.includes(attention)) {
          out.push({ paneId: p.id, workspaceId: w.id, tabId: t.id, attention })
        }
      }
    }
  }
  return out
}

/**
 * Lista ordenada por urgencia (y, dentro de cada una, por posición); sigue a `current` si está en ella y, si no,
 * empieza por la más urgente. Nunca devuelve el panel actual salvo que sea el único.
 */
export function nextPane(
  refs: readonly PaneRef[],
  current: string | undefined,
): PaneRef | undefined {
  if (refs.length === 0) return undefined
  const ordered = JUMP_ORDER.flatMap((a) => refs.filter((r) => r.attention === a))
  const i = ordered.findIndex((r) => r.paneId === current)
  return ordered[(i + 1) % ordered.length]
}
