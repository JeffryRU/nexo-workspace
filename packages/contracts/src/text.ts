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
