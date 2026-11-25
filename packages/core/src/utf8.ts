import { utf8ByteLength } from '@nexo/contracts'

/**
 * Utilidades de bytes UTF-8 sobre cadenas UTF-16. Un par sustituto cuenta 4 bytes y un sustituto
 * suelto 3 (igual que `utf8ByteLength` de contracts). Nunca se corta dentro de un carácter.
 * Los bucles no reservan objetos: se usan con ráfagas de decenas de MB.
 */

/** Índice (en unidades UTF-16) tras consumir como máximo `maxBytes` desde `from`, sin partir un carácter. */
export function indexAfterBytes(text: string, from: number, maxBytes: number): number {
  let i = from
  let used = 0
  while (i < text.length) {
    const c = text.charCodeAt(i)
    let bytes = 3
    let units = 1
    if (c < 0x80) bytes = 1
    else if (c < 0x800) bytes = 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes = 4
        units = 2
      }
    }
    if (used + bytes > maxBytes) break
    used += bytes
    i += units
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
    const c = text.charCodeAt(i)
    if (c < 0x80) skipped += 1
    else if (c < 0x800) skipped += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        skipped += 4
        i++
      } else skipped += 3
    } else skipped += 3
    i++
  }
  return { index: i, skipped }
}

/** Parte `text` en trozos de como máximo `maxBytes` bytes, sin partir caracteres. `maxBytes` >= 4. */
export function splitByBytes(text: string, maxBytes: number): string[] {
  const bytes = utf8ByteLength(text)
  if (bytes <= maxBytes) return text.length === 0 ? [] : [text]
  const out: string[] = []
  // Solo ASCII: un byte por unidad, se corta por longitud sin recorrer.
  if (bytes === text.length) {
    for (let from = 0; from < text.length; from += maxBytes)
      out.push(text.slice(from, from + maxBytes))
    return out
  }
  let from = 0
  while (from < text.length) {
    const end = indexAfterBytes(text, from, maxBytes)
    out.push(text.slice(from, end))
    from = end
  }
  return out
}
