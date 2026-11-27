import { describe, expect, it } from 'vitest'
import {
  basename,
  classifyHref,
  dirname,
  isAbsolutePath,
  normalizeAbsolute,
  resolveLocalPath,
} from './paths.ts'

describe('normalizeAbsolute', () => {
  it('quita . y .. y dobles barras', () => {
    expect(normalizeAbsolute('/a/./b/../c//d')).toBe('/a/c/d')
    expect(normalizeAbsolute('/')).toBe('/')
    expect(normalizeAbsolute('C:\\a\\..\\b')).toBe('C:\\b')
    expect(normalizeAbsolute('C:/a/b/../c')).toBe('C:/a/c')
  })

  it('rechaza lo no absoluto, los controles y salir de la raíz', () => {
    for (const bad of ['', 'a/b', '//host/x', '/a/../..', 'C:\\..\\x', '/a\u0000b', '/a\nb']) {
      expect(normalizeAbsolute(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })

  it('en Windows un componente con ":" (flujo alternativo) se rechaza', () => {
    expect(normalizeAbsolute('C:\\a\\b.txt:secreto')).toBeUndefined()
  })
})

describe('isAbsolutePath, dirname y basename', () => {
  it('reconoce rutas absolutas de ambos estilos', () => {
    expect(isAbsolutePath('/x')).toBe(true)
    expect(isAbsolutePath('C:\\x')).toBe(true)
    expect(isAbsolutePath('//x')).toBe(false)
    expect(isAbsolutePath('x/y')).toBe(false)
  })

  it('dirname y basename', () => {
    expect(dirname('/work/docs/a.md')).toBe('/work/docs')
    expect(dirname('/a.md')).toBe('/')
    expect(dirname('C:\\work\\a.md')).toBe('C:\\work')
    expect(dirname('C:\\a.md')).toBe('C:\\')
    expect(dirname('relativa')).toBeUndefined()
    expect(basename('/work/docs/a.md')).toBe('a.md')
    expect(basename('C:\\work\\a.md')).toBe('a.md')
  })
})

describe('resolveLocalPath', () => {
  it('resuelve relativos contra la carpeta base', () => {
    expect(resolveLocalPath('/work/docs', 'img/a.png')).toBe('/work/docs/img/a.png')
    expect(resolveLocalPath('/work/docs', '../LEEME.md')).toBe('/work/LEEME.md')
    expect(resolveLocalPath('C:\\work\\docs', 'img\\a.png')).toBe('C:\\work\\docs\\img\\a.png')
    expect(resolveLocalPath('C:\\work\\docs', '../x.md')).toBe('C:\\work\\x.md')
  })

  it('las absolutas ignoran la base', () => {
    expect(resolveLocalPath('/work', '/otra/x.md')).toBe('/otra/x.md')
    expect(resolveLocalPath(undefined, '/otra/x.md')).toBe('/otra/x.md')
  })

  it('sin base, o con una base no absoluta, no hay resolución', () => {
    expect(resolveLocalPath(undefined, 'x.md')).toBeUndefined()
    expect(resolveLocalPath('relativa', 'x.md')).toBeUndefined()
  })

  it('un ".." que sale de la raíz no se resuelve', () => {
    expect(resolveLocalPath('/work', '../../../etc/passwd')).toBeUndefined()
  })
})

describe('classifyHref', () => {
  const base = '/work/docs'

  it('http(s) y mailto son externos', () => {
    expect(classifyHref('https://example.com/a', base)).toEqual({
      kind: 'external',
      url: 'https://example.com/a',
    })
    expect(classifyHref('mailto:a@b.co', base).kind).toBe('external')
  })

  it('las rutas son archivos locales; se quitan ?consulta y #ancla y se decodifica %', () => {
    expect(classifyHref('guia.md', base)).toEqual({ kind: 'file', path: '/work/docs/guia.md' })
    expect(classifyHref('./a%20b.md#sec', base)).toEqual({
      kind: 'file',
      path: '/work/docs/a b.md',
    })
    expect(classifyHref('../x.md?v=1', base)).toEqual({ kind: 'file', path: '/work/x.md' })
    expect(classifyHref('/abs/x.md', base)).toEqual({ kind: 'file', path: '/abs/x.md' })
    expect(classifyHref('C:\\w\\x.md', undefined)).toEqual({ kind: 'file', path: 'C:\\w\\x.md' })
  })

  it('#ancla es un ancla', () => {
    expect(classifyHref('#titulo', base)).toEqual({ kind: 'anchor' })
  })

  it('el resto se bloquea', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      'vbscript:x',
      '//evil.com/x',
      '\\\\srv\\share\\x',
      '',
      '../../../../etc/passwd',
      'a%00b.md',
      '%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
      'x%zz',
    ]) {
      expect(classifyHref(bad, base).kind, JSON.stringify(bad)).toBe('blocked')
    }
  })

  it('sin carpeta base, un relativo se bloquea', () => {
    expect(classifyHref('x.md', undefined).kind).toBe('blocked')
  })
})
