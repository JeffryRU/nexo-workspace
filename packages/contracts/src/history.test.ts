import { describe, expect, it } from 'vitest'
import {
  HistoryBlock,
  HistoryCursor,
  HistoryProject,
  HistorySession,
  historyMethods,
} from './history.ts'
import { LIMITS } from './limits.ts'

const session = {
  provider: 'claude',
  sessionId: 'c7d1-22',
  updatedAt: 1000,
  resumable: true,
  readable: true,
}

describe('contratos del historial', () => {
  it('HistorySession exige proveedor, ficha, fecha y capacidades; rechaza claves extra', () => {
    expect(HistorySession.safeParse(session).success).toBe(true)
    expect(HistorySession.safeParse({ ...session, extra: 1 }).success).toBe(false)
    expect(HistorySession.safeParse({ ...session, sessionId: '../x' }).success).toBe(false)
    expect(HistorySession.safeParse({ ...session, sessionId: 'a b' }).success).toBe(false)
    expect(HistorySession.safeParse({ ...session, updatedAt: -1 }).success).toBe(false)
    expect(HistorySession.safeParse({ ...session, title: 'a\nb' }).success).toBe(false)
  })

  it('HistoryProject necesita al menos una sesión y admite cwd nulo', () => {
    expect(
      HistoryProject.safeParse({ cwd: null, name: 'sin carpeta', sessions: [session] }).success,
    ).toBe(true)
    expect(HistoryProject.safeParse({ cwd: '/a', name: 'a', sessions: [] }).success).toBe(false)
  })

  it('el cursor es base64url acotado', () => {
    expect(HistoryCursor.safeParse('eyJhIjoxfQ').success).toBe(true)
    expect(HistoryCursor.safeParse('a b').success).toBe(false)
    expect(HistoryCursor.safeParse('a'.repeat(LIMITS.maxHistoryCursorLength + 1)).success).toBe(
      false,
    )
  })

  it('HistoryBlock valida el bloque normalizado', () => {
    const ok = { index: 0, turn: 1, block: { type: 'user', text: 'hola' } }
    expect(HistoryBlock.safeParse(ok).success).toBe(true)
    expect(HistoryBlock.safeParse({ ...ok, block: { type: 'user', text: '' } }).success).toBe(false)
    expect(HistoryBlock.safeParse({ ...ok, block: { type: 'nada' } }).success).toBe(false)
  })

  it('los parámetros de los métodos acotan límite y rechazan claves extra', () => {
    const list = historyMethods['history.list'].params
    expect(list.safeParse({}).success).toBe(true)
    expect(list.safeParse({ limit: 0 }).success).toBe(false)
    expect(list.safeParse({ limit: LIMITS.maxHistoryPage + 1 }).success).toBe(false)
    expect(list.safeParse({ provider: 'Claude' }).success).toBe(false)
    expect(list.safeParse({ x: 1 }).success).toBe(false)
    const read = historyMethods['history.read'].params
    expect(read.safeParse({ provider: 'codex', sessionId: 'abc' }).success).toBe(true)
    expect(read.safeParse({ provider: 'codex' }).success).toBe(false)
    expect(read.safeParse({ provider: 'codex', sessionId: 'abc', limit: 101 }).success).toBe(false)
  })

  it('una página de bloques de tope cabe en un mensaje', () => {
    expect(LIMITS.maxHistoryBlockJsonBytes).toBeLessThan(LIMITS.maxMessageBytes)
  })
})
