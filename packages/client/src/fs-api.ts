import { LIMITS, type MethodParams, type MethodResult } from '@nexo/contracts'
import type { CallOptions, NexoClient } from './client.ts'

type Caller = Pick<NexoClient, 'call'>

export type FsReadAllOptions = {
  /** Tope de bytes a leer (por omisión, el tope del tipo de archivo, que impone el daemon). */
  maxBytes?: number
  signal?: AbortSignal
}

export type FsFile = {
  path: string
  type: MethodResult<'fs.read'>['type']
  mime: string
  size: number
  mtimeMs: number
  bytes: Uint8Array
  /** `true` si se paró en `maxBytes` antes del final. */
  truncated: boolean
}

function decodeBase64(data: string): Uint8Array {
  const raw = atob(data)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/**
 * Métodos `fs.*` (F4.1) con nombre y tipos. `readAll` junta los trozos de `fs.read` (siempre en base64, así no
 * hay que cuidar los límites de carácter) comprobando que el archivo no cambie entre trozos.
 */
export function fsApi(client: Caller) {
  return {
    stat: (path: string, o?: CallOptions<MethodResult<'fs.stat'>>) =>
      client.call('fs.stat', { path }, o),
    read: (p: MethodParams<'fs.read'>, o?: CallOptions<MethodResult<'fs.read'>>) =>
      client.call('fs.read', p, o),
    async readAll(path: string, options: FsReadAllOptions = {}): Promise<FsFile> {
      const max = options.maxBytes ?? Number.MAX_SAFE_INTEGER
      const parts: Uint8Array[] = []
      let offset = 0
      let first: MethodResult<'fs.read'> | undefined
      let eof = false
      while (!eof && offset < max) {
        const r = await client.call(
          'fs.read',
          {
            path,
            offset,
            length: Math.min(LIMITS.maxFsChunkBytes, max - offset),
            encoding: 'base64',
            ...(first === undefined ? {} : { expectMtimeMs: first.mtimeMs }),
          },
          options.signal === undefined ? undefined : { signal: options.signal },
        )
        first ??= r
        parts.push(decodeBase64(r.data))
        offset += r.length
        eof = r.eof
        if (r.length === 0) break
      }
      if (first === undefined) throw new Error('lectura vacía')
      const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
      let at = 0
      for (const p of parts) {
        bytes.set(p, at)
        at += p.length
      }
      return {
        path: first.path,
        type: first.type,
        mime: first.mime,
        size: first.size,
        mtimeMs: first.mtimeMs,
        bytes,
        truncated: !eof,
      }
    },
  }
}

export type FsApi = ReturnType<typeof fsApi>
