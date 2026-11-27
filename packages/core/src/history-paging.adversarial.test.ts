import type { HistorySession } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { decodeHistoryCursor, pageHistory } from './history-paging.ts'

const noControl = (v: string): boolean => !Array.from(v).some((c) => c.charCodeAt(0) < 0x20)

describe('historial: cursores y datos hostiles', () => {
  it('rechaza cursores mal formados sin lanzar', () => {
    const hostile = [
      '',
      'h1',
      'h1-1-2-3-a',
      'h1-1-2-3-a-b-c',
      'h2-1-2-3-a-b',
      'h1--2-3-a-b',
      'h1-1-2-3-%zz-b',
      'h1-1-2-3-_ZZ-b',
      'h1-1-2-3-_-b',
      'h1-99999999999999999999-2-3-a-b',
      'h1-1-4294967296-3-a-b',
      'h1-1.5-2-3-a-b',
      '__proto__',
      'h1-1-2-3-_C3-b',
      'x'.repeat(5000),
    ]
    for (const c of hostile) {
      expect(() => decodeHistoryCursor(c), c).not.toThrow()
      expect(decodeHistoryCursor(c), c).toBeUndefined()
    }
  })

  it('una carpeta con caracteres de control no rompe la página', () => {
    const sessions: HistorySession[] = [
      {
        provider: 'p',
        sessionId: 'a',
        cwd: '/w/\u0000\u001b[31m',
        updatedAt: 1,
        resumable: true,
        readable: true,
      },
      {
        provider: 'p',
        sessionId: 'b',
        cwd: '..\\..\\..',
        updatedAt: 2,
        resumable: true,
        readable: true,
      },
    ]
    const page = pageHistory(sessions, { limit: 10 })
    expect(page.projects.flatMap((p) => p.sessions)).toHaveLength(2)
    for (const p of page.projects) expect(p.name).toSatisfy(noControl)
  })

  it('miles de sesiones se paginan sin pasarse del límite', () => {
    const many: HistorySession[] = Array.from({ length: 3000 }, (_, i) => ({
      provider: 'p',
      sessionId: `s${i}`,
      cwd: `/w/${i % 50}`,
      updatedAt: i,
      resumable: true,
      readable: true,
    }))
    const page = pageHistory(many, { limit: 100000 })
    expect(page.projects.flatMap((p) => p.sessions).length).toBeLessThanOrEqual(100)
    expect(page.nextCursor).not.toBeNull()
  })
})
