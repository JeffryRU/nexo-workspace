import type { PermissionOption, ProviderCapabilities, ProviderEvent } from '@nexo/contracts'
import {
  type AgentOpenOptions,
  AgentProviderError,
  type AgentProviderPort,
  type AgentProviderSession,
  type AgentResponse,
  type Unsubscribe,
} from '@nexo/core'

/**
 * Proveedor de agente determinista para pruebas de integración y E2E (`NEXO_AGENT_PROVIDERS=fake`). No
 * llama a ningún modelo: responde según el texto del mensaje. Existe en la app (y no en `testkit`) porque
 * el daemon real, lanzado como proceso, tiene que poder usarlo y producción no importa `testkit`.
 *
 * - `largo`: empieza a responder y no termina hasta `interrupt`.
 * - `lento [n]`: n trozos (30 por omisión) de "palabra " cada `chunkMs`; sirve para cortar a mitad de respuesta.
 * - `permiso`: pide permiso para una acción; sigue según la respuesta.
 * - `pregunta`: pregunta A o B; responde con la elección.
 * - `editar`: una acción `edit` con un diff unificado (sin pedir permiso).
 * - `ansi`: una acción `exec` cuya salida lleva colores ANSI (SGR) y otras secuencias.
 * - `charla [n]`: n párrafos cortos (20 por omisión, hasta 5 000) de 10 trozos cada uno: una conversación larga y continua, sin
 *   un único bloque enorme (a diferencia de `lento 10000`).
 * - `bloques [n]`: n bloques de texto completos (100 por omisión, hasta 9 000) para documentos largos.
 * - cualquier otro: `Eco: <texto>`.
 */
export type ScriptedProviderOptions = {
  /** Retardo entre trozos de `lento` (ms). */
  chunkMs?: number
}

const CAPABILITIES: ProviderCapabilities = {
  models: [{ id: 'fake-1', label: 'Fake 1', efforts: ['low', 'high'] }],
  defaultModel: 'fake-1',
  efforts: ['low', 'high'],
  permissionModes: ['ask', 'accept-edits', 'plan', 'bypass'],
  resume: true,
  warmup: true,
  streaming: true,
}

const EDIT_PATCH = [
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,4 +1,4 @@',
  ' import { start } from "./start"',
  '-const port = 3000',
  '+const port = 4317',
  ' start(port)',
  '',
].join('\n')

/** Rojo, verde en negrita, amarillo tenue y una secuencia de cursor que la interfaz debe descartar. */
const ANSI_OUTPUT =
  '\u001b[31merror\u001b[0m: falló\n\u001b[1;32mok\u001b[0m: pasó\n\u001b[2;33maviso\u001b[0m\u001b[2K fin\n'

const PERMISSION_OPTIONS: PermissionOption[] = [
  { id: 'allow', label: 'Permitir', kind: 'allow-once' },
  { id: 'deny', label: 'Rechazar', kind: 'reject-once' },
]

type Waiter = { resolve: (response: AgentResponse) => void; kind: 'permission' | 'question' }

class Cancelled extends Error {}

export class ScriptedSession implements AgentProviderSession {
  readonly providerSessionId: string
  readonly #listeners = new Set<(event: ProviderEvent) => void>()
  readonly #waiters = new Map<string, Waiter>()
  readonly #chunkMs: number
  #active = false
  #closed = false
  #exited = false
  #epoch = 0
  #timer: ReturnType<typeof setTimeout> | undefined
  #wake: (() => void) | undefined
  #n = 0

  constructor(id: string, chunkMs: number) {
    this.providerSessionId = id
    this.#chunkMs = chunkMs
  }

  get closed(): boolean {
    return this.#closed
  }

