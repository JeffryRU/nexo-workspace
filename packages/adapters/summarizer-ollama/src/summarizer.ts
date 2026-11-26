import type { SummarizerUsage, Token } from '@nexo/contracts'
import {
  type AbortSignalLike,
  buildObserverPrompt,
  buildReflectorPrompt,
  estimateTokens,
  parseObserverJson,
  type SummarizeRequest,
  type SummarizeResponse,
  SummarizerError,
  type SummarizerPort,
} from '@nexo/core'
import { z } from 'zod'

/**
 * Resumidor de la memoria sobre Ollama (F3.5.2): HTTP a `/api/chat` **sin streaming**. Los adaptadores no se
 * importan entre sí, así que no reutiliza `provider-ollama`; comparte con él solo la forma de la API.
 * `fetch` es inyectable (las pruebas usan un servidor HTTP falso). Nunca sigue redirecciones ni envía
 * credenciales; no lee nada del usuario salvo la URL y el modelo que se le pasan.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'

export type OllamaSummarizerOptions = {
  /** Modelo de Ollama (`llama3.2:3b`...). */
  model: string
  baseUrl?: string
  fetch?: FetchLike
  /** Plazo de una llamada de resumen (ms). */
  timeoutMs?: number
  /** Pide `format: "json"` al Observador (por omisión sí); si el modelo no lo respeta, se lee como texto. */
  json?: boolean
  /** Tope de la ventana de contexto que se pide (tokens). Una petición más grande falla con `TOO_LARGE`. */
  maxContextTokens?: number
  /** Tope del cuerpo de respuesta aceptado (bytes). */
  maxResponseBytes?: number
}

const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_MAX_CONTEXT = 65_536
const DEFAULT_MAX_RESPONSE = 1024 * 1024
const ERROR_BODY_BYTES = 8 * 1024

