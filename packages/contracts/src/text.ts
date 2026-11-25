import { z } from 'zod'
import { LIMITS } from './limits.ts'

/** Longitud en bytes UTF-8 sin depender de `TextEncoder`. Los sustitutos sueltos cuentan 3. */
export function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c < 0x80) bytes += 1
    else if (c < 0x800) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i++
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

/** Cadena con tope en bytes UTF-8 (además del tope barato en unidades UTF-16). */
export function boundedBytes(maxBytes: number) {
  return z
    .string()
    .max(maxBytes)
    .refine((s) => utf8ByteLength(s) <= maxBytes, { message: `máximo ${maxBytes} bytes` })
}

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true
  }
  return false
}

/** Texto de una sola línea para mostrar (títulos, nombres): sin caracteres de control ni ESC. */
export const DisplayText = z
  .string()
  .min(1)
  .max(LIMITS.maxTitleLength)
  .refine((s) => !hasControlChars(s), { message: 'no admite caracteres de control' })

/** Claves que nunca se aceptan como nombre de variable de entorno u otras claves libres. */
export const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** true si hay un sustituto UTF-16 suelto (no forma un carácter válido). */
export function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) i++
      else return true
    } else if (c >= 0xdc00 && c <= 0xdfff) return true
  }
  return false
}

/** Reemplaza NUL y sustitutos sueltos por U+FFFD. Los adaptadores lo aplican a lo que reciben del proveedor. */
export function sanitizeBodyText(value: string): string {
  let out = ''
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c === 0) out += '�'
    else if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[i]
        out += value[i + 1]
        i++
      } else out += '�'
    } else if (c >= 0xdc00 && c <= 0xdfff) out += '�'
    else out += value[i]
  }
  return out
}

/** Recorta a `maxBytes` UTF-8 sin partir un carácter. Asume texto bien formado. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (value.length <= maxBytes && utf8ByteLength(value) <= maxBytes) return value
  let bytes = 0
  let end = 0
  for (const ch of value) {
    const n = utf8ByteLength(ch)
    if (bytes + n > maxBytes) break
    bytes += n
    end += ch.length
  }
  return value.slice(0, end)
}

/**
 * Texto de varias líneas (Markdown, salida de herramientas, diffs): admite saltos de línea, tabuladores y
 * secuencias ANSI (la interfaz las trata como texto, nunca como HTML), pero no NUL ni sustitutos sueltos.
 */
export function bodyText(maxBytes: number, minLength = 0) {
  return boundedBytes(maxBytes)
    .refine((s) => s.length >= minLength, { message: 'no puede estar vacío' })
    .refine((s) => !s.includes('\u0000'), { message: 'no admite NUL' })
    .refine((s) => !hasLoneSurrogate(s), { message: 'sustituto UTF-16 suelto' })
}

/** Texto de una línea (etiquetas, títulos, rutas): sin caracteres de control. */
export function lineText(maxChars: number) {
  return z
    .string()
    .min(1)
    .max(maxChars)
    .refine((s) => !hasControlChars(s) && !hasLoneSurrogate(s), {
      message: 'no admite caracteres de control',
    })
}
