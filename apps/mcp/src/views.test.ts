import type { Attention } from '@nexo/contracts'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { LinkEvent } from './link.ts'
import { SESSION_ID, session, workspace } from './test-helpers.ts'
import {
  agentStatusUri,
  attentionRank,
  buildAgentStatus,
  buildAttention,
  buildLimits,
  buildWorkspaces,
  canonicalUri,
  invalidationFor,
  parseAgentStatusUri,
  URI,
  worstAttention,
} from './views.ts'

const ATTENTIONS: Attention[] = ['idle', 'working', 'needs-input', 'done', 'error']

describe('URIs', () => {
  it('parsea la URI de estado de una sesión', () => {
    expect(parseAgentStatusUri(agentStatusUri(SESSION_ID))).toBe(SESSION_ID)
  })

  it.each([
    'nexo://agents//status',
    'nexo://agents/a/b/status',
    'nexo://agents/a b/status',
    'nexo://agents/x/status?y=1',
    'nexo://agents/x/status#f',
    'http://agents/x/status',
    'nexo://agents/../status',
    `nexo://agents/${'a'.repeat(100)}/status`,
    '',
  ])('rechaza %j', (uri) => {
    expect(parseAgentStatusUri(uri)).toBeUndefined()
  })

  it('canonicalUri normaliza o rechaza', () => {
    expect(canonicalUri('nexo://attention')).toBe('nexo://attention')
    expect(canonicalUri('no es una uri')).toBeUndefined()
  })
})

describe('atención', () => {
  it('manda lo que necesita al usuario, luego error, trabajo y fin de turno', () => {
    expect(worstAttention([])).toBe('idle')
    expect(worstAttention(['done', 'working'])).toBe('working')
    expect(worstAttention(['working', 'error'])).toBe('error')
    expect(worstAttention(['error', 'needs-input', 'done'])).toBe('needs-input')
  })

  it('propiedad: el peor estado es el de mayor rango y pertenece a la lista', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...ATTENTIONS), { maxLength: 20 }), (list) => {
        const worst = worstAttention(list)
        for (const a of list) expect(attentionRank(a)).toBeLessThanOrEqual(attentionRank(worst))
        if (list.length > 0) expect(list.includes(worst) || worst === 'idle').toBe(true)
      }),
    )
  })

  it('buildAttention cuenta y lista solo los paneles que no están en reposo', () => {
    const ws = workspace()
    const pane = ws.tabs[0]?.panes[0]
    if (pane === undefined) throw new Error('sin panel')
    pane.attention = 'needs-input'
    pane.title = 'a\x1b[31mb'
    const view = buildAttention([ws, workspace({ id: 'ws-otro' as never })])
    expect(view.state).toBe('needs-input')
    expect(view.counts['needs-input']).toBe(1)
    expect(view.counts.idle).toBe(1)
    expect(view.panes).toHaveLength(1)
    expect(view.panes[0]?.title).toBe('ab')
    expect(buildAttention([]).state).toBe('idle')
  })

  it('buildAttention acota la lista de paneles', () => {
    const ws = workspace()
    const base = ws.tabs[0]?.panes[0]
    if (base === undefined) throw new Error('sin panel')
    const tab = ws.tabs[0]
    if (tab === undefined) throw new Error('sin pestaña')
    tab.panes = Array.from({ length: 500 }, (_, i) => ({
      ...base,
      id: `pane-${i}` as never,
      attention: 'working' as const,
    }))
    const view = buildAttention([ws])
    expect(view.panes).toHaveLength(200)
    expect(view.counts.working).toBe(500)
  })
})

describe('vistas', () => {
  it('buildWorkspaces conserva ids y limpia textos', () => {
    const ws = workspace({ name: 'x\ny' as never })
    const [v] = buildWorkspaces([ws])
    expect(v?.name).toBe('x y')
    expect(v?.tabs[0]?.panes[0]?.terminalId).toBe('term-dddd4444')
  })

  it('buildAgentStatus incluye el motivo solo si lo hay', () => {
    expect(buildAgentStatus(session()).reason).toBeUndefined()
    expect(buildAgentStatus(session(), '').reason).toBeUndefined()
    expect(buildAgentStatus(session({ status: 'error' }), 'falló\x07').reason).toBe('falló')
  })

  it('buildLimits calcula el peor porcentaje', () => {
    const v = buildLimits([
      {
        provider: 'codex',
        status: 'ok',
        windows: [
          { id: 'primary', usedPercent: 40 },
          { id: 'secondary', usedPercent: 71 },
        ],
      },
      { provider: 'claude', status: 'unknown', windows: [] },
    ] as never)
    expect(v.worstUsedPercent).toBe(71)
    expect(v.providers[1]?.worstUsedPercent).toBeNull()
    expect(buildLimits([]).worstUsedPercent).toBeNull()
  })
})

describe('invalidationFor', () => {
  const known = new Set<string>([SESSION_ID])
  const ev = (name: string, data: unknown) => ({ name, data }) as LinkEvent

  it('cada evento toca los recursos que le corresponden', () => {
    expect(invalidationFor(ev('pane.attention', {}), known).uris).toEqual([
      URI.attention,
      URI.workspaces,
    ])
    expect(invalidationFor(ev('agent.status', { sessionId: SESSION_ID }), known).uris).toContain(
      agentStatusUri(SESSION_ID),
    )
    expect(invalidationFor(ev('limits.updated', {}), known).uris).toEqual([URI.limits])
    expect(invalidationFor(ev('layout.changed', {}), known).uris).toContain(URI.workspaces)
    expect(invalidationFor(ev('workspace.changed', {}), known).uris).toContain(URI.attention)
  })

  it('la lista cambia con sesiones nuevas o cerradas, no con cambios de una conocida', () => {
    expect(invalidationFor(ev('agent.session', { session: session() }), known).listChanged).toBe(
      false,
    )
    expect(
      invalidationFor(ev('agent.session', { session: session({ id: 'agent-nuevo' }) }), known)
        .listChanged,
    ).toBe(true)
    expect(
      invalidationFor(ev('agent.session', { sessionId: SESSION_ID, removed: true }), known)
        .listChanged,
    ).toBe(true)
  })

  it('un resync invalida todo y no inventa eventos desconocidos', () => {
    const r = invalidationFor({ name: 'resync' }, known)
    expect(r.listChanged).toBe(true)
    expect(r.uris).toContain(URI.limits)
    expect(invalidationFor(ev('algo.raro', {}), known)).toEqual({ uris: [], listChanged: false })
  })
})
