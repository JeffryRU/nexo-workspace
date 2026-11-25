import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { safeHref } from './safe-url.ts'

describe('safeHref', () => {
  it('admite http, https y mailto absolutos', () => {
    expect(safeHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(safeHref('http://example.com')).toBe('http://example.com/')
    expect(safeHref('mailto:a@b.co')).toBe('mailto:a@b.co')
  })

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'java\u0000script:alert(1)',
    `${String.fromCharCode(0x200b)}javascript:alert(1)`,
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'blob:https://x/1',
    'ftp://x/y',
    '//evil.example/x',
    '/ruta/relativa',
    '#ancla',
    'relativo.html',
    'https://confiable.com@malo.com/',
    'https://u:p@host/',
    '',
    `https://x/${'a'.repeat(3000)}`,
  ])('rechaza %j', (url) => {
    expect(safeHref(url)).toBeUndefined()
  })

  it('propiedad: lo que devuelve siempre es http(s) o mailto, sea cual sea la entrada', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 60 }),
          fc.string({ unit: 'binary', maxLength: 60 }),
          fc
            .tuple(
              fc.constantFrom('javascript', 'JAVASCRIPT', 'data', 'http', 'https', 'mailto', 'x'),
              fc.string({ maxLength: 20 }),
            )
            .map(([scheme, rest]) => `${scheme}:${rest}`),
        ),
        (s) => {
          const out = safeHref(s)
          if (out === undefined) return
          expect(/^(https?|mailto):/.test(out)).toBe(true)
        },
      ),
      { numRuns: 500 },
    )
  })
})
