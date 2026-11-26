import { LIMITS } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { fsApi } from './fs-api.ts'

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes))

function fake(pages: { data: number[]; eof: boolean; mtimeMs?: number }[]) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const api = fsApi({
    call: (async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'fs.stat') return { path: params.path, kind: 'file', size: 1, mtimeMs: 1 }
      const page = pages.shift()
      if (page === undefined) throw new Error('sin más páginas')
      return {
        path: '/w/a.bin',
        size: 5,
        mtimeMs: page.mtimeMs ?? 9,
        type: 'binary',
        mime: 'application/octet-stream',
        offset: params.offset,
        length: page.data.length,
        encoding: 'base64',
        data: b64(page.data),
        eof: page.eof,
      }
    }) as never,
  })
  return { api, calls }
}

describe('fsApi', () => {
  it('stat y read son envoltorios de fs.stat y fs.read', async () => {
    const { api, calls } = fake([{ data: [1], eof: true }])
    await api.stat('/w/a')
    await api.read({ path: '/w/a', offset: 2 })
    expect(calls.map((c) => c.method)).toEqual(['fs.stat', 'fs.read'])
    expect(calls[0]?.params).toEqual({ path: '/w/a' })
  })

  it('readAll junta los trozos pidiendo base64 y fijando el mtime del primero', async () => {
    const { api, calls } = fake([
      { data: [1, 2], eof: false },
      { data: [3, 4, 5], eof: true },
    ])
    const file = await api.readAll('/w/a.bin')
    expect([...file.bytes]).toEqual([1, 2, 3, 4, 5])
    expect([file.truncated, file.type, file.size]).toEqual([false, 'binary', 5])
    expect(calls[0]?.params).toMatchObject({
      offset: 0,
      encoding: 'base64',
      length: LIMITS.maxFsChunkBytes,
    })
    expect(calls[1]?.params).toMatchObject({ offset: 2, expectMtimeMs: 9 })
  })

  it('maxBytes corta y lo marca; un trozo vacío sin eof no cuelga', async () => {
    const cut = fake([{ data: [1, 2, 3], eof: false }])
    const file = await cut.api.readAll('/w/a.bin', { maxBytes: 3 })
    expect([file.truncated, file.bytes.length]).toEqual([true, 3])
    expect(cut.calls[0]?.params).toMatchObject({ length: 3 })
    const stuck = fake([{ data: [], eof: false }])
    expect((await stuck.api.readAll('/w/a.bin')).bytes.length).toBe(0)
  })

  it('un error del daemon se propaga', async () => {
    const { api } = fake([])
    await expect(api.readAll('/w/a.bin')).rejects.toThrow('sin más páginas')
  })
})
