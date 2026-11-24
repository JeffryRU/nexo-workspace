import type { z } from 'zod'
import {
  ErrorResponse,
  EventEnvelope,
  OkResponse,
  RequestEnvelope,
} from './envelope.ts'
import type { ErrorBody, ErrorCode } from './errors.ts'
import { type EventName, events, type TypedEvent } from './events.ts'
import { LIMITS } from './limits.ts'
import { type MethodName, type MethodResult, methods, type TypedRequest } from './methods.ts'
import { utf8ByteLength } from './text.ts'

export type ParseFailure = {
  ok: false
  error: ErrorBody
  /** `id` de la petición si se pudo leer, para responderle con el error. */
  id?: string
}
export type ParseSuccess<T> = { ok: true; value: T }
export type ParseResult<T> = ParseSuccess<T> | ParseFailure

export type ParseOptions = {
  /** Tamaño máximo del mensaje en bytes UTF-8 (1 MiB por omisión). */
  maxBytes?: number
}

export type ServerMessage = OkResponse | ErrorResponse | TypedEvent

function fail(code: ErrorCode, message: string, id?: string): ParseFailure {
  const f: ParseFailure = { ok: false, error: { code, message } }
  if (id !== undefined) f.id = id
  return f
}

function describe(error: z.ZodError): string {
  const first = error.issues[0]
  if (first === undefined) return 'entrada inválida'
  const where = first.path.length > 0 ? ` en ${first.path.map(String).join('.')}` : ''
  return `${first.message}${where}`.slice(0, 200)
}

function safeId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const id: unknown = Reflect.get(value, 'id')
  return typeof id === 'string' && id.length > 0 && id.length <= 128 ? id : undefined
}

/** Texto -> valor JSON. Nunca lanza; aplica el tope de tamaño antes de parsear. */
function readJson(text: unknown, options: ParseOptions | undefined): ParseResult<unknown> {
  if (typeof text !== 'string') return fail('INVALID_PARAMS', 'el mensaje debe ser texto')
  const max = options?.maxBytes ?? LIMITS.maxMessageBytes
  // UTF-8 usa como mínimo 1 byte por unidad UTF-16, así que length > max ya excede el tope.
  if (text.length > max || utf8ByteLength(text) > max) {
    return fail('PAYLOAD_TOO_LARGE', `el mensaje supera ${max} bytes`)
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return fail('INVALID_PARAMS', 'JSON inválido')
  }
}

function isMethod(name: string): name is MethodName {
  return Object.hasOwn(methods, name)
}

function isEvent(name: string): name is EventName {
  return Object.hasOwn(events, name)
}

/** Valida un valor ya parseado como petición cliente -> daemon. Nunca lanza. */
export function parseRequestValue(value: unknown): ParseResult<TypedRequest> {
  try {
    const env = RequestEnvelope.safeParse(value)
    if (!env.success) return fail('INVALID_PARAMS', describe(env.error), safeId(value))
    const { id, method } = env.data
    if (!isMethod(method)) return fail('NOT_FOUND', `método desconocido: ${method.slice(0, 64)}`, id)
    const params = methods[method].params.safeParse(env.data.params ?? {})
    if (!params.success) return fail('INVALID_PARAMS', describe(params.error), id)
    // Unión discriminada: la correlación method/params la garantiza el registro.
    return { ok: true, value: { v: 1, id, method, params: params.data } as TypedRequest }
  } catch {
    return fail('INVALID_PARAMS', 'petición no procesable', safeId(value))
  }
}

/** Texto (mensaje WebSocket) -> petición tipada. Nunca lanza. */
export function parseRequest(text: string, options?: ParseOptions): ParseResult<TypedRequest> {
  const json = readJson(text, options)
  if (!json.ok) return json
  return parseRequestValue(json.value)
}

/** Valida un valor ya parseado como mensaje daemon -> cliente. Nunca lanza. */
export function parseServerMessageValue(value: unknown): ParseResult<ServerMessage> {
  try {
    if (typeof value === 'object' && value !== null && Object.hasOwn(value, 'event')) {
      const env = EventEnvelope.safeParse(value)
      if (!env.success) return fail('INVALID_PARAMS', describe(env.error))
      const name = env.data.event
      if (!isEvent(name)) return fail('NOT_FOUND', `evento desconocido: ${name.slice(0, 64)}`)
      const data = events[name].safeParse(env.data.data)
      if (!data.success) return fail('INVALID_PARAMS', describe(data.error))
      return {
        ok: true,
        value: { v: 1, event: name, seq: env.data.seq, data: data.data } as TypedEvent,
      }
    }
    const okRes = OkResponse.safeParse(value)
    if (okRes.success) return { ok: true, value: okRes.data }
    const errRes = ErrorResponse.safeParse(value)
    if (errRes.success) return { ok: true, value: errRes.data }
    return fail('INVALID_PARAMS', 'mensaje del servidor no reconocido', safeId(value))
  } catch {
    return fail('INVALID_PARAMS', 'mensaje no procesable', safeId(value))
  }
}

/** Texto -> respuesta o evento tipado. Nunca lanza. */
export function parseServerMessage(
  text: string,
  options?: ParseOptions,
): ParseResult<ServerMessage> {
  const json = readJson(text, options)
  if (!json.ok) return json
  return parseServerMessageValue(json.value)
}

/** Valida el `result` de una respuesta para el método que la originó. Nunca lanza. */
export function parseResult<M extends MethodName>(
  method: M,
  result: unknown,
): ParseResult<MethodResult<M>> {
  try {
    if (!isMethod(method)) return fail('NOT_FOUND', 'método desconocido')
    const r = methods[method].result.safeParse(result)
    if (!r.success) return fail('INVALID_PARAMS', describe(r.error))
    return { ok: true, value: r.data as MethodResult<M> }
  } catch {
    return fail('INVALID_PARAMS', 'resultado no procesable')
  }
}
