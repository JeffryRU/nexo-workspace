import type { ProviderEvent, SummarizerUsage, Token } from '@nexo/contracts'
import { buildObserverPrompt, buildReflectorPrompt, combinePrompt } from './memory-prompts.ts'
import {
  AgentProviderError,
  type AgentProviderPort,
  type AgentProviderSession,
} from './ports/agent.ts'
import {
  type AbortSignalLike,
  type SummarizeRequest,
  type SummarizeResponse,
  SummarizerError,
  type SummarizerPort,
} from './ports/memory.ts'
import type { ClockPort, LoggerPort } from './ports/misc.ts'

export type ProviderSummarizerOptions = {
  /** Proveedor con el que se hace el turno (Claude Haiku, Gemini Flash, Codex...). */
  provider: AgentProviderPort
  /** Modelo del proveedor (`haiku`, `gemini-2.5-flash`...); sin él, el que el proveedor use por omisión. */
  model?: string
  /** Carpeta neutra donde abre la sesión (no es la del proyecto: el resumidor no necesita ver archivos). */
  cwd: string
  clock: ClockPort
  /** Plazo de un turno (ms). */
  timeoutMs?: number
  logger?: LoggerPort
}

export const DEFAULT_PROVIDER_SUMMARIZER_TIMEOUT_MS = 180_000
/** Tope de texto que se acepta de un turno (el modelo puede divagar sin fin). */
const MAX_OUTPUT_CHARS = 256 * 1024

type Outcome =
  | { ok: true; text: string; usage: SummarizerUsage }
  | { ok: false; error: SummarizerError }

/**
 * Resumidor «vía proveedor»: usa cualquier `AgentProviderPort` para hacer **un turno de solo texto** y
 * recoger lo que contesta. Nexo no lee credenciales: se sirve de la sesión que el usuario ya tiene con ese
 * CLI. La sesión se abre directamente en el proveedor, **no** a través de `AgentService`, así que no crea
 * panel ni pestaña ni cuenta como sesión del usuario.
 *
 * Sin herramientas: se abre en modo `plan` (o `ask` si el proveedor no declara `plan`), y si el turno pide
 * un permiso, hace una pregunta o abre una acción, se interrumpe y falla con `INVALID_OUTPUT`: el resumidor
 * solo escribe texto. Cada llamada abre su propia sesión y la cierra al terminar, falle o no.
 */
export class ProviderSummarizer implements SummarizerPort {
  readonly id: string
  readonly #o: ProviderSummarizerOptions

  constructor(options: ProviderSummarizerOptions) {
    this.#o = options
    this.id =
      `provider:${options.provider.id}${options.model === undefined ? '' : `:${options.model}`}`.slice(
        0,
        256,
      )
  }

  isAvailable(): Promise<boolean> {
    return this.#o.provider.isAvailable().catch(() => false)
  }

  async summarize(
    request: SummarizeRequest,
    options: { signal?: AbortSignalLike } = {},
  ): Promise<SummarizeResponse> {
    const signal = options.signal
    if (signal?.aborted) throw new SummarizerError('ABORTED', 'cancelado', { retryable: false })
    const prompt = combinePrompt(
      request.kind === 'observe' ? buildObserverPrompt(request) : buildReflectorPrompt(request),
    )
    const session = await this.#open(signal)
    let outcome: Outcome
    try {
      outcome = await this.#turn(session, prompt, signal)
    } finally {
      await session.close().catch((error: unknown) => {
        this.#o.logger?.warn('no se pudo cerrar la sesión del resumidor', { error })
      })
    }
    if (!outcome.ok) throw outcome.error
    if (request.kind === 'observe') {
      return {
        kind: 'observe',
        content: { format: 'text', text: outcome.text },
        usage: outcome.usage,
      }
    }
    return { kind: 'reflect', text: outcome.text, usage: outcome.usage }
  }

