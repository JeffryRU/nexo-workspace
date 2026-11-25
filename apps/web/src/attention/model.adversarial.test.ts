import type { Attention } from '@nexo/contracts'
import { createRoot } from 'solid-js'
import { describe, expect, it } from 'vitest'
import type { AgentRegistry } from '../agent/registry.ts'
import { createAppStore } from '../state/store.ts'
import { mkPane, mkTab, mkWorkspace, snapshotOf } from '../test-helpers.ts'
import { createAttentionModel, nextPane, type PaneRef } from './model.ts'

const noAgents = { get: () => undefined } as unknown as AgentRegistry

describe('attention model (adversarial)', () => {
  it('ids hostiles (__proto__, constructor) no contaminan ni rompen lo visto', () =>
    createRoot((dispose) => {
      const store = createAppStore()
      const tab = mkTab('t1', ['p1'])
      tab.panes = [mkPane('p1', { attention: 'done' })]
      store.applySnapshot(snapshotOf([mkWorkspace('w1', [tab])]))
      const model = createAttentionModel({ store, agents: noAgents })
      for (const id of ['__proto__', 'constructor', 'toString', '']) {
        expect(model.markSeen(id)).toBe(true)
        expect(model.paneAttention(id, 'done')).toBe('idle')
      }
      model.forgetSeen()
      expect(model.paneAttention('p1', 'done')).toBe('done')
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
      dispose()
    }))

  it('5 000 paneles: el total y el siguiente salen sin recorrer en exceso', () =>
    createRoot((dispose) => {
      const store = createAppStore()
      const ids = Array.from({ length: 5000 }, (_, i) => `p${i}`)
      const tab = mkTab('t1', ids)
      const kinds: Attention[] = ['idle', 'working', 'needs-input', 'done', 'error']
      tab.panes = ids.map((id, i) => mkPane(id, { attention: kinds[i % 5] as Attention }))
      store.applySnapshot(snapshotOf([mkWorkspace('w1', [tab])]))
      const model = createAttentionModel({ store, agents: noAgents })
      const t0 = performance.now()
      expect(model.count()).toBe(3000)
      expect(model.next('p0')?.attention).toBe('needs-input')
      expect(performance.now() - t0).toBeLessThan(2000)
      dispose()
    }))

  it('nextPane con un panel actual repetido o desconocido no lanza', () => {
    const refs: PaneRef[] = [
      { paneId: 'a', workspaceId: 'w', tabId: 't', attention: 'done' },
      { paneId: 'a', workspaceId: 'w', tabId: 't', attention: 'done' },
    ]
    expect(nextPane(refs, 'a')?.paneId).toBe('a')
    expect(nextPane(refs, '__proto__')?.paneId).toBe('a')
  })
})
