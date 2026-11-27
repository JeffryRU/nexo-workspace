import type { HistoryProject, HistorySession } from '@nexo/contracts'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { groupByCwd, hblock, hs, userBlock } from './test-helpers.ts'
import {
  capSessions,
  countSessions,
  filterProjects,
  formatLocalWhen,
  historyBlockId,
  mergeBlocks,
  mergeProjects,
  normalizeCwd,
  providerNotice,
  sessionTitle,
  toBlock,
} from './view.ts'

describe('mergeProjects', () => {
  it('une la carpeta partida entre páginas y conserva el orden', () => {
    const merged = mergeProjects([
      groupByCwd([hs(1), hs(2, { cwd: '/b' })]),
      groupByCwd([hs(3), hs(4, { cwd: '/c' })]),
    ])
    expect(merged.map((p) => [p.cwd, p.sessions.map((s) => s.title)])).toEqual([
      ['/work/app', ['Sesión 1', 'Sesión 3']],
      ['/b', ['Sesión 2']],
      ['/c', ['Sesión 4']],
    ])
  })

  it('no repite una sesión (mismo proveedor y ficha) ni mezcla carpetas sin cwd con las demás', () => {
    const a = hs(1)
    const merged = mergeProjects([groupByCwd([a]), groupByCwd([a, hs(2, { cwd: undefined })])])
    expect(countSessions(merged)).toBe(2)
    expect(merged.map((p) => p.cwd)).toEqual(['/work/app', null])
  })

  it('trata C:\\Work\\App y c:/work/app/ como la misma carpeta de Windows', () => {
    expect(normalizeCwd('C:\\Work\\App')).toBe(normalizeCwd('c:/work/app/'))
    const merged = mergeProjects([
      [{ cwd: 'C:\\Work\\App', name: 'App', sessions: [hs(1)] }],
      [{ cwd: 'c:/work/app/', name: 'app', sessions: [hs(2)] }],
    ])
    expect(merged).toHaveLength(1)
  })
})

describe('filterProjects y capSessions', () => {
  const projects = groupByCwd([
    hs(1, { title: 'Árbol de módulos' }),
    hs(2, { title: 'Otra' }),
    hs(3, { cwd: '/work/arbol', title: 'Z' }),
  ])
  it('busca sin acentos ni mayúsculas en título, nombre y carpeta', () => {
    expect(filterProjects(projects, 'ARBOL').map((p) => countSessions([p]))).toEqual([1, 1])
    expect(filterProjects(projects, '')).toEqual(projects)
    expect(filterProjects(projects, '   ')).toEqual(projects)
    expect(filterProjects(projects, 'zzz')).toEqual([])
  })
  it('una carpeta que coincide muestra todas sus sesiones', () => {
    expect(countSessions(filterProjects(projects, 'app'))).toBe(2)
  })
  it('capSessions corta por sesiones sin dejar carpetas vacías', () => {
    const capped = capSessions(projects, 2)
    expect(countSessions(capped)).toBe(2)
    expect(capSessions(projects, 0)).toEqual([])
    expect(capSessions(projects, -5)).toEqual([])
    expect(capSessions(projects, 99)).toEqual(projects)
  })
})

describe('formato y bloques', () => {
  it('título nunca vacío y avisos por estado', () => {
    expect(sessionTitle({ title: undefined })).toBe('Sesión sin título')
    expect(sessionTitle({ title: '   ' })).toBe('Sesión sin título')
    expect(sessionTitle({ title: ' hola ' })).toBe('hola')
    const name = (p: string) => p.toUpperCase()
    expect(providerNotice({ provider: 'a', status: 'ok' }, name)).toBeUndefined()
    expect(providerNotice({ provider: 'a', status: 'unsupported' }, name)).toBe(
      'A no tiene historial.',
    )
    expect(providerNotice({ provider: 'a', status: 'error', reason: 'x' }, name)).toBe(
      'A falló al listar: x.',
    )
  })

  it('fecha local válida o «?»', () => {
    expect(formatLocalWhen(0)).toMatch(/^19(69|70)-/)
    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 8.64e15 + 1]) {
      expect(formatLocalWhen(bad)).toBe('?')
    }
  })

  it('toBlock conserva el contenido y pone la identidad; mergeBlocks ordena y no repite', () => {
    const b = toBlock(userBlock(7, 'hola'))
    expect(b).toMatchObject({
      type: 'user',
      text: 'hola',
      index: 7,
      turn: 1,
      id: historyBlockId(7),
    })
    expect(toBlock(hblock(0, { type: 'text', text: 'x', complete: false }))).toMatchObject({ complete: true })
    const merged = mergeBlocks([
      [userBlock(2, 'c'), userBlock(0, 'a')],
      [userBlock(1, 'b'), userBlock(2, 'otra vez')],
    ])
    expect(merged.map((x) => x.index)).toEqual([0, 1, 2])
    expect((merged[2]?.block as { text: string }).text).toBe('c')
    expect(hblock(0, { type: 'user', text: '' }).index).toBe(0)
  })
})

