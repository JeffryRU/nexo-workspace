/** Esquemas de enlace que se dejan abrir. Lo demás (`javascript:`, `data:`, `vbscript:`, `file:`, relativos...) se muestra como texto. */
const ALLOWED = new Set(['http:', 'https:', 'mailto:'])

/** Controles, espacios y caracteres invisibles: los navegadores los ignoran dentro del esquema (`java<TAB>script:`). */
function isInvisible(c: number): boolean {
  return (
    c <= 0x20 ||
    (c >= 0x7f && c <= 0x9f) ||
    c === 0xad ||
    (c >= 0x200b && c <= 0x200f) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x2060 ||
    c === 0xfeff
  )
}

export function stripInvisible(text: string): string {
  let out = ''
  for (const ch of text) if (!isInvisible(ch.codePointAt(0) as number)) out += ch
  return out
}

/** La URL normalizada si es segura de abrir, o `undefined`. Solo admite URL absolutas. */
export function safeHref(raw: string): string | undefined {
  if (raw.length > 2048) return undefined
  const compact = stripInvisible(raw)
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(compact)) return undefined
  let url: URL
  try {
    url = new URL(compact)
  } catch {
    return undefined
  }
  if (!ALLOWED.has(url.protocol)) return undefined
  // Sin credenciales incrustadas (`https://confiable.com@malo.com`).
  if (url.username !== '' || url.password !== '') return undefined
  return url.href
}
