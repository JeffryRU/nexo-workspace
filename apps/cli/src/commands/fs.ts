import { resolve } from 'node:path'
import { type FileType, type FsEncoding, LIMITS, type MethodResult } from '@nexo/contracts'
import { expectPositionals, flag, intOption, parseArgv } from '../args.ts'
import type { Ctx } from '../context.ts'
import { usageError } from '../errors.ts'
import { FsCatOutput, FsStatOutput } from '../schemas.ts'
import { StreamCleaner, sanitize } from '../text.ts'

const SUBCOMMANDS = ['stat', 'cat'] as const
const DEFAULT_MAX = 1024 * 1024
const MAX_MAX = 64 * 1024 * 1024

export async function fsCommand(ctx: Ctx, args: string[]): Promise<void> {
  // Las opciones globales pueden ir antes del subcomando (`nexo fs --json stat ...`).
  const at = args.findIndex((a) => !a.startsWith('-'))
  const sub = at === -1 ? undefined : args[at]
  const rest = at === -1 ? args : [...args.slice(0, at), ...args.slice(at + 1)]
  switch (sub) {
    case 'stat':
      return fsStat(ctx, rest)
    case 'cat':
      return fsCat(ctx, rest)
    default:
      throw usageError(`uso: nexo fs ${SUBCOMMANDS.join('|')} (mira \`nexo fs --help\`)`)
  }
}

/** Las rutas relativas se resuelven contra la carpeta actual: el daemon solo acepta absolutas. */
const absolute = (ctx: Ctx, path: string): string => {
  if (path === '' || path.includes('\0')) throw usageError('ruta no válida')
  return resolve(ctx.deps.cwd(), path)
}

async function fsStat(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args)
  const [path] = expectPositionals(parsed, 1, 1, 'nexo fs stat <ruta>') as [string]
  const client = await ctx.client()
  const st = await client.call('fs.stat', { path: absolute(ctx, path) })
  ctx.emit(FsStatOutput, st, () => {
    const lines = [
      `${sanitize(st.path, 300)}`,
      `  ${st.kind === 'directory' ? 'carpeta' : 'archivo'}, ${st.size} bytes, modificado ${new Date(st.mtimeMs).toISOString()}`,
    ]
    if (st.type !== undefined) {
      lines.push(
        `  tipo ${st.type} (${st.mime ?? '?'}), tope de lectura ${st.maxBytes ?? '?'} bytes${st.tooLarge === true ? ' (SUPERADO: no se puede leer)' : ''}`,
      )
    }
    return lines.join('\n')
  })
}

async function fsCat(ctx: Ctx, args: string[]): Promise<void> {
  const parsed = parseArgv(args, {
    'max-bytes': { type: 'string' },
    base64: { type: 'boolean' },
  })
  const [path] = expectPositionals(
    parsed,
    1,
    1,
    'nexo fs cat <ruta> [--max-bytes N] [--base64]',
  ) as [string]
  const maxBytes = intOption(parsed, 'max-bytes', DEFAULT_MAX, 1, MAX_MAX)
  const forceBase64 = flag(parsed, 'base64')
  const client = await ctx.client()
  const target = absolute(ctx, path)

  let encoding: FsEncoding | undefined = forceBase64 ? 'base64' : undefined
  let expectMtimeMs: number | undefined
  let offset = 0
  let meta: { path: string; type: FileType; mime: string; size: number } | undefined
  const text: string[] = []
  const binary: Uint8Array[] = []
  let eof = false
  while (!eof && offset < maxBytes) {
    const r: MethodResult<'fs.read'> = await client.call('fs.read', {
      path: target,
      offset,
      length: Math.min(LIMITS.maxFsChunkBytes, maxBytes - offset),
      ...(encoding === undefined ? {} : { encoding }),
      ...(expectMtimeMs === undefined ? {} : { expectMtimeMs }),
    })
    if (meta === undefined) {
      meta = { path: r.path, type: r.type, mime: r.mime, size: r.size }
      if (r.encoding === 'base64' && !forceBase64) {
        throw usageError(`el archivo es ${r.type}, no texto: usa --base64 para ver su contenido`)
      }
    }
    encoding = r.encoding
    expectMtimeMs = r.mtimeMs
    if (r.encoding === 'utf8') text.push(r.data)
    else binary.push(Uint8Array.from(Buffer.from(r.data, 'base64')))
    offset += r.length
    eof = r.eof
    if (r.length === 0) break
  }
  if (meta === undefined) throw usageError('no se pudo leer el archivo')
  const data = encoding === 'utf8' ? text.join('') : Buffer.concat(binary).toString('base64')
  ctx.emit(
    FsCatOutput,
    { ...meta, encoding: encoding ?? 'utf8', bytes: offset, truncated: !eof, data },
    () => {
      const body = encoding === 'utf8' ? new StreamCleaner().feed(data) : data
      return eof
        ? body
        : `${body}\n[recortado a ${offset} bytes de ${meta?.size}; sube --max-bytes]`
    },
  )
}
