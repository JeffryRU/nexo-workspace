import { describe, expect, it } from 'vitest'
import { unifiedDiff } from '../src/diff.ts'

describe('unifiedDiff', () => {
  it('un cambio en medio, con contexto', () => {
    const patch = unifiedDiff(
      'a.ts',
      'uno\ndos\ntres\ncuatro\ncinco\n',
      'uno\ndos\nTRES\ncuatro\ncinco\n',
    )
    expect(patch).toBe(
      [
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1,5 +1,5 @@',
        ' uno',
        ' dos',
        '-tres',
        '+TRES',
        ' cuatro',
        ' cinco',
      ].join('\n'),
    )
  })

  it('archivo nuevo: desde /dev/null; las rutas absolutas no duplican la barra', () => {
    const patch = unifiedDiff('/p/n.txt', null, 'hola\nmundo\n')
    expect(patch).toBe(
      ['--- /dev/null', '+++ b/p/n.txt', '@@ -0,0 +1,2 @@', '+hola', '+mundo'].join('\n'),
    )
  })

  it('sin cambios no hay parche; vaciar un archivo borra todas las líneas', () => {
    expect(unifiedDiff('a', 'x\n', 'x\n')).toBe('')
    expect(unifiedDiff('a', null, '')).toBe('')
    expect(unifiedDiff('a', 'x\ny\n', '')).toContain('-x\n-y')
  })

  it('dos cambios lejanos dan dos bloques', () => {
    const old = Array.from({ length: 30 }, (_, i) => `l${i}`)
    const next = [...old]
    next[2] = 'A'
    next[27] = 'B'
    const patch = unifiedDiff('f', `${old.join('\n')}\n`, `${next.join('\n')}\n`)
    expect(patch.match(/^@@/gm)).toHaveLength(2)
  })

  it('una diferencia enorme no se calcula con LCS: se muestra como bloque reemplazado, sin colgarse', () => {
    const a = Array.from({ length: 5000 }, (_, i) => `a${i}`).join('\n')
    const b = Array.from({ length: 5000 }, (_, i) => `b${i}`).join('\n')
    const start = Date.now()
    const patch = unifiedDiff('f', `${a}\n`, `${b}\n`)
    expect(Date.now() - start).toBeLessThan(2000)
    expect(patch.split('\n').filter((l) => l.startsWith('-a')).length).toBe(5000)
    expect(patch.split('\n').filter((l) => l.startsWith('+b')).length).toBe(5000)
  })
})
