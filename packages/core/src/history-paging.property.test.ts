import type { HistorySession } from '@nexo/contracts'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  orderHistory,
  pageHistory,
  projectKeyOf,
} from './history-paging.ts'

const arbSession: fc.Arbitrary<HistorySession> = fc.record({
  provider: fc.constantFrom('claude', 'codex', 'gemini'),
  sessionId: fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,20}$/),
  cwd: fc.option(
    fc.constantFrom('/w/a', '/w/b', '/w/c/d', 'C:\\Work\\App', 'c:/work/app/', '/W/A'),
    { nil: undefined },
  ),
  updatedAt: fc.integer({ min: 0, max: 2_000_000_000_000 }),
  resumable: fc.boolean(),
  readable: fc.boolean(),
})

const uniq = (list: HistorySession[]): HistorySession[] => {
  const seen = new Set<string>()
  return list.filter((s) => {
    const k = `${s.provider}|${s.sessionId}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

describe('historial (propiedades)', () => {
  it('las páginas juntas son exactamente el orden total, sin repetir ni perder', () => {
    fc.assert(
      fc.property(
        fc.array(arbSession, { maxLength: 60 }).map(uniq),
        fc.integer({ min: 1, max: 12 }),
        (all, limit) => {
          const expected = orderHistory(all).map(
            (o) => `${o.session.provider}|${o.session.sessionId}`,
          )
          const got: string[] = []
          let cursor: string | null = null
          for (let guard = 0; guard < 100; guard++) {
            const key: ReturnType<typeof decodeHistoryCursor> =
              cursor === null ? undefined : decodeHistoryCursor(cursor)
            const page = pageHistory(all, { limit, ...(key === undefined ? {} : { cursor: key }) })
            for (const p of page.projects) {
              expect(p.sessions.length).toBeGreaterThan(0)
              for (const x of p.sessions) got.push(`${x.provider}|${x.sessionId}`)
            }
            cursor = page.nextCursor
            if (cursor === null) break
          }
          expect(got).toEqual(expected)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('cada página respeta el límite y agrupa solo sesiones de la misma carpeta', () => {
    fc.assert(
      fc.property(
        fc.array(arbSession, { maxLength: 40 }).map(uniq),
        fc.integer({ min: 1, max: 10 }),
        (all, limit) => {
          const page = pageHistory(all, { limit })
          expect(page.projects.flatMap((p) => p.sessions).length).toBeLessThanOrEqual(limit)
          for (const p of page.projects) {
            const keys = new Set(p.sessions.map((x) => projectKeyOf(x.cwd)))
            expect(keys.size).toBe(1)
          }
        },
      ),
      { numRuns: 200 },
    )
  })

  it('el cursor siempre da ida y vuelta y solo usa caracteres permitidos', () => {
    fc.assert(
      fc.property(
        fc.record({
          m: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
          h: fc.integer({ min: 0, max: 0xffffffff }),
          u: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
          p: fc.string({ minLength: 1, maxLength: 20 }),
          i: fc.string({ minLength: 1, maxLength: 60 }),
        }),
        (key) => {
          const text = encodeHistoryCursor(key)
          expect(text).toMatch(/^[A-Za-z0-9_-]+$/)
          expect(decodeHistoryCursor(text)).toEqual(key)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('decodificar texto cualquiera nunca lanza', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        const r = decodeHistoryCursor(text)
        expect(r === undefined || typeof r.m === 'number').toBe(true)
      }),
      { numRuns: 500 },
    )
  })
})