  onEvent(listener: (event: ProviderEvent) => void): Unsubscribe {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #emit(event: ProviderEvent): void {
    for (const l of [...this.#listeners]) l(event)
  }

  async send(text: string): Promise<void> {
    if (this.#closed) throw new AgentProviderError('CLOSED', 'la sesión está cerrada')
    if (text.length === 0) throw new AgentProviderError('INVALID_OPTIONS', 'mensaje vacío')
    if (this.#active) throw new AgentProviderError('BUSY', 'ya hay un turno en curso')
    this.#active = true
    const epoch = this.#epoch
    void this.#turn(text, epoch).then(
      () => {
        if (epoch === this.#epoch && !this.#closed) this.#finish('end-turn')
      },
      (error: unknown) => {
        if (!(error instanceof Cancelled)) throw error
      },
    )
  }

  #finish(stopReason: 'end-turn' | 'interrupted'): void {
    this.#active = false
    this.#emit({ type: 'turn-end', stopReason, usage: { inputTokens: 1, outputTokens: 1 } })
  }

  /** Espera `ms`; rechaza con `Cancelled` si se interrumpe o se cierra antes. */
  #delay(ms: number, epoch: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (epoch !== this.#epoch) return reject(new Cancelled())
      this.#wake = () => reject(new Cancelled())
      this.#timer = setTimeout(
        () => {
          this.#wake = undefined
          resolve()
        },
        Math.max(0, ms),
      )
    })
  }

  #ask(requestId: string, kind: Waiter['kind'], epoch: number): Promise<AgentResponse> {
    return new Promise((resolve, reject) => {
      if (epoch !== this.#epoch) return reject(new Cancelled())
      this.#wake = () => reject(new Cancelled())
      this.#waiters.set(requestId, { kind, resolve })
    })
  }

  async #text(parts: readonly string[], epoch: number, gapMs = 0): Promise<void> {
    const ref = `text-${++this.#n}`
    this.#emit({ type: 'block-start', ref, block: { type: 'text', text: '', complete: false } })
    for (const part of parts) {
      await this.#delay(gapMs, epoch)
      this.#emit({ type: 'block-delta', ref, field: 'text', text: part })
    }
    this.#emit({
      type: 'block-end',
      ref,
      block: { type: 'text', text: parts.join(''), complete: true },
    })
  }

  async #turn(text: string, epoch: number): Promise<void> {
    const word = text.split(/\s+/, 1)[0] ?? ''
    if (word === 'largo') {
      const ref = `text-${++this.#n}`
      this.#emit({ type: 'block-start', ref, block: { type: 'text', text: '', complete: false } })
      this.#emit({ type: 'block-delta', ref, field: 'text', text: 'pensando' })
      await new Promise<never>((_, reject) => {
        this.#wake = () => reject(new Cancelled())
      })
      return
    }
    if (word === 'lento') {
      const n = Math.min(10_000, Math.max(1, Number(text.split(/\s+/)[1] ?? 30) || 30))
      await this.#text(
        Array.from({ length: n }, () => 'palabra '),
        epoch,
        this.#chunkMs,
      )
      return
    }
    if (word === 'charla') {
      const n = Math.min(5000, Math.max(1, Number(text.split(/\s+/)[1] ?? 20) || 20))
      for (let i = 1; i <= n; i++) {
        await this.#text(
          Array.from({ length: 10 }, () => 'palabra '),
          epoch,
          this.#chunkMs,
        )
      }
      return
    }
    if (word === 'bloques') {
      const n = Math.min(9000, Math.max(1, Number(text.split(/\s+/)[1] ?? 100) || 100))
      for (let i = 1; i <= n; i++) {
        const ref = `text-${++this.#n}`
        const body = `Bloque ${i} de ${n}: **texto** de relleno para medir el desplazamiento.`
        this.#emit({ type: 'block-start', ref, block: { type: 'text', text: '', complete: false } })
        this.#emit({ type: 'block-end', ref, block: { type: 'text', text: body, complete: true } })
        // Cede el turno de vez en cuando: una ráfaga de miles de eventos no debe ahogar el daemon.
        if (i % 100 === 0) await this.#delay(0, epoch)
      }
      return
    }
    if (word === 'permiso') {
      const ref = `call-${++this.#n}`
      const requestId = `req-${this.#n}`
      const draft = { type: 'action', kind: 'exec', tool: 'Bash', title: 'ls' } as const
      this.#emit({ type: 'block-start', ref, block: { ...draft, status: 'running' } })
      this.#emit({
        type: 'permission-request',
        requestId,
        tool: 'Bash',
        title: 'Ejecutar ls',
        options: PERMISSION_OPTIONS,
      })
      const response = await this.#ask(requestId, 'permission', epoch)
      const allowed = response.type === 'permission' && response.optionId === 'allow'
      this.#emit({
        type: 'block-end',
        ref,
        block: allowed
          ? { ...draft, status: 'ok', output: 'a.txt\n', exitCode: 0 }
          : { ...draft, status: 'error', output: 'rechazado', exitCode: 1 },
      })
      await this.#text([allowed ? 'Permiso concedido' : 'Permiso rechazado'], epoch)
      return
    }
    if (word === 'editar' || word === 'ansi') {
      const ref = `call-${++this.#n}`
      const draft =
        word === 'editar'
          ? ({
              type: 'action',
              kind: 'edit',
              tool: 'Edit',
              title: 'Editar src/app.ts',
              path: 'src/app.ts',
            } as const)
          : ({ type: 'action', kind: 'exec', tool: 'Bash', title: 'npm test' } as const)
      this.#emit({ type: 'block-start', ref, block: { ...draft, status: 'running' } })
      await this.#delay(this.#chunkMs, epoch)
      this.#emit({
        type: 'block-end',
        ref,
        block:
          word === 'editar'
            ? { ...draft, status: 'ok', diff: { path: 'src/app.ts', patch: EDIT_PATCH } }
            : { ...draft, status: 'ok', output: ANSI_OUTPUT, exitCode: 0 },
      })
      await this.#text([word === 'editar' ? 'Edición aplicada' : 'Salida con colores'], epoch)
      return
    }
    if (word === 'pregunta') {
      const requestId = `req-${++this.#n}`
      this.#emit({
        type: 'question-request',
        requestId,
        questions: [
          {
            id: 'q1',
            question: '¿Qué prefieres?',
            options: [{ label: 'A' }, { label: 'B' }],
            multiSelect: false,
            allowText: false,
          },
        ],
      })
      const response = await this.#ask(requestId, 'question', epoch)
      const picked =
        response.type === 'question' ? (response.answers[0]?.selected.join(', ') ?? '') : ''
      await this.#text([`Elegiste: ${picked}`], epoch)
      return
    }
    await this.#text([`Eco: ${text.slice(0, 2000)}`], epoch)
  }

  #cancelRun(): void {
    this.#epoch++
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    const wake = this.#wake
    this.#wake = undefined
    wake?.()
  }

  async interrupt(): Promise<void> {
    if (this.#closed || !this.#active) return
    this.#cancelRun()
    for (const requestId of [...this.#waiters.keys()]) {
      this.#waiters.delete(requestId)
      this.#emit({ type: 'request-cancelled', requestId })
    }
    this.#finish('interrupted')
  }

  async respond(response: AgentResponse): Promise<void> {
    if (this.#closed) throw new AgentProviderError('CLOSED', 'la sesión está cerrada')
    const waiter = this.#waiters.get(response.requestId)
    if (waiter === undefined || waiter.kind !== response.type) {
      throw new AgentProviderError(
        'UNKNOWN_REQUEST',
        `solicitud desconocida: ${response.requestId}`,
      )
    }
    if (
      response.type === 'permission' &&
      !PERMISSION_OPTIONS.some((o) => o.id === response.optionId)
    ) {
      throw new AgentProviderError('INVALID_OPTIONS', 'opción desconocida')
    }
    this.#waiters.delete(response.requestId)
    this.#wake = undefined
    waiter.resolve(response)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#active = false
    this.#waiters.clear()
    this.#cancelRun()
    if (!this.#exited) {
      this.#exited = true
      this.#emit({ type: 'exit', exitCode: 0, signal: null })
    }
  }
}

export class ScriptedAgentProvider implements AgentProviderPort {
  readonly id = 'fake'
  readonly displayName = 'Proveedor de prueba'
  readonly warmed: string[] = []
  /** Sesiones abiertas (para que las pruebas comprueben que se cierran). */
  readonly sessions: ScriptedSession[] = []
  readonly #chunkMs: number
  readonly #known = new Set<string>()
  #n = 0

  constructor(options: ScriptedProviderOptions = {}) {
    this.#chunkMs = options.chunkMs ?? 20
  }

  async isAvailable(): Promise<boolean> {
    return true
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return CAPABILITIES
  }

  async warmUp(options: Pick<AgentOpenOptions, 'cwd'>): Promise<void> {
    this.warmed.push(options.cwd)
  }

  async open(options: AgentOpenOptions): Promise<AgentProviderSession> {
    if (options.cwd.length === 0) throw new AgentProviderError('INVALID_OPTIONS', 'cwd vacío')
    if (options.model !== undefined && options.model !== 'fake-1') {
      throw new AgentProviderError('INVALID_OPTIONS', `modelo no declarado: ${options.model}`)
    }
    if (options.effort !== undefined && !CAPABILITIES.efforts.includes(options.effort)) {
      throw new AgentProviderError('INVALID_OPTIONS', `esfuerzo no declarado: ${options.effort}`)
    }
    let id: string
    if (options.resume !== undefined) {
      if (!this.#known.has(options.resume)) {
        throw new AgentProviderError('INVALID_OPTIONS', 'no se puede reanudar esa sesión')
      }
      id = options.resume
    } else {
      id = `fake-session-${++this.#n}`
      this.#known.add(id)
    }
    const session = new ScriptedSession(id, this.#chunkMs)
    this.sessions.push(session)
    return session
  }
}
