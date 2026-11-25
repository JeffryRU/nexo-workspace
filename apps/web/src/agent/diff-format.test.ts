import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { diffStats, MAX_DIFF_LINES, parseDiff } from './diff.ts'
import { formatCost, formatDuration, formatTokens, usageParts } from './format.ts'

describe('parseDiff', () => {
  it('clasifica cabeceras, hunks, adiciones, borrados y contexto', () => {
    const { lines, hidden } = parseDiff(
      'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n ctx\n-viejo\n+nuevo\n\\ No newline at end of file\n',
    )
    expect(hidden).toBe(0)
    expect(lines.map((l) => l.kind)).toEqual([
      'meta',
      'meta',
      'meta',
      'hunk',
      'ctx',
      'del',
      'add',
      'meta',
    ])
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1 })
  })

  it('dentro de un hunk, `--- x` y `+++ x` son borrado y adición', () => {
    const { lines } = parseDiff('@@ -1 +1 @@\n--- guion\n+++ mas\n')
    expect(lines.map((l) => l.kind)).toEqual(['hunk', 'del', 'add'])
  })

  it('CRLF y diff vacío', () => {
    expect(parseDiff('@@ @@\r\n+a\r\n').lines.map((l) => l.text)).toEqual(['@@ @@', '+a'])
    expect(parseDiff('').lines).toEqual([{ kind: 'meta', text: '' }])
  })

  it('acota las líneas que se pintan', () => {
    const patch = Array.from({ length: MAX_DIFF_LINES + 500 }, (_, i) => `+l${i}`).join('\n')
    const r = parseDiff(patch)
    expect(r.lines).toHaveLength(MAX_DIFF_LINES)
    expect(r.hidden).toBe(500)
  })

  it('propiedad: nunca lanza y cada línea conserva su texto', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (s) => {
        const r = parseDiff(s)
        expect(r.lines.length).toBeLessThanOrEqual(MAX_DIFF_LINES)
        for (const l of r.lines) expect(['add', 'del', 'ctx', 'hunk', 'meta']).toContain(l.kind)
      }),
    )
  })
})

describe('formato de métricas', () => {
  it('tokens, costo y duración', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(1234)).toBe('1,2 k')
    expect(formatTokens(2_500_000)).toBe('2,5 M')
    expect(formatCost(0)).toBe('$0')
    expect(formatCost(0.00456)).toBe('$0.0046')
    expect(formatCost(1.234)).toBe('$1.23')
    expect(formatDuration(850)).toBe('850 ms')
    expect(formatDuration(2500)).toBe('2,5 s')
    expect(formatDuration(125_000)).toBe('2 min 5 s')
  })

  it('usageParts omite lo que no viene y suma la caché', () => {
    const labels = { input: 'in', output: 'out', cache: 'caché' }
    expect(usageParts({}, labels)).toEqual([])
    expect(
      usageParts(
        {
          inputTokens: 10,
          outputTokens: 2000,
          cacheReadTokens: 5,
          cacheWriteTokens: 1000,
          costUsd: 0.5,
        },
        labels,
      ),
    ).toEqual(['in 10', 'out 2 k', 'caché 1 k', '$0.50'])
  })
})
