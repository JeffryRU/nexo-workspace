import { describe, expect, it } from 'vitest'
import {
  FILE_TYPES,
  FsReadParams,
  FsReadResult,
  FsStat,
  maxBytesForFileType,
  TEXT_FILE_TYPES,
} from './files.ts'
import { LIMITS } from './limits.ts'

describe('contratos de archivos', () => {
  it('cada tipo tiene un tope positivo y los de texto son los esperados', () => {
    for (const t of FILE_TYPES) expect(maxBytesForFileType(t)).toBeGreaterThan(0)
    expect(maxBytesForFileType('svg')).toBeLessThan(maxBytesForFileType('text'))
    expect(maxBytesForFileType('png')).toBe(LIMITS.maxFsImageBytes)
    expect(maxBytesForFileType('pdf')).toBe(LIMITS.maxFsPdfBytes)
    expect(maxBytesForFileType('binary')).toBe(LIMITS.maxFsBinaryBytes)
    expect(maxBytesForFileType('markdown')).toBe(LIMITS.maxFsTextBytes)
    expect([...TEXT_FILE_TYPES]).toEqual(['markdown', 'text', 'svg'])
  })

  it('un trozo en base64 cabe en un mensaje y uno de texto aun con escapes', () => {
    expect(Math.ceil((LIMITS.maxFsChunkBytes * 4) / 3)).toBeLessThan(LIMITS.maxMessageBytes)
    expect(LIMITS.maxFsTextChunkBytes * 6).toBeLessThan(LIMITS.maxMessageBytes)
  })

  it('FsReadParams valida rangos y rechaza claves extra', () => {
    expect(FsReadParams.safeParse({ path: '/a' }).success).toBe(true)
    expect(FsReadParams.safeParse({ path: '/a', offset: -1 }).success).toBe(false)
    expect(FsReadParams.safeParse({ path: '/a', length: 0 }).success).toBe(false)
    expect(FsReadParams.safeParse({ path: '/a', length: LIMITS.maxFsChunkBytes + 1 }).success).toBe(
      false,
    )
    expect(FsReadParams.safeParse({ path: '/a', encoding: 'latin1' }).success).toBe(false)
    expect(FsReadParams.safeParse({ path: '', offset: 0 }).success).toBe(false)
    expect(FsReadParams.safeParse({ path: '/a', extra: 1 }).success).toBe(false)
  })

  it('FsStat y FsReadResult validan la forma', () => {
    expect(FsStat.safeParse({ path: '/a', kind: 'directory', size: 0, mtimeMs: 1 }).success).toBe(
      true,
    )
    expect(FsStat.safeParse({ path: '/a', kind: 'link', size: 0, mtimeMs: 1 }).success).toBe(false)
    const ok = {
      path: '/a',
      size: 3,
      mtimeMs: 1.5,
      type: 'text',
      mime: 'text/plain',
      offset: 0,
      length: 3,
      encoding: 'utf8',
      data: 'abc',
      eof: true,
    }
    expect(FsReadResult.safeParse(ok).success).toBe(true)
    expect(FsReadResult.safeParse({ ...ok, type: 'exe' }).success).toBe(false)
    expect(FsReadResult.safeParse({ ...ok, mtimeMs: Number.NaN }).success).toBe(false)
  })
})