/** Valida la URL base de Ollama; lanza `Error` con un mensaje legible si no sirve. */
export function parseOllamaBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('no es una URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('solo http o https')
  if (url.username !== '' || url.password !== '') throw new Error('no admite usuario ni contraseña')
  if (url.search !== '' || url.hash !== '') throw new Error('no admite parámetros ni fragmento')
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

const ChatResponse = z.looseObject({
  message: z.looseObject({ content: z.string() }),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
  total_duration: z.number().optional(),
})
const Tags = z.looseObject({
  models: z.array(z.looseObject({ name: z.unknown().optional(), model: z.unknown().optional() })),
})
const ErrorBody = z.looseObject({ error: z.string().optional() })

const asCount = (n: number | undefined): number | undefined =>
  n === undefined || !Number.isFinite(n) || n < 0 ? undefined : Math.min(Math.trunc(n), 2 ** 40)

const cleanLine = (text: string): string =>
  text
    .replace(/[^\P{C}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)

export class OllamaSummarizer implements SummarizerPort {
  readonly id: string
  readonly #model: string
  readonly #base: string
  readonly #fetch: FetchLike
  readonly #timeoutMs: number
  readonly #json: boolean
  readonly #maxContext: number
  readonly #maxResponse: number

  constructor(options: OllamaSummarizerOptions) {
    this.#model = options.model
    this.#base = parseOllamaBaseUrl(options.baseUrl ?? DEFAULT_OLLAMA_URL)
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init))
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#json = options.json ?? true
    this.#maxContext = options.maxContextTokens ?? DEFAULT_MAX_CONTEXT
    this.#maxResponse = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE
    this.id = `ollama:${options.model}`.slice(0, 256)
  }

  /** Ollama responde y el modelo está instalado. */
  async isAvailable(): Promise<boolean> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5_000)
    try {
      const res = await this.#fetch(`${this.#base}/api/tags`, {
        signal: controller.signal,
        redirect: 'error',
      })
      if (!res.ok) return false
      const raw = await readLimited(res, 4 * 1024 * 1024, controller.signal)
      const tags = Tags.safeParse(JSON.parse(raw))
      if (!tags.success) return false
      const wanted = this.#model.includes(':') ? this.#model : `${this.#model}:latest`
      return tags.data.models.some(
        (m) => m.name === wanted || m.model === wanted || m.name === this.#model,
      )
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  async summarize(
    request: SummarizeRequest,
    options: { signal?: AbortSignalLike } = {},
  ): Promise<SummarizeResponse> {
    const external = options.signal
    if (external?.aborted) throw new SummarizerError('ABORTED', 'cancelado', { retryable: false })
    const observing = request.kind === 'observe'
    const prompt = observing
      ? buildObserverPrompt(request, { format: this.#json ? 'json' : 'lines' })
      : buildReflectorPrompt(request)
    const promptTokens = estimateTokens(prompt.system) + estimateTokens(prompt.user)
    const numCtx = Math.max(4096, Math.ceil((promptTokens * 1.25 + 2048) / 1024) * 1024)
    if (numCtx > this.#maxContext) {
      throw new SummarizerError(
        'TOO_LARGE',
        `la petición (~${promptTokens} tokens) no cabe en ${this.#maxContext} tokens de contexto`,
        { retryable: false },
      )
    }

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.#timeoutMs)
    const onAbort = () => controller.abort()
    external?.addEventListener('abort', onAbort, { once: true })
    const started = Date.now()
    try {
      const res = await this.#post(prompt, observing, numCtx, controller.signal)
      if (!res.ok) throw await this.#httpError(res, controller.signal)
      const text = await readLimited(res, this.#maxResponse, controller.signal)
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        throw new SummarizerError('INVALID_OUTPUT', 'Ollama devolvió algo que no es JSON', {
          retryable: false,
        })
      }
      const parsed = ChatResponse.safeParse(json)
      if (!parsed.success) {
        throw new SummarizerError('INVALID_OUTPUT', 'respuesta de Ollama inesperada', {
          retryable: false,
        })
      }
      const content = parsed.data.message.content
      const input = asCount(parsed.data.prompt_eval_count)
      const output = asCount(parsed.data.eval_count)
      const nanos = parsed.data.total_duration
      const usage: SummarizerUsage = {
        model: this.#model as Token,
        ...(input === undefined ? {} : { inputTokens: input }),
        ...(output === undefined ? {} : { outputTokens: output }),
        costUsd: 0,
        durationMs:
          nanos !== undefined && Number.isFinite(nanos) && nanos >= 0
            ? Math.min(Math.trunc(nanos / 1e6), 2 ** 31)
            : Date.now() - started,
      }
      if (content.trim() === '') {
        throw new SummarizerError('INVALID_OUTPUT', 'el modelo contestó vacío', {
          retryable: false,
        })
      }
      if (!observing) return { kind: 'reflect', text: content.trim(), usage }
      if (this.#json) {
        const drafts = parseObserverJson(content)
        if (drafts !== null) {
          return {
            kind: 'observe',
            content: { format: 'observations', observations: drafts },
            usage,
          }
        }
      }
      return { kind: 'observe', content: { format: 'text', text: content }, usage }
    } catch (error) {
      if (error instanceof SummarizerError) throw error
      if (external?.aborted) throw new SummarizerError('ABORTED', 'cancelado', { retryable: false })
      if (timedOut)
        throw new SummarizerError('TIMEOUT', 'Ollama tardó demasiado', { retryable: true })
      throw new SummarizerError('UNAVAILABLE', `no se pudo hablar con Ollama (${this.#base})`, {
        cause: error,
        retryable: true,
      })
    } finally {
      clearTimeout(timer)
      external?.removeEventListener('abort', onAbort)
    }
  }

  #post(
    prompt: { system: string; user: string },
    observing: boolean,
    numCtx: number,
    signal: AbortSignal,
  ): Promise<Response> {
    const body = {
      model: this.#model,
      stream: false,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      ...(observing && this.#json ? { format: 'json' } : {}),
      options: { temperature: 0.2, num_ctx: numCtx },
    }
    return this.#fetch(`${this.#base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
    })
  }

  async #httpError(res: Response, signal: AbortSignal): Promise<SummarizerError> {
    let detail = ''
    try {
      const raw = await readLimited(res, ERROR_BODY_BYTES, signal)
      const parsed = ErrorBody.safeParse(JSON.parse(raw))
      detail = parsed.success ? cleanLine(parsed.data.error ?? '') : ''
    } catch {
      detail = ''
    }
    const suffix = detail === '' ? '' : `: ${detail}`
    if (res.status === 404) {
      return new SummarizerError(
        'UNAVAILABLE',
        `el modelo ${this.#model} no está instalado en Ollama${suffix}`,
        { retryable: false },
      )
    }
    if (res.status >= 500 || res.status === 429 || res.status === 408) {
      return new SummarizerError('UNAVAILABLE', `Ollama respondió ${res.status}${suffix}`, {
        retryable: true,
      })
    }
    return new SummarizerError(
      'INVALID_OUTPUT',
      `Ollama rechazó la petición (${res.status})${suffix}`,
      {
        retryable: false,
      },
    )
  }
}

/** Lee el cuerpo como texto hasta `maxBytes`; si se pasa, falla (no se acepta una respuesta infinita). */
async function readLimited(res: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const body = res.body
  if (body === null) return ''
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: false })
  let out = ''
  let total = 0
  const onAbort = () => void reader.cancel().catch(() => {})
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maxBytes) {
        void reader.cancel().catch(() => {})
        throw new SummarizerError('INVALID_OUTPUT', 'la respuesta pasa del tope de tamaño', {
          retryable: false,
        })
      }
      out += decoder.decode(next.value, { stream: true })
    }
    if (signal.aborted) throw new Error('abortado')
    return out + decoder.decode()
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
