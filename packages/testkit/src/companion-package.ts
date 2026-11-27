import { encodeUtf8 } from './bytes.ts'

/**
 * Paquete de compañero mínimo para las pruebas (F5.2): imágenes diminutas generadas aquí (nada de terceros) y un
 * `companion.json` válido. Los archivos van en un mapa ruta relativa -> bytes.
 */

let crcTable: Uint32Array | undefined
function crc32(bytes: Uint8Array): number {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (const b of bytes) c = (crcTable[(c ^ b) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const be32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]

function chunk(type: string, data: Uint8Array): number[] {
  const body = Uint8Array.from([...encodeUtf8(type), ...data])
  return [...be32(data.length), ...body, ...be32(crc32(body))]
}

/** PNG RGBA válido de `width` x `height` (un solo color; deflate sin comprimir). */
export function tinyPng(
  width = 1,
  height = 1,
  rgba: readonly number[] = [255, 128, 0, 255],
): Uint8Array {
  const row = [0, ...Array.from({ length: width }, () => rgba).flat()]
  const raw = Uint8Array.from(Array.from({ length: height }, () => row).flat())
  let a = 1
  let b = 0
  for (const v of raw) {
    a = (a + v) % 65521
    b = (b + a) % 65521
  }
  const stored: number[] = [0x78, 0x01]
  for (let i = 0; i < raw.length || i === 0; i += 65535) {
    const part = raw.subarray(i, i + 65535)
    const last = i + 65535 >= raw.length
    stored.push(
      last ? 1 : 0,
      part.length & 255,
      part.length >> 8,
      ~part.length & 255,
      (~part.length >> 8) & 255,
      ...part,
    )
  }
  stored.push(...be32(((b << 16) | a) >>> 0))
  const ihdr = Uint8Array.from([...be32(width), ...be32(height), 8, 6, 0, 0, 0])
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', Uint8Array.from(stored)),
    ...chunk('IEND', new Uint8Array()),
  ])
}

/** GIF 1x1 válido. */
export function tinyGif(): Uint8Array {
  return Uint8Array.from([
    ...encodeUtf8('GIF89a'),
    1,
    0,
    1,
    0,
    0x80,
    0,
    0,
    0,
    0,
    0,
    255,
    255,
    255,
    0x2c,
    0,
    0,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
    2,
    2,
    0x44,
    1,
    0,
    0x3b,
  ])
}

/** WebP 1x1 (sin pérdida) válido. */
export function tinyWebp(): Uint8Array {
  return Uint8Array.from([
    0x52, 0x49, 0x46, 0x46, 0x1a, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c, 0x0d, 0,
    0, 0, 0x2f, 0, 0, 0, 0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07, 0,
  ])
}

export const TINY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3" fill="#f80"/></svg>'

export type CompanionFiles = Record<string, Uint8Array>

export type TinyCompanionOptions = {
  id?: string
  /** Cambia o añade campos del manifiesto. */
  manifest?: Record<string, unknown>
}

/** Un compañero válido: `idle` en PNG, `thinking` en GIF, `done` en WebP y `error` en SVG (con hoja de sprites en `waiting`). */
export function tinyCompanion(options: TinyCompanionOptions = {}): CompanionFiles {
  const id = options.id ?? 'tiny'
  const manifest = {
    format: 1,
    id,
    name: 'Tiny',
    version: '1.0.0',
    description: 'Paquete de prueba',
    author: { name: 'Nexo' },
    license: 'CC0-1.0',
    states: {
      idle: { src: 'idle.png' },
      thinking: { src: 'img/think.gif' },
      waiting: { src: 'sheet.png', sheet: { frameWidth: 1, frameHeight: 1, frames: 4, fps: 4 } },
      done: { src: 'done.webp' },
      error: { src: 'error.svg' },
    },
    ...options.manifest,
  }
  return {
    'companion.json': encodeUtf8(JSON.stringify(manifest)),
    'idle.png': tinyPng(),
    'img/think.gif': tinyGif(),
    'sheet.png': tinyPng(4, 1),
    'done.webp': tinyWebp(),
    'error.svg': encodeUtf8(TINY_SVG),
  }
}
