/**
 * Utilidades de bytes UTF-8 sobre cadenas UTF-16. Un par sustituto cuenta 4 bytes y un sustituto
 * suelto 3 (igual que `utf8ByteLength` de contracts). Nunca se corta dentro de un carácter.
 */

/** Bytes UTF-8 de la unidad que empieza en `i` y cuántas unidades UTF-16 ocupa. */
function unitAt(text: string, i: number): { bytes: number; units: number } {
  const c = text.charCodeAt(i)
  if (c < 0x80) return { bytes: 1, units: 1 }
  if (c < 0x800) return { bytes: 2, units: 1 }
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
    const next = text.charCodeAt(i + 1)
    if (next >= 0xdc00 && next <= 0xdfff) return { bytes: 4, units: 2 }
  }
  return { bytes: 3, units: 1 }
}

/** Índice (en unidades UTF-16) tras consumir como máximo `maxBytes` desde `from`, sin partir un carácter. */
export function indexAfterBytes(text: string, from: number, maxBytes: number): number {
  let i = from
  let used = 0
  while (i < text.length) {
    const u = unitAt(text, i)
    if (used + u.bytes > maxBytes) break
    used += u.bytes
    i += u.units
  }
  return i
}

/** Índice desde el que el sufijo de `text` cabe en `maxBytes` bytes, sin partir un carácter. */
export function indexOfSuffixWithin(text: string, maxBytes: number): number {
  let i = text.length
  let used = 0
  while (i > 0) {
    const c = text.charCodeAt(i - 1)
    let bytes = 3
    let units = 1
    if (c < 0x80) bytes = 1
    else if (c < 0x800) bytes = 2
    else if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
      const prev = text.charCodeAt(i - 2)
      if (prev >= 0xd800 && prev <= 0xdbff) {
        bytes = 4
        units = 2
      }
    }
    if (used + bytes > maxBytes) break
    used += bytes
    i -= units
  }
  return i
}

/**
 * Índice tras saltar al menos `skip` bytes (se redondea hacia arriba al límite de carácter) y los
 * bytes realmente saltados.
 */
export function skipBytes(text: string, skip: number): { index: number; skipped: number } {
  let i = 0
  let skipped = 0
  while (i < text.length && skipped < skip) {
    const u = unitAt(text, i)
    skipped += u.bytes
    i += u.units
  }
  return { index: i, skipped }
}

/** Parte `text` en trozos de como máximo `maxBytes` bytes, sin partir caracteres. `maxBytes` >= 4. */
export function splitByBytes(text: string, maxBytes: number): string[] {
  const out: string[] = []
  let from = 0
  while (from < text.length) {
    const end = indexAfterBytes(text, from, maxBytes)
    out.push(text.slice(from, end))
    from = end
  }
  return out
}
