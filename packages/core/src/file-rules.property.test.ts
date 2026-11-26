import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  checkPathSyntax,
  detectFileType,
  isSensitivePath,
  isValidUtf8,
  isWithin,
  pathSegments,
  utf8SafeLength,
} from './file-rules.ts'
import { utf8Bytes } from './test-helpers.ts'

const segment = fc.stringMatching(/^[A-Za-z0-9_\-ñé日]{1,12}$/)
const segments = fc.array(segment, { minLength: 1, maxLength: 6 })
const hasControl = (s: string) =>
  Array.from(s).some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)

describe('checkPathSyntax (propiedades)', () => {
  it('nunca lanza, sea cual sea la cadena', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', maxLength: 200 }),
        fc.constantFrom('posix' as const, 'win32' as const),
        (p, platform) => {
          const r = checkPathSyntax(p, platform)
          expect(r === undefined || typeof r === 'string').toBe(true)
        },
      ),
      { numRuns: 500 },
    )
  })

  it('una ruta aceptada nunca tiene un segmento `..`, bytes nulos ni controles', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', maxLength: 120 }),
        fc.constantFrom('posix' as const, 'win32' as const),
        (p, platform) => {
          if (checkPathSyntax(p, platform) !== undefined) return
          expect(pathSegments(p, platform)).not.toContain('..')
          expect(hasControl(p)).toBe(false)
          if (platform === 'win32') {
            expect(/^[A-Za-z]:[\\/]/.test(p)).toBe(true)
            expect(/^[\\/]{2}/.test(p)).toBe(false)
          } else expect(p.startsWith('/')).toBe(true)
        },
      ),
      { numRuns: 1000 },
    )
  })

  it('las rutas bien formadas se aceptan y cualquier `..` insertado las rompe', () => {
    fc.assert(
      fc.property(segments, fc.nat(5), (segs, at) => {
        // Los nombres de dispositivo de Windows (CON, NUL...) se rechazan a propósito.
        if (segs.some((s) => /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s))) return
        expect(checkPathSyntax(`/${segs.join('/')}`, 'posix')).toBeUndefined()
        expect(checkPathSyntax(`C:\\${segs.join('\\')}`, 'win32')).toBeUndefined()
        const bad = segs.slice()
        bad.splice(Math.min(at, bad.length), 0, '..')
        expect(checkPathSyntax(`/${bad.join('/')}`, 'posix')).toBeDefined()
        expect(checkPathSyntax(`C:\\${bad.join('\\')}`, 'win32')).toBeDefined()
      }),
    )
  })
})

describe('isWithin / isSensitivePath (propiedades)', () => {
  it('una ruta está dentro de cualquiera de sus prefijos y de ningún sibling', () => {
    fc.assert(
      fc.property(segments, fc.nat(5), segment, (segs, cut, extra) => {
        const root = segs.slice(0, Math.min(cut, segs.length))
        expect(isWithin(root, segs, false)).toBe(true)
        expect(isWithin([...segs, extra], segs, false)).toBe(false)
        const last = segs.at(-1) as string
        expect(isWithin([...segs.slice(0, -1), `${last}x`], segs, false)).toBe(false)
      }),
    )
  })

  it('una carpeta sensible, en cualquier posición y con cualquier caja, bloquea la ruta', () => {
    fc.assert(
      fc.property(
        segments,
        segments,
        fc.constantFrom('.ssh', '.gnupg', '.aws', '.claude', '.codex', '.git', '.kube'),
        fc.boolean(),
        (before, after, dir, upper) => {
          const d = upper ? dir.toUpperCase() : dir
          expect(isSensitivePath([...before, d, ...after])).toBe(true)
        },
      ),
    )
  })

  it('las rutas formadas solo con nombres inocentes no se bloquean', () => {
    fc.assert(
      fc.property(segments, (segs) => {
        expect(isSensitivePath(segs.map((s) => `x${s}`))).toBe(false)
      }),
    )
  })
})

describe('UTF-8 y tipo (propiedades)', () => {
  it('utf8SafeLength corta en un límite: el prefijo es válido y sobran menos de 4 bytes', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 60 }), fc.nat(200), (text, cut) => {
        const all = utf8Bytes(text)
        const chunk = all.subarray(0, Math.min(cut, all.length))
        const keep = utf8SafeLength(chunk, false)
        expect(isValidUtf8(chunk.subarray(0, keep))).toBe(true)
        expect(chunk.length - keep).toBeLessThan(4)
      }),
    )
  })

  it('detectFileType nunca lanza y devuelve un tipo conocido', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 300 }),
        fc.string({ maxLength: 20 }),
        fc.boolean(),
        (data, name, complete) => {
          const { type, mime } = detectFileType(data, name, complete)
          expect([
            'markdown',
            'text',
            'png',
            'jpeg',
            'gif',
            'webp',
            'svg',
            'pdf',
            'binary',
          ]).toContain(type)
          expect(mime.length).toBeGreaterThan(0)
        },
      ),
      { numRuns: 500 },
    )
  })

  it('el texto UTF-8 válido sin controles ni firmas es siempre texto', () => {
    const plain = (s: string) =>
      !Array.from(s).some((c) => {
        const n = c.charCodeAt(0)
        return n < 9 || n === 11 || (n > 13 && n < 27) || (n > 27 && n < 32)
      }) && !/^(%PDF-|GIF8|RIFF)/.test(s)
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 80 }).filter(plain), (text) => {
        expect(detectFileType(utf8Bytes(text), 'a.txt', true).type).toBe('text')
      }),
    )
  })
})
