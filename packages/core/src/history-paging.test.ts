import type { HistorySession } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  NO_FOLDER_NAME,
  orderHistory,
  pageHistory,
  projectDisplayName,
} from './history-paging.ts'

const s = (
  over: Partial<HistorySession> & { sessionId: string; updatedAt: number },
): HistorySession => ({
  provider: 'claude',
  resumable: true,
  readable: true,
  ...over,
})

const noControl = (v: string): boolean => !Array.from(v).some((c) => c.charCodeAt(0) < 0x20)

describe('orden y agrupado del historial', () => {
  it('ordena carpetas por su sesión más reciente y sesiones de más a menos reciente', () => {
    const all = [
      s({ sessionId: 'a1', cwd: '/w/a', updatedAt: 10 }),
      s({ sessionId: 'b1', cwd: '/w/b', updatedAt: 50 }),
      s({ sessionId: 'a2', cwd: '/w/a', updatedAt: 100 }),
      s({ sessionId: 'n1', updatedAt: 20 }),
    ]
    const page = pageHistory(all, { limit: 10 })
    expect(page.projects.map((p) => p.name)).toEqual(['a', 'b', NO_FOLDER_NAME])
    expect(page.projects[0]?.sessions.map((x) => x.sessionId)).toEqual(['a2', 'a1'])
    expect(page.projects[2]?.cwd).toBeNull()
    expect(page.nextCursor).toBeNull()
  })

  it('agrupa C:\\Work\\App y c:/work/app/ como la misma carpeta de Windows', () => {
    const page = pageHistory(
      [
        s({ sessionId: 'x', cwd: 'C:\\Work\\App', updatedAt: 2 }),
        s({ sessionId: 'y', cwd: 'c:/work/app/', updatedAt: 1 }),
      ],
      { limit: 10 },
    )
    expect(page.projects).toHaveLength(1)
  })

  it('pagina con cursor y sin repetir ni perder', () => {
    const all = Array.from({ length: 23 }, (_, i) =>
      s({ sessionId: `s${i}`, cwd: `/w/p${i % 4}`, updatedAt: 1000 + ((i * 7) % 23) }),
    )
    const seen: string[] = []
    let cursor: string | null = null
    for (let n = 0; n < 20; n++) {
      const key = cursor === null ? undefined : decodeHistoryCursor(cursor)
      const page = pageHistory(all, { limit: 5, ...(key === undefined ? {} : { cursor: key }) })
      for (const p of page.projects) for (const x of p.sessions) seen.push(x.sessionId)
      cursor = page.nextCursor
      if (cursor === null) break
    }
    expect(seen).toHaveLength(23)
    expect(new Set(seen).size).toBe(23)
    expect(seen).toEqual(orderHistory(all).map((o) => o.session.sessionId))
  })

  it('un cursor al final del orden devuelve una página vacía', () => {
    const all = [s({ sessionId: 'a', cwd: '/w', updatedAt: 5 })]
    const last = orderHistory(all)[0]?.key
    expect(last).toBeDefined()
    const page = pageHistory(all, { limit: 5, ...(last === undefined ? {} : { cursor: last }) })
    expect(page.projects).toEqual([])
    expect(page.nextCursor).toBeNull()
  })

  it('el nombre de carpeta se limpia de caracteres de control', () => {
    expect(projectDisplayName('/w/a\u0000b\nc')).toSatisfy(noControl)
    expect(projectDisplayName(null)).toBe(NO_FOLDER_NAME)
    expect(projectDisplayName('/')).toBe('/')
    expect(projectDisplayName(`/w/${'x'.repeat(2000)}`).length).toBeLessThanOrEqual(256)
  })
})

describe('cursor del historial', () => {
  it('ida y vuelta con ids de caracteres especiales', () => {
    for (const i of ['a-b_c', 'ñ/日本', 'x.y:z@1+2=', '-', '_', '%41']) {
      const key = { m: 5, h: 77, u: 4, p: 'codex', i }
      const text = encodeHistoryCursor(key)
      expect(text).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(decodeHistoryCursor(text)).toEqual(key)
    }
  })
})
