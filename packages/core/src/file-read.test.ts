import { LIMITS } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { type FileCodec, type FileSource, readFileChunk, statFile } from './file-read.ts'
import { FileSystemError } from './ports/file-system.ts'
import { utf8Bytes } from './test-helpers.ts'

// Códec de pruebas: latin1 para el texto (las pruebas usan ASCII) y hexadecimal en lugar de base64.
const codec: FileCodec = {
  utf8: (b) => Array.from(b, (v) => String.fromCharCode(v)).join(''),
  base64: (b) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join(''),
}

function source(data: Uint8Array | string, name = 'a.txt', mtimeMs = 1, short = false): FileSource {
  const bytes = typeof data === 'string' ? utf8Bytes(data) : data
  return {
    path: `/w/${name}`,
    name,
    size: bytes.length,
    mtimeMs,
    read: async (offset, length) =>
      bytes.subarray(offset, offset + length).slice(0, short ? Math.max(0, length - 1) : length),
  }
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    return e instanceof FileSystemError ? e.code : String(e)
  }
  return 'OK'
}

describe('statFile', () => {
  it('describe tipo, tope y exceso; un archivo vacío es texto', async () => {
    expect(await statFile(source('# x', 'a.md'))).toMatchObject({
      kind: 'file',
      type: 'markdown',
      maxBytes: LIMITS.maxFsTextBytes,
      tooLarge: false,
    })
    expect((await statFile(source('', 'v.txt'))).type).toBe('text')
    const big = { ...source('x'), size: LIMITS.maxFsTextBytes + 1 }
    expect((await statFile(big)).tooLarge).toBe(true)
  })
})

describe('readFileChunk', () => {
  it('lee todo, por omisión en utf8 para texto', async () => {
    const r = await readFileChunk(source('hola'), { path: '/w/a.txt' }, codec)
    expect(r).toMatchObject({
      data: 'hola',
      encoding: 'utf8',
      offset: 0,
      length: 4,
      eof: true,
      type: 'text',
    })
  })

  it('un binario va en base64 y el texto puede pedirse en base64', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
    expect((await readFileChunk(source(png, 'a.png'), { path: 'x' }, codec)).encoding).toBe(
      'base64',
    )
    const t = await readFileChunk(source('AB'), { path: 'x', encoding: 'base64' }, codec)
    expect(t.data).toBe('4142')
  })

  it('utf8 sobre un binario no vale', async () => {
    const bin = Uint8Array.from([0, 1])
    expect(
      await code(readFileChunk(source(bin, 'a.bin'), { path: 'x', encoding: 'utf8' }, codec)),
    ).toBe('NOT_A_FILE')
  })

  it('offset: al final vacío, pasado el final inválido', async () => {
    const end = await readFileChunk(source('ab'), { path: 'x', offset: 2 }, codec)
    expect([end.length, end.data, end.eof]).toEqual([0, '', true])
    expect(await code(readFileChunk(source('ab'), { path: 'x', offset: 3 }, codec))).toBe(
      'INVALID_RANGE',
    )
  })

  it('el trozo utf8 no baja de 4 bytes y se recorta al límite de carácter', async () => {
    const euro = source('€€€', 'e.txt')
    const r = await readFileChunk(euro, { path: 'x', length: 1 }, codec)
    expect(r.length).toBe(3)
    expect(r.eof).toBe(false)
    expect(await code(readFileChunk(euro, { path: 'x', offset: 1 }, codec))).toBe('INVALID_RANGE')
  })

  it('respeta los topes de trozo y de archivo', async () => {
    const big = new Uint8Array(LIMITS.maxFsChunkBytes + 5).fill(0x61)
    const text = await readFileChunk(source(big), { path: 'x' }, codec)
    expect(text.length).toBe(LIMITS.maxFsTextChunkBytes)
    const b64 = await readFileChunk(source(big), { path: 'x', encoding: 'base64' }, codec)
    expect(b64.length).toBe(LIMITS.maxFsChunkBytes)
    const huge = { ...source('x'), size: LIMITS.maxFsTextBytes + 1 }
    expect(await code(readFileChunk(huge, { path: 'x' }, codec))).toBe('TOO_LARGE')
  })

  it('expectMtimeMs distinto es CONFLICT; igual, no', async () => {
    expect(
      await code(readFileChunk(source('a', 'a.txt', 5), { path: 'x', expectMtimeMs: 4 }, codec)),
    ).toBe('CONFLICT')
    expect(
      await code(readFileChunk(source('a', 'a.txt', 5), { path: 'x', expectMtimeMs: 5 }, codec)),
    ).toBe('OK')
  })

  it('un archivo que se acorta durante la lectura es CONFLICT', async () => {
    expect(
      await code(readFileChunk(source('abcdef', 'a.txt', 1, true), { path: 'x' }, codec)),
    ).toBe('CONFLICT')
  })
})
