/** Codificadores sin `Buffer`/`TextEncoder` (los paquetes que importan el testkit no siempre tienen tipos de Node). */

export function encodeUtf8(text: string): Uint8Array {
  const out: number[] = []
  for (const ch of text) {
    const c = ch.codePointAt(0) as number
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return Uint8Array.from(out)
}

/** UTF-8 a texto; lo inválido sale como U+FFFD (como `TextDecoder`, sin las sutilezas de la longitud del reemplazo). */
export function decodeUtf8(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i] as number
    const len =
      b < 0x80
        ? 1
        : b >= 0xc2 && b <= 0xdf
          ? 2
          : b >= 0xe0 && b <= 0xef
            ? 3
            : b >= 0xf0 && b <= 0xf4
              ? 4
              : 0
    let ok = len > 0 && i + len <= bytes.length
    for (let k = 1; ok && k < len; k++) ok = ((bytes[i + k] as number) & 0xc0) === 0x80
    if (!ok) {
      out += '�'
      i++
      continue
    }
    let cp = len === 1 ? b : b & (0xff >> (len + 1))
    for (let k = 1; k < len; k++) cp = (cp << 6) | ((bytes[i + k] as number) & 63)
    const invalid =
      (len === 3 && cp < 0x800) ||
      (len === 4 && (cp < 0x10000 || cp > 0x10ffff)) ||
      (cp >= 0xd800 && cp <= 0xdfff)
    if (invalid) {
      out += '�'
      i++
      continue
    }
    out += String.fromCodePoint(cp)
    i += len
  }
  return out
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    parts.push(
      (B64[(n >> 18) & 63] as string) +
        (B64[(n >> 12) & 63] as string) +
        (b === undefined ? '=' : (B64[(n >> 6) & 63] as string)) +
        (c === undefined ? '=' : (B64[n & 63] as string)),
    )
  }
  return parts.join('')
}

export function decodeBase64(data: string): Uint8Array {
  const clean = data.replace(/=+$/, '')
  const out: number[] = []
  let acc = 0
  let bits = 0
  for (const ch of clean) {
    const v = B64.indexOf(ch)
    if (v === -1) throw new Error('base64 no válido')
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((acc >> bits) & 0xff)
    }
  }
  return Uint8Array.from(out)
}
