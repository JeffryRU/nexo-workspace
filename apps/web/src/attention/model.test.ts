import type { Attention } from '@nexo/contracts'
import fc from 'fast-check'
import { createRoot } from 'solid-js'
import { describe, expect, it } from 'vitest'
import type { AgentRegistry } from '../agent/registry.ts'
import { createAppStore } from '../state/store.ts'
import { mkPane, mkTab, mkWorkspace, pid, snapshotOf } from '../test-helpers.ts'
import { createAttentionModel, nextPane, type PaneRef } from './model.ts'

const ref = (paneId: string, attention: Attention): PaneRef => ({
  paneId,
  workspaceId: 'w',
  tabId: 't',
  attention,
})

function build(attentions: Record<string, Attention>, pending: Record<string, number> = {}) {
  const store = createAppStore()
  const tab = mkTab('t1', Object.keys(attentions))
  tab.panes = Object.entries(attentions).map(([id, attention]) => mkPane(id, { attention }))
  const tab2 = mkTab('t2', ['z1'])
  store.applySnapshot(snapshotOf([mkWorkspace('w1', [tab, tab2])]))
  const agents = {
    get: (id: string) =>
      id in pending
        ? { pendingIds: () => Array.from({ length: pending[id] as number }, String) }
        : undefined,
  } as unknown as AgentRegistry
  return { store, model: createAttentionModel({ store, agents }), tab }
}

describe('nextPane', () => {
  it('sin candidatos no hay siguiente', () => {
    expect(nextPane([], 'a')).toBeUndefined()
  })

  it('empieza por lo más urgente y cicla', () => {
    const refs = [ref('d', 'done'), ref('e', 'error'), ref('n', 'needs-input')]
    expect(nextPane(refs, undefined)?.paneId).toBe('n')
    expect(nextPane(refs, 'n')?.paneId).toBe('e')
    expect(nextPane(refs, 'e')?.paneId).toBe('d')
    expect(nextPane(refs, 'd')?.paneId).toBe('n')
    expect(nextPane(refs, 'otro')?.paneId).toBe('n')
  })

  it('con un solo candidato devuelve ese mismo', () => {
    expect(nextPane([ref('a', 'done')], 'a')?.paneId).toBe('a')
  })

  it('propiedad: seguir `next` desde cualquier panel visita todos los candidatos', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<Attention>('needs-input', 'error', 'done'), {
          minLength: 1,
          maxLength: 12,
        }),
        (list) => {
          const refs = list.map((a, i) => ref(`p${i}`, a))
          const seen = new Set<string>()
          let cur: string | undefined
          for (let i = 0; i < refs.length; i++) {
            cur = nextPane(refs, cur)?.paneId
            seen.add(cur as string)
          }
          return seen.size === refs.length
        },
      ),
    )
  })
})

describe('createAttentionModel', () => {
  it('un done visto se muestra como idle hasta que el panel cambie de estado', () =>
    createRoot((dispose) => {
      const { store, model } = build({ p1: 'done', p2: 'working' })
      expect(model.paneAttention('p1', 'done')).toBe('done')
      expect(model.markSeen('p1')).toBe(true)
      expect(model.markSeen('p1')).toBe(false)
      expect(model.paneAttention('p1', 'done')).toBe('idle')
      // lo que no es done no se esconde
      expect(model.paneAttention('p2', 'working')).toBe('working')
      // sigue en done: sigue visto
      model.forgetSeen()
      expect(model.paneAttention('p1', 'done')).toBe('idle')
      // sale de done y vuelve: se muestra de nuevo
      store.applyEvent({
        event: 'pane.attention',
        seq: 5,
        data: { paneId: pid('p1'), attention: 'working' },
      })
      model.forgetSeen()
      expect(model.paneAttention('p1', 'done')).toBe('done')
      dispose()
    }))

  it('agrega por pestaña y espacio con lo visto aplicado, y cuenta los pendientes', () =>
    createRoot((dispose) => {
      const { store, model } = build({ p1: 'needs-input', p2: 'done', p3: 'idle' }, { p1: 3 })
      const w = store.state.workspaces[0]
      const t = w?.tabs[0]
      if (w === undefined || t === undefined) throw new Error('sin datos')
      expect(model.tabAttention(t)).toBe('needs-input')
      expect(model.tabPending(t)).toBe(3)
      expect(model.workspacePending(w)).toBe(3)
      expect(model.workspaceAttention(w)).toBe('needs-input')
      expect(model.count()).toBe(2)
      dispose()
    }))

  it('needs-input sin modelo de agente cuenta como 1 pendiente; los demás estados, 0', () =>
    createRoot((dispose) => {
      const { model } = build({ p1: 'needs-input' })
      expect(model.panePending('p1', 'needs-input')).toBe(1)
      expect(model.panePending('p1', 'done')).toBe(0)
      expect(model.panePending('p1', 'error')).toBe(0)
      dispose()
    }))

  it('el total de atención sube y baja con los eventos y respeta lo visto', () =>
    createRoot((dispose) => {
      const { store, model } = build({ p1: 'idle', p2: 'idle' })
      expect(model.count()).toBe(0)
      store.applyEvent({
        event: 'pane.attention',
        seq: 5,
        data: { paneId: pid('p1'), attention: 'done' },
      })
      expect(model.count()).toBe(1)
      model.markSeen('p1')
      expect(model.count()).toBe(0)
      dispose()
    }))
})