  async #open(signal: AbortSignalLike | undefined): Promise<AgentProviderSession> {
    const { provider, model, cwd } = this.#o
    try {
      const caps = await provider.capabilities()
      const mode = caps.permissionModes.includes('plan') ? 'plan' : 'ask'
      if (signal?.aborted) throw new SummarizerError('ABORTED', 'cancelado', { retryable: false })
      return await provider.open({
        cwd,
        permissionMode: mode,
        ...(model === undefined ? {} : { model: model as Token }),
      })
    } catch (error) {
      if (error instanceof SummarizerError) throw error
      if (error instanceof AgentProviderError && error.code === 'INVALID_OPTIONS') {
        throw new SummarizerError(
          'UNAVAILABLE',
          `opciones no válidas para ${provider.id}: ${error.message}`,
          {
            cause: error,
            retryable: false,
          },
        )
      }
      throw new SummarizerError('UNAVAILABLE', `no se pudo abrir ${provider.id}`, {
        cause: error,
        retryable: true,
      })
    }
  }

  #turn(
    session: AgentProviderSession,
    prompt: string,
    signal: AbortSignalLike | undefined,
  ): Promise<Outcome> {
    return new Promise<Outcome>((resolve) => {
      const texts = new Map<string, string>()
      let usage: SummarizerUsage = {}
      let settled = false
      let cancelTimer: (() => void) | undefined
      let off: (() => void) | undefined
      const started = this.#o.clock.now()

      const finish = (outcome: Outcome, interrupt = false) => {
        if (settled) return
        settled = true
        cancelTimer?.()
        off?.()
        signal?.removeEventListener('abort', onAbort)
        if (interrupt) void session.interrupt().catch(() => {})
        resolve(outcome)
      }
      const fail = (
        code: SummarizerError['code'],
        message: string,
        retryable: boolean,
        interrupt = true,
      ) =>
        finish({ ok: false, error: new SummarizerError(code, message, { retryable }) }, interrupt)
      const onAbort = () => fail('ABORTED', 'cancelado', false)

      const onEvent = (event: ProviderEvent) => {
        if (settled) return
        switch (event.type) {
          case 'block-start':
          case 'block-update':
            if (event.block.type === 'action') {
              fail('INVALID_OUTPUT', 'el resumidor intentó usar una herramienta', false)
            } else if (event.block.type === 'text') {
              texts.set(event.ref, event.block.text)
            }
            break
          case 'block-delta':
            if (event.field === 'text' && texts.has(event.ref)) {
              texts.set(event.ref, (texts.get(event.ref) ?? '') + event.text)
              let size = 0
              for (const t of texts.values()) size += t.length
              if (size > MAX_OUTPUT_CHARS)
                fail('INVALID_OUTPUT', 'la respuesta es demasiado larga', false)
            }
            break
          case 'block-end':
            if (event.block?.type === 'text') texts.set(event.ref, event.block.text)
            break
          case 'permission-request':
          case 'question-request':
            fail('INVALID_OUTPUT', 'el resumidor pidió un permiso o hizo una pregunta', false)
            break
          case 'usage':
            usage = toUsage(event.usage, this.#o, started, this.#o.clock.now())
            break
          case 'error':
            fail(
              event.error.fatal ? 'UNAVAILABLE' : 'INVALID_OUTPUT',
              `el proveedor falló: ${event.error.message.slice(0, 200)}`,
              event.error.retryable ?? false,
              false,
            )
            break
          case 'exit':
            fail('UNAVAILABLE', 'el proveedor terminó antes de contestar', true, false)
            break
          case 'turn-end': {
            if (event.usage !== undefined) {
              usage = toUsage(event.usage, this.#o, started, this.#o.clock.now())
            } else if (usage.durationMs === undefined) {
              usage = { ...usage, durationMs: this.#o.clock.now() - started }
            }
            if (['interrupted', 'error', 'refusal'].includes(event.stopReason)) {
              fail('INVALID_OUTPUT', `el turno terminó con ${event.stopReason}`, false, false)
              break
            }
            const text = [...texts.values()].join('\n').trim()
            if (text === '') fail('INVALID_OUTPUT', 'el resumidor no escribió texto', false, false)
            else finish({ ok: true, text, usage })
            break
          }
          default:
            break
        }
      }

      off = session.onEvent(onEvent)
      signal?.addEventListener('abort', onAbort, { once: true })
      cancelTimer = this.#o.clock.setTimeout(
        () => fail('TIMEOUT', 'el resumidor tardó demasiado', true),
        this.#o.timeoutMs ?? DEFAULT_PROVIDER_SUMMARIZER_TIMEOUT_MS,
      )
      session.send(prompt).catch((error: unknown) => {
        const busy = error instanceof AgentProviderError && error.code === 'INVALID_OPTIONS'
        fail('UNAVAILABLE', `no se pudo enviar al proveedor: ${errorText(error)}`, !busy, false)
      })
    })
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : 'error').slice(0, 200)
}

function toUsage(
  turn: NonNullable<Extract<ProviderEvent, { type: 'usage' }>['usage']>,
  options: ProviderSummarizerOptions,
  started: number,
  now: number,
): SummarizerUsage {
  return {
    ...(options.model === undefined ? {} : { model: options.model as Token }),
    ...(turn.inputTokens === undefined ? {} : { inputTokens: turn.inputTokens }),
    ...(turn.outputTokens === undefined ? {} : { outputTokens: turn.outputTokens }),
    ...(turn.costUsd === undefined ? {} : { costUsd: turn.costUsd }),
    durationMs: turn.durationMs ?? Math.max(0, Math.trunc(now - started)),
  }
}
