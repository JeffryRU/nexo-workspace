import { z } from 'zod'
import { line } from './text.ts'

/**
 * Cliente HTTP mínimo de la API de Ollama. `fetch` es inyectable: las pruebas usan un servidor HTTP falso
 * local o un `fetch` a medida. Nunca sigue redirecciones ni envía credenciales.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export class OllamaRequestError extends Error {
  readonly kind: 'unreachable' | 'http' | 'protocol' | 'timeout'
  readonly status: number | undefined
  /** Mensaje que Ollama puso en `{ "error": ... }`, ya saneado. */
  readonly serverMessage: string | undefined
  constructor(
    kind: OllamaRequestError['kind'],
    message: string,
    extra: { status?: number; serverMessage?: string; cause?: unknown } = {},
  ) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause })
    this.name = 'OllamaRequestError'
    this.kind = kind
    this.status = extra.status
    this.serverMessage = extra.serverMessage
  }
}

export type ChatRequest = {
  model: string
  messages: readonly { role: 'user' | 'assistant'; content: string }[]
  think?: boolean
}

const Tags = z.looseObject({
  models: z.array(z.looseObject({ name: z.unknown().optional(), model: z.unknown().optional() })),
})

const ERROR_BODY_BYTES = 8 * 1024
const TAGS_BODY_BYTES = 4 * 1024 * 1024

/** Rechaza cuando `signal` se aborta aunque la promesa original no lo atienda. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {})
    return Promise.reject(signal.reason)
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

/** Lee el cuerpo por trozos; cancela el lector si se aborta o si el consumidor deja de leer. */
export async function* readBody(res: Response, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const body = res.body
  if (body === null || body === undefined) return
  const reader = body.getReader()
  try {
    for (;;) {
      const next = await raceAbort(reader.read(), signal)
      if (next.done) return
      if (next.value !== undefined && next.value.length > 0) yield next.value
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

async function readText(res: Response, signal: AbortSignal, maxBytes: number): Promise<string> {
  const parts: Uint8Array[] = []
  let size = 0
  for await (const chunk of readBody(res, signal)) {
    size += chunk.length
    if (size > maxBytes) break
    parts.push(chunk)
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    all.set(p, at)
    at += p.length
  }
  return new TextDecoder().decode(all)
}

function serverMessageOf(text: string): string | undefined {
  try {
    const json: unknown = JSON.parse(text)
    if (typeof json === 'object' && json !== null && 'error' in json) {
      const e = (json as { error: unknown }).error
      if (typeof e === 'string') return line(e, 500) || undefined
    }
  } catch {
    // no era JSON: se usa el texto tal cual
  }
  const plain = line(text, 300)
  return plain === '' ? undefined : plain
}

export class OllamaClient {
  readonly #base: string
  readonly #fetch: FetchLike

  constructor(options: { baseUrl: string; fetch: FetchLike }) {
    this.#base = options.baseUrl.replace(/\/+$/, '')
    this.#fetch = options.fetch
  }

  /** `GET /api/tags`: nombres de los modelos instalados. Rechaza con `OllamaRequestError`. */
  async listModels(signal: AbortSignal): Promise<string[]> {
    const res = await this.#request('/api/tags', { method: 'GET' }, signal)
    if (!res.ok) throw await this.#httpError(res, signal)
    let json: unknown
    try {
      json = JSON.parse(await readText(res, signal, TAGS_BODY_BYTES))
    } catch (error) {
      if (signal.aborted) throw error
      throw new OllamaRequestError('protocol', 'la lista de modelos no es JSON', { cause: error })
    }
    const parsed = Tags.safeParse(json)
    if (!parsed.success)
      throw new OllamaRequestError('protocol', 'la lista de modelos no es válida')
    const names: string[] = []
    for (const m of parsed.data.models) {
      const name = typeof m.name === 'string' ? m.name : typeof m.model === 'string' ? m.model : ''
      if (name !== '') names.push(name)
    }
    return names
  }

  /** `POST /api/chat` en streaming: resuelve con la respuesta ya aceptada (2xx); el cuerpo se lee aparte. */
  async chat(request: ChatRequest, signal: AbortSignal): Promise<Response> {
    const body = JSON.stringify({
      model: request.model,
      messages: request.messages,
      stream: true,
      ...(request.think === undefined ? {} : { think: request.think }),
    })
    const res = await this.#request(
      '/api/chat',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body },
      signal,
    )
    if (!res.ok) throw await this.#httpError(res, signal)
    return res
  }

  async #request(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    try {
      return await raceAbort(
        this.#fetch(`${this.#base}${path}`, { ...init, signal, redirect: 'error' }),
        signal,
      )
    } catch (error) {
      if (signal.aborted) throw error
      throw new OllamaRequestError('unreachable', 'no se pudo conectar con Ollama', {
        cause: error,
      })
    }
  }

  async #httpError(res: Response, signal: AbortSignal): Promise<OllamaRequestError> {
    let text = ''
    try {
      text = await readText(res, signal, ERROR_BODY_BYTES)
    } catch (error) {
      if (signal.aborted) throw error
    }
    const serverMessage = serverMessageOf(text)
    return new OllamaRequestError('http', `Ollama respondió ${res.status}`, {
      status: res.status,
      ...(serverMessage === undefined ? {} : { serverMessage }),
    })
  }
}