// ---- propiedades ----

const sessionArb = fc
  .record({
    n: fc.integer({ min: 0, max: 40 }),
    cwd: fc.option(fc.constantFrom('/a', '/b', '/c/d', 'C:\\W\\X', 'c:/w/x/'), { nil: undefined }),
    provider: fc.constantFrom('fake', 'codex'),
    title: fc.option(fc.string({ maxLength: 12 }), { nil: undefined }),
  })
  .map(({ n, cwd, provider, title }) =>
    hs(n, {
      cwd,
      provider,
      ...(title === undefined ? { title: undefined } : { title }),
    } as Partial<HistorySession>),
  )

const pagesArb = fc.array(fc.array(sessionArb, { maxLength: 8 }).map(groupByCwd), { maxLength: 5 })

describe('propiedades (fast-check)', () => {
  it('mergeProjects: sin repetidos, nada se pierde y el orden relativo se conserva', () => {
    fc.assert(
      fc.property(pagesArb, (pages) => {
        const merged = mergeProjects(pages)
        const key = (s: HistorySession) => `${s.provider}|${s.sessionId}`
        const out = merged.flatMap((p) => p.sessions.map(key))
        expect(new Set(out).size).toBe(out.length)
        const input = new Set(pages.flatMap((pg) => pg.flatMap((p) => p.sessions.map(key))))
        expect(new Set(out)).toEqual(input)
        for (const p of merged) expect(p.sessions.length).toBeGreaterThan(0)
        // Idempotente.
        expect(mergeProjects([merged])).toEqual(merged)
      }),
    )
  })

  it('filterProjects: subconjunto, vacío = identidad y la búsqueda se puede encadenar', () => {
    fc.assert(
      fc.property(pagesArb, fc.string({ maxLength: 4 }), (pages, q) => {
        const merged: HistoryProject[] = mergeProjects(pages)
        const f = filterProjects(merged, q)
        expect(countSessions(f)).toBeLessThanOrEqual(countSessions(merged))
        expect(filterProjects(f, q)).toEqual(f)
        expect(filterProjects(merged, '')).toEqual(merged)
      }),
    )
  })

  it('capSessions: exactamente min(max, total) sesiones y es un prefijo', () => {
    fc.assert(
      fc.property(pagesArb, fc.integer({ min: -3, max: 60 }), (pages, max) => {
        const merged = mergeProjects(pages)
        const capped = capSessions(merged, max)
        expect(countSessions(capped)).toBe(Math.min(Math.max(0, max), countSessions(merged)))
        const flat = (ps: HistoryProject[]) =>
          ps.flatMap((p) => p.sessions.map((s) => s.sessionId + s.provider))
        expect(flat(capped)).toEqual(flat(merged).slice(0, flat(capped).length))
      }),
    )
  })

  it('formatLocalWhen y sessionTitle nunca devuelven NaN ni vacío', () => {
    fc.assert(
      fc.property(
        fc.double({ noNaN: false }),
        fc.option(fc.string(), { nil: undefined }),
        (ms, title) => {
          expect(formatLocalWhen(ms)).not.toContain('NaN')
          expect(sessionTitle({ title }).length).toBeGreaterThan(0)
        },
      ),
    )
  })
})
