import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { classifyHref, dirname, normalizeAbsolute, resolveLocalPath } from './paths.ts'

const name = fc.stringMatching(/^[a-zA-Z0-9_ -]{1,8}$/)
const segments = fc.array(fc.oneof(name, fc.constant('..'), fc.constant('.')), { maxLength: 12 })
const posixBase = fc.array(name, { maxLength: 5 }).map((a) => `/${a.join('/')}`)

const dotSegments = (path: string) => path.split(/[\\/]/).filter((s) => s === '.' || s === '..')
const hasControl = (text: string) =>
  [...text].some((c) => {
    const n = c.codePointAt(0) as number
    return n < 0x20 || (n >= 0x7f && n <= 0x9f)
  })

describe('propiedades de rutas del visor', () => {
  it('el resultado de resolver es absoluto, normalizado y sin ".."', () => {
    fc.assert(
      fc.property(posixBase, segments, (base, rel) => {
        const out = resolveLocalPath(base, rel.join('/'))
        if (out === undefined) return
        expect(out.startsWith('/')).toBe(true)
        expect(dotSegments(out)).toEqual([])
        expect(normalizeAbsolute(out)).toBe(out)
      }),
    )
  })

  it('sin ".." el resultado queda dentro de la base', () => {
    fc.assert(
      fc.property(posixBase, fc.array(name, { minLength: 1, maxLength: 6 }), (base, rel) => {
        const root = base === '/' ? '' : base
        expect(resolveLocalPath(base, rel.join('/'))).toBe(`${root}/${rel.join('/')}`)
      }),
    )
  })

  it('con ".." o se resuelve dentro de la raíz o se rechaza; nunca sube más de la cuenta', () => {
    fc.assert(
      fc.property(posixBase, fc.integer({ min: 0, max: 10 }), (base, ups) => {
        const depth = base.split('/').filter(Boolean).length
        const out = resolveLocalPath(base, `${'../'.repeat(ups)}x`)
        if (ups > depth) expect(out).toBeUndefined()
        else expect(out?.endsWith('/x')).toBe(true)
      }),
    )
  })

  it('dirname de base + nombre devuelve la base', () => {
    fc.assert(
      fc.property(posixBase, name, (base, file) => {
        const full = resolveLocalPath(base, file) as string
        expect(dirname(full)).toBe(base)
      }),
    )
  })

  it('classifyHref nunca lanza y un archivo local siempre es absoluto, sin ".." ni controles', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 120 }), (raw) => {
        const t = classifyHref(raw, '/work/docs')
        if (t.kind === 'file') {
          expect(t.path.startsWith('/')).toBe(true)
          expect(dotSegments(t.path)).toEqual([])
          expect(hasControl(t.path)).toBe(false)
        }
        if (t.kind === 'external') expect(/^(https?|mailto):/.test(t.url)).toBe(true)
      }),
      { numRuns: 500 },
    )
  })

  it('classifyHref: un esquema peligroso, con mayúsculas o controles intercalados, siempre se bloquea', () => {
    const scheme = fc.constantFrom('javascript', 'vbscript', 'data', 'file', 'blob')
    const junk = fc.constantFrom('', '\t', '\n', '\r', '\u0000', '​', ' ')
    fc.assert(
      fc.property(
        scheme,
        fc.array(junk, { minLength: 1, maxLength: 4 }),
        fc.boolean(),
        (s, j, up) => {
          const word = [...(up ? s.toUpperCase() : s)]
            .map((c, i) => c + (j[i % j.length] as string))
            .join('')
          expect(classifyHref(`${word}:alert(1)`, '/work').kind).toBe('blocked')
        },
      ),
    )
  })
})
