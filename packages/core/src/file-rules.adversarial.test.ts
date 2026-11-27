import { describe, expect, it } from 'vitest'
import {
  checkPathSyntax,
  detectFileType,
  isSensitivePath,
  looksLikeSvg,
  pathSegments,
} from './file-rules.ts'
import { utf8Bytes } from './test-helpers.ts'

describe('file-rules adversarial', () => {
  it('rutas de Windows disfrazadas con barras mezcladas y repetidas', () => {
    for (const p of [
      '\\/server/share',
      '/\\server\\share',
      '\\\\\\server\\share',
      '//?/UNC/server/share',
      '\\\\?\\UNC\\s\\x',
      '\\\\.\\pipe\\x',
      '\\\\?\\GLOBALROOT\\Device\\x',
    ]) {
      expect(checkPathSyntax(p, 'win32'), p).toBeDefined()
    }
    expect(checkPathSyntax('C:\\a\\\\b//c', 'win32')).toBeUndefined()
  })

  it('flujos de datos alternos de Windows', () => {
    for (const p of [
      'C:\\a\\b.txt:Zone.Identifier',
      'C:\\a\\b.txt::$INDEX_ALLOCATION',
      'C:\\a::$DATA\\b',
    ]) {
      expect(checkPathSyntax(p, 'win32'), p).toBeDefined()
    }
    expect(checkPathSyntax('C:\\a\\b.txt\\', 'win32')).toBeUndefined()
  })

  it('unicode y homoglifos no se confunden con la carpeta sensible real', () => {
    expect(isSensitivePath(['home', '.ssh'])).toBe(true)
    expect(isSensitivePath(['home', '.\u0455sh'])).toBe(false)
    expect(isSensitivePath(['home', '.ssh\u200b'])).toBe(false)
    expect(isSensitivePath(['\u00fcn\u00ef', '\u00f1.txt'])).toBe(false)
  })

  it('cadenas enormes o con miles de separadores terminan deprisa', () => {
    const started = Date.now()
    checkPathSyntax(`/${'a/'.repeat(1500)}`, 'posix')
    checkPathSyntax(`C:\\${'a\\'.repeat(1500)}`, 'win32')
    checkPathSyntax('/'.repeat(4000), 'posix')
    pathSegments('/'.repeat(100_000), 'posix')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('detectFileType aguanta muestras hostiles', () => {
    const started = Date.now()
    const evil = new Uint8Array(8192).fill(0x3c)
    expect(detectFileType(evil, 'a.svg', true).type).toBe('text')
    const comments = utf8Bytes('<!--'.repeat(2000))
    expect(detectFileType(comments, 'a.svg', true).type).toBe('text')
    expect(looksLikeSvg('<!DOCTYPE ['.repeat(1000))).toBe(false)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('un PDF con basura detrás sigue siendo PDF (la firma manda sobre la extensión)', () => {
    const pdf = Uint8Array.from([...utf8Bytes('%PDF-1.7\n'), 0, 0xff, 0xfe])
    expect(detectFileType(pdf, 'a.txt', true).type).toBe('pdf')
  })
})
