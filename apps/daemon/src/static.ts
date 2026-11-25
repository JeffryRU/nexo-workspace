import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, sep } from 'node:path'

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-cache',
}

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

export function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  type = 'text/plain; charset=utf-8',
): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Convierte la ruta de la URL en segmentos seguros, o `undefined` si es hostil: `..`, `.`,
 * barras invertidas, NUL, `:` (unidades y flujos de Windows), segmentos vacíos o doble codificación
 * que decodifica a algo peligroso.
 */
export function safeSegments(rawPath: string): string[] | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    return undefined
  }
  if (/[\\:]/.test(decoded) || decoded.includes('\u0000') || decoded.includes('%')) return undefined
  const parts = decoded.split('/').slice(1)
  if (!decoded.startsWith('/')) return undefined
  const segments: string[] = []
  for (const [i, part] of parts.entries()) {
    if (part === '' && i === parts.length - 1) continue
    if (part === '' || part === '.' || part === '..' || part.startsWith('.')) return undefined
    // Nombres de dispositivo de Windows (CON, NUL, COM1...) con o sin extensión.
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(part)) return undefined
    if (part.endsWith(' ') || part.endsWith('.')) return undefined
    segments.push(part)
  }
  return segments
}

export function createStaticHandler(root: string | undefined) {
  let realRoot: Promise<string | undefined> | undefined
  const resolveRoot = (): Promise<string | undefined> => {
    if (root === undefined) return Promise.resolve(undefined)
    realRoot ??= realpath(root).catch(() => undefined)
    return realRoot
  }

  /** Devuelve `false` si no hay web que servir (el llamador responde 404). */
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const base = await resolveRoot()
    if (base === undefined) return false
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD')
      sendText(res, 405, 'método no permitido')
      return true
    }
    const rawPath = (req.url ?? '/').split(/[?#]/, 1)[0] ?? '/'
    const segments = safeSegments(rawPath)
    if (segments === undefined) {
      sendText(res, 400, 'ruta no válida')
      return true
    }
    const wanted = segments.length === 0 ? ['index.html'] : segments
    let file: string
    try {
      file = await realpath(join(base, ...wanted))
    } catch {
      sendText(res, 404, 'no encontrado')
      return true
    }
    // Un enlace simbólico no puede sacar la ruta de la raíz.
    if (file !== base && !file.startsWith(base + sep)) {
      sendText(res, 404, 'no encontrado')
      return true
    }
    const info = await stat(file).catch(() => undefined)
    if (info === undefined || !info.isFile()) {
      sendText(res, 404, 'no encontrado')
      return true
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
    })
    if (req.method === 'HEAD') {
      res.end()
      return true
    }
    const stream = createReadStream(file)
    stream.on('error', () => res.destroy())
    res.on('close', () => stream.destroy())
    stream.pipe(res)
    return true
  }
}
