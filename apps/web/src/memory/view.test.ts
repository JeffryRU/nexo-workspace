import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { blocks } from '../agent/test-helpers.ts'
import {
  blockPlainText,
  formatCost,
  formatTokens,
  formatWhen,
  locateBlock,
  rangeLabel,
  totalUsage,
} from './view.ts'

describe('formato de la vista de memoria', () => {
  it('costo: céntimos con cuatro decimales, el resto con dos; nunca NaN', () => {
    expect(formatCost(0)).toBe('$0.00')
    expect(formatCost(0.0042)).toBe('$0.0042')
    expect(formatCost(1.234)).toBe('$1.23')
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(formatCost(bad)).toMatch(/^\$/)
      expect(formatCost(bad)).not.toContain('NaN')
    }
  })

  it('tokens: enteros por debajo de mil y «k» después', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(1500)).toBe('1,5 k')
    expect(formatTokens(-4)).toBe('0')
    expect(formatTokens(Number.NaN)).toBe('0')
  })

  it('rango y fecha', () => {
    expect(rangeLabel({ from: 5, to: 5 })).toBe('bloque 5')
    expect(rangeLabel({ from: 5, to: 9 })).toBe('bloques 5 a 9')
    expect(formatWhen(0)).toBe('1970-01-01 00:00 UTC')
    expect(formatWhen(Number.NaN)).toBe('?')
    expect(formatWhen(8.64e15 + 1)).toBe('?')
  })

  it('totalUsage suma campo a campo', () => {
    const a = { calls: 1, inputTokens: 10, outputTokens: 2, costUsd: 0.5 }
    expect(totalUsage(a, a)).toEqual({ calls: 2, inputTokens: 20, outputTokens: 4, costUsd: 1 })
  })

  it('blockPlainText devuelve texto plano de cada tipo y nada para los que no tienen', () => {
    expect(blockPlainText(blocks.user(0, 'hola'))).toEqual({ label: 'usuario', text: 'hola' })
    expect(blockPlainText(blocks.text(1, '**x**'))).toEqual({ label: 'agente', text: '**x**' })
    expect(blockPlainText(blocks.action(2, { title: 'ls', output: 'a\nb' }))).toEqual({
      label: 'acción',
      text: 'ls\na\nb',
    })
    expect(blockPlainText(blocks.error(3)).text).toBe('algo falló')
    expect(blockPlainText(blocks.usage(4))).toEqual({ label: 'usage', text: '' })
  })
})

describe('locateBlock', () => {
  it('encuentra el primer bloque del rango o el siguiente si ya no está', () => {
    expect(locateBlock([0, 1, 2, 3, 4], { from: 2, to: 3 })).toBe(2)
    expect(locateBlock([0, 1, 5, 6], { from: 2, to: 3 })).toBe(2)
    expect(locateBlock([0, 1], { from: 2, to: 3 })).toBeUndefined()
    expect(locateBlock([], { from: 0, to: 0 })).toBeUndefined()
    expect(locateBlock([undefined, undefined, 4], { from: 1, to: 2 })).toBe(2)
  })

  it('propiedad: el resultado es el primer índice con block >= from', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: 5000 }), { maxLength: 60 }),
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 50 }),
        (set, from, extra) => {
          const indexes = [...set].sort((a, b) => a - b)
          const at = locateBlock(indexes, { from, to: from + extra })
          if (at === undefined) {
            expect(indexes.every((i) => i < from)).toBe(true)
            return
          }
          expect(indexes[at] ?? -1).toBeGreaterThanOrEqual(from)
          expect(indexes.slice(0, at).every((i) => i < from)).toBe(true)
        },
      ),
    )
  })
})
