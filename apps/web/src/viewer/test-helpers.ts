import { vi } from 'vitest'
import type { FakeClient } from '../test-helpers.ts'

export type FakeFile = {
  type: 'markdown' | 'text' | 'png' | 'jpeg' | 'gif' | 'webp' | 'svg' | 'pdf' | 'binary'
  mime?: string
  bytes: Uint8Array
  mtimeMs?: number
  /** Tope de lectura que anuncia `fs.stat`. */
  maxBytes?: number
  /** Tamaño que anuncia `fs.stat` (por omisión, el de los bytes). */
  size?: number
}

export const enc = (text: string): Uint8Array => new TextEncoder().encode(text)

const MIME: Record<FakeFile['type'], string> = {
  markdown: 'text/markdown',
  text: 'text/plain',
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  binary: 'application/octet-stream',
}

/** Un `fs.stat` y un `fs.read` falsos sobre un mapa de archivos (rutas absolutas); lo demás es `NOT_FOUND`. */
export function installFs(client: FakeClient, files: Map<string, FakeFile>): void {
  const find = (path: string) => {
    const f = files.get(path)
    if (f === undefined) throw Object.assign(new Error(`no existe: ${path}`), { code: 'NOT_FOUND' })
    return f
  }
  client.handlers.set('fs.stat', (params) => {
    const path = (params as { path: string }).path
    const f = find(path)
    const size = f.size ?? f.bytes.length
    const maxBytes = f.maxBytes ?? 8 * 1024 * 1024
    return {
      path,
      kind: 'file',
      size,
      mtimeMs: f.mtimeMs ?? 1000,
      type: f.type,
      mime: f.mime ?? MIME[f.type],
      maxBytes,
      tooLarge: size > maxBytes,
    }
  })
  client.handlers.set('fs.read', (params) => {
    const {
      path,
      offset = 0,
      length = 512 * 1024,
    } = params as {
      path: string
      offset?: number
      length?: number
    }
    const f = find(path)
    const part = f.bytes.slice(offset, offset + length)
    return {
      path,
      size: f.bytes.length,
      mtimeMs: f.mtimeMs ?? 1000,
      type: f.type,
      mime: f.mime ?? MIME[f.type],
      offset,
      length: part.length,
      encoding: 'base64',
      data: Buffer.from(part).toString('base64'),
      eof: offset + part.length >= f.bytes.length,
    }
  })
}

/** jsdom no trae `URL.createObjectURL`: lo cambia por uno que anota los `Blob` y devuelve `blob:fake-N`. */
export function stubBlobUrls() {
  const blobs = new Map<string, Blob>()
  const revoked: string[] = []
  let n = 0
  const create = vi.fn((blob: Blob) => {
    const url = `blob:fake-${++n}`
    blobs.set(url, blob)
    return url
  })
  const revoke = vi.fn((url: string) => void revoked.push(url))
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
  URL.createObjectURL = create as unknown as typeof URL.createObjectURL
  URL.revokeObjectURL = revoke
  return {
    blobs,
    revoked,
    create,
    restore() {
      URL.createObjectURL = original.create
      URL.revokeObjectURL = original.revoke
    },
  }
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

/** Espera (hasta ~2 s) a que `check` devuelva algo distinto de `null`/`undefined`/`false`. */
export async function until<T>(check: () => T | null | undefined | false): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = check()
    if (v !== null && v !== undefined && v !== false) return v
    await tick(10)
  }
  throw new Error('until: no se cumplió a tiempo')
}
