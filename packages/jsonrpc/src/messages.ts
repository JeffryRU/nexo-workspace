import { z } from 'zod'

export type JsonRpcId = string | number

const Id = z.union([z.string().max(256), z.number().int()])
const Method = z.string().min(1).max(256)
const ErrorBody = z.looseObject({
  code: z.number().int(),
  message: z.string(),
  data: z.unknown().optional(),
})

export type IncomingMessage =
  | { kind: 'request'; id: JsonRpcId; method: string; params: unknown }
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'response'; id: JsonRpcId; result: unknown }
  | { kind: 'error'; id: JsonRpcId; error: { code: number; message: string; data?: unknown } }

export type ParseResult =
  | { ok: true; message: IncomingMessage }
  | { ok: false; reason: 'invalid-json' | 'invalid-message'; detail: string }

const invalid = (detail: string): ParseResult => ({ ok: false, reason: 'invalid-message', detail })

/**
 * Clasifica una línea ya separada. El campo `jsonrpc` es opcional al recibir (Codex app-server lo omite;
 * ACP lo exige): si viene, debe ser `"2.0"`. Las respuestas con `id: null` (error de análisis del otro
 * extremo) no son correlacionables y se rechazan como mensaje inválido.
 */
export function parseLine(line: string): ParseResult {
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return { ok: false, reason: 'invalid-json', detail: 'no es JSON' }
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return invalid('no es un objeto')
  }
  const o = json as Record<string, unknown>
  if ('jsonrpc' in o && o.jsonrpc !== '2.0') return invalid('jsonrpc distinto de "2.0"')
  const hasId = 'id' in o
  if ('method' in o) {
    const method = Method.safeParse(o.method)
    if (!method.success) return invalid('method inválido')
    if (!hasId) {
      return { ok: true, message: { kind: 'notification', method: method.data, params: o.params } }
    }
    const id = Id.safeParse(o.id)
    if (!id.success) return invalid('id inválido')
    return {
      ok: true,
      message: { kind: 'request', id: id.data, method: method.data, params: o.params },
    }
  }
  if (!hasId) return invalid('sin method ni id')
  const id = Id.safeParse(o.id)
  if (!id.success) return invalid('id inválido')
  const hasResult = 'result' in o
  if (hasResult === 'error' in o) return invalid('una respuesta lleva result o error, uno solo')
  if (hasResult) return { ok: true, message: { kind: 'response', id: id.data, result: o.result } }
  const error = ErrorBody.safeParse(o.error)
  if (!error.success) return invalid('error inválido')
  const { code, message, data } = error.data
  return {
    ok: true,
    message: {
      kind: 'error',
      id: id.data,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    },
  }
}
