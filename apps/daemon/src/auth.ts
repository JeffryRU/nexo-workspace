import { randomBytes, timingSafeEqual } from 'node:crypto'

export const SUBPROTOCOL = 'nexo.v1'
const TOKEN_PREFIX = 'nexo.token.'

export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Comparación en tiempo constante: se igualan las longitudes antes de comparar. */
export function tokensEqual(expected: string, candidate: unknown): boolean {
  if (typeof candidate !== 'string') return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(candidate, 'utf8')
  const padded = Buffer.alloc(a.length)
  b.copy(padded, 0, 0, Math.min(b.length, a.length))
  const sameBytes = timingSafeEqual(a, padded)
  return sameBytes && a.length === b.length
}

export type ProtocolOffer = {
  versionOffered: boolean
  token: string | undefined
  tokenCount: number
}

/** Lee `Sec-WebSocket-Protocol: nexo.v1, nexo.token.<token>`. Nunca devuelve el token a un log. */
export function parseSubprotocols(header: string | string[] | undefined): ProtocolOffer {
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '')
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  let token: string | undefined
  let tokenCount = 0
  for (const item of items) {
    if (item.startsWith(TOKEN_PREFIX)) {
      tokenCount++
      token ??= item.slice(TOKEN_PREFIX.length)
    }
  }
  return { versionOffered: items.includes(SUBPROTOCOL), token, tokenCount }
}
