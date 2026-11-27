import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type {
  CanUseTool,
  Options,
  PermissionResult,
  Query,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { claudeMemoryOptions } from './memory-injection.ts'
import {
  type ClaudeTransport,
  type ClaudeTransportSession,
  type PermissionAsk,
  type PermissionDecision,
  TransportError,
  type TransportModel,
  type TransportStartOptions,
} from './transport.ts'

type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')

/** Lo que el transporte necesita del SDK; las pruebas lo sustituyen. */
export type SdkApi = Pick<SdkModule, 'query' | 'startup' | 'getSessionInfo'> &
  Partial<Pick<SdkModule, 'listSessions' | 'getSessionMessages'>>

export type SdkTransportOptions = {
  env: Readonly<Record<string, string | undefined>>
  pathToClaudeCodeExecutable?: string
  /** Carga el SDK (importación dinámica por omisión: un daemon sin él arranca igual). */
  loadSdk?: () => Promise<SdkApi>
  /** Comprueba que el ejecutable exista. */
  fileExists?: (path: string) => Promise<boolean>
  /** Ruta del ejecutable que trae el SDK, si se encuentra. */
  resolveBundledExecutable?: () => string[]
  /** Segundos que vive un proceso precalentado sin que nadie lo reclame. */
  warmTtlMs?: number
}

const MAX_WARM = 4
const MODELS_TIMEOUT_MS = 15_000

/** Cola asíncrona de mensajes de usuario: la «entrada en streaming» del SDK. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  readonly #items: SDKUserMessage[] = []
  #wake: (() => void) | undefined
  #closed = false

  push(text: string): void {
    if (this.#closed) throw new Error('entrada cerrada')
    this.#items.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    })
    this.#wake?.()
  }

  close(): void {
    this.#closed = true
    this.#wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const item = this.#items.shift()
      if (item !== undefined) yield item
      else if (this.#closed) return
      else await new Promise<void>((resolve) => (this.#wake = resolve))
    }
  }
}

type Routes = {
  canUseTool: TransportStartOptions['canUseTool']
  onStderr: ((data: string) => void) | undefined
}

type Warm = {
  cwd: string
  sessionId: string
  routes: Routes
  handle: { query(prompt: AsyncIterable<SDKUserMessage>): Query; close(): void }
  timer: ReturnType<typeof setTimeout>
}

const denyAll = (): Promise<PermissionDecision> =>
  Promise.resolve({ behavior: 'deny', message: 'La sesión aún no está lista.' })

function toResult(decision: PermissionDecision): PermissionResult {
  if (decision.behavior === 'deny') {
    return {
      behavior: 'deny',
      message: decision.message,
      ...(decision.interrupt === undefined ? {} : { interrupt: decision.interrupt }),
    }
  }
  return {
    behavior: 'allow',
    ...(decision.updatedInput === undefined ? {} : { updatedInput: decision.updatedInput }),
    ...(decision.updatedPermissions === undefined
      ? {}
      : { updatedPermissions: [...decision.updatedPermissions] as never }),
  }
}

function canUseToolFor(routes: Routes): CanUseTool {
  return async (toolName, input, o) => {
    const ask: PermissionAsk = {
      toolName,
      input,
      toolUseId: o.toolUseID,
      signal: o.signal,
      ...(o.title === undefined ? {} : { title: o.title }),
      ...(o.displayName === undefined ? {} : { displayName: o.displayName }),
      ...(o.description === undefined ? {} : { description: o.description }),
      ...(o.blockedPath === undefined ? {} : { blockedPath: o.blockedPath }),
      ...(o.suggestions === undefined ? {} : { suggestions: o.suggestions }),
    }
    return toResult(await routes.canUseTool(ask))
  }
}

/** Transporte real sobre `@anthropic-ai/claude-agent-sdk`. */
export function createSdkTransport(options: SdkTransportOptions): ClaudeTransport {
  return new SdkTransport(options)
}

class SdkTransport implements ClaudeTransport {
  readonly #o: SdkTransportOptions
  #sdk: Promise<SdkApi> | undefined
  readonly #warm = new Map<string, Warm>()
  readonly #warming = new Map<string, Promise<void>>()

  constructor(options: SdkTransportOptions) {
    this.#o = options
  }

  #load(): Promise<SdkApi> {
    this.#sdk ??= (this.#o.loadSdk ?? (() => import('@anthropic-ai/claude-agent-sdk')))()
    return this.#sdk
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.#load()
    } catch {
      this.#sdk = undefined
      return false
    }
    const exists = this.#o.fileExists ?? defaultFileExists
    const explicit = this.#o.pathToClaudeCodeExecutable
    const candidates = explicit === undefined ? this.#bundled() : [explicit]
    for (const candidate of candidates) if (await exists(candidate)) return true
    return false
  }

  #bundled(): string[] {
    return (this.#o.resolveBundledExecutable ?? bundledExecutables)()
  }

  #baseOptions(cwd: string, routes: Routes): Options {
    const env: Record<string, string | undefined> = { ...this.#o.env }
    return {
      cwd,
      env,
      includePartialMessages: true,
      canUseTool: canUseToolFor(routes),
      stderr: (data) => routes.onStderr?.(data),
      ...(this.#o.pathToClaudeCodeExecutable === undefined
        ? {}
        : { pathToClaudeCodeExecutable: this.#o.pathToClaudeCodeExecutable }),
    }
  }

  async listSessions(o: { cwd?: string; limit: number }): Promise<unknown[]> {
    const sdk = await this.#load()
    if (sdk.listSessions === undefined) {
      throw new TransportError('UNAVAILABLE', 'este SDK de Claude no lista sesiones')
    }
    return sdk.listSessions({
      ...(o.cwd === undefined ? {} : { dir: o.cwd }),
      limit: o.limit,
      includeWorktrees: false,
    })
  }

  async readSession(o: {
    sessionId: string
    cwd?: string
    maxMessages: number
  }): Promise<{ exists: boolean; messages: unknown[] }> {
    const sdk = await this.#load()
    if (sdk.getSessionMessages === undefined) {
      throw new TransportError('UNAVAILABLE', 'este SDK de Claude no lee sesiones')
    }
    const dir = o.cwd === undefined ? {} : { dir: o.cwd }
    const info = await sdk.getSessionInfo(o.sessionId, dir)
    if (info === undefined) return { exists: false, messages: [] }
    const messages = await sdk.getSessionMessages(o.sessionId, { ...dir, limit: o.maxMessages })
    return { exists: true, messages }
  }

  async start(o: TransportStartOptions): Promise<ClaudeTransportSession> {
    const sdk = await this.#load()
    if (o.resume !== undefined) {
      const known = await sdk
        .getSessionInfo(o.resume, { dir: o.cwd })
        .then((info) => info ?? sdk.getSessionInfo(o.resume as string))
        .catch(() => 'unknown' as const)
      if (known === undefined) {
        throw new TransportError('UNKNOWN_SESSION', 'la sesión de Claude no existe')
      }
    }
    const queue = new InputQueue()
    const routes: Routes = { canUseTool: o.canUseTool, onStderr: o.onStderr }

    const warm = this.#claim(o)
    if (warm !== undefined) {
      warm.routes.canUseTool = o.canUseTool
      warm.routes.onStderr = o.onStderr
      const query = warm.handle.query(queue)
      try {
        if (o.model !== undefined) await query.setModel(o.model)
        if (o.permissionMode !== 'default') await query.setPermissionMode(o.permissionMode)
        return wrap(query, queue, warm.sessionId)
      } catch {
        query.close()
        queue.close()
        // cae al arranque normal
      }
    }

    const fresh = new InputQueue()
    const sessionId = o.resume ?? randomUUID()
    const options: Options = {
      ...this.#baseOptions(o.cwd, routes),
      permissionMode: o.permissionMode,
      ...(o.model === undefined ? {} : { model: o.model }),
      ...(o.effort === undefined ? {} : { effort: o.effort as NonNullable<Options['effort']> }),
      ...(o.resume === undefined ? { sessionId } : { resume: o.resume }),
      ...(o.permissionMode === 'bypassPermissions'
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      ...(o.memory === undefined ? {} : claudeMemoryOptions(o.memory)),
    }
    return wrap(sdk.query({ prompt: fresh, options }), fresh, sessionId)
  }

  /** Un proceso precalentado en `cwd` sirve si no hace falta nada que solo se fija al arrancar. */
  #claim(o: TransportStartOptions): Warm | undefined {
    const warm = this.#warm.get(o.cwd)
    if (warm === undefined) return undefined
    // El prompt de sistema y los hooks solo se fijan al arrancar: con memoria no sirve un proceso precalentado.
    if (
      o.memory !== undefined ||
      o.resume !== undefined ||
      o.effort !== undefined ||
      o.permissionMode === 'bypassPermissions'
    ) {
      return undefined
    }
    this.#warm.delete(o.cwd)
    clearTimeout(warm.timer)
    return warm
  }

  warmUp({ cwd }: { cwd: string }): Promise<void> {
    if (this.#warm.has(cwd)) return Promise.resolve()
    const running = this.#warming.get(cwd)
    if (running !== undefined) return running
    const task = this.#spawnWarm(cwd).finally(() => this.#warming.delete(cwd))
    this.#warming.set(cwd, task)
    return task
  }

  async #spawnWarm(cwd: string): Promise<void> {
    const sdk = await this.#load()
    const routes: Routes = { canUseTool: denyAll, onStderr: undefined }
    const sessionId = randomUUID()
    const handle = await sdk.startup({
      options: { ...this.#baseOptions(cwd, routes), permissionMode: 'default', sessionId },
    })
    if (this.#warm.size >= MAX_WARM) {
      const oldest = this.#warm.keys().next().value
      if (oldest !== undefined) this.#drop(oldest)
    }
    const timer = setTimeout(() => this.#drop(cwd), this.#o.warmTtlMs ?? 5 * 60_000)
    timer.unref?.()
    this.#warm.set(cwd, { cwd, sessionId, routes, handle, timer })
  }

  #drop(cwd: string): void {
    const warm = this.#warm.get(cwd)
    if (warm === undefined) return
    this.#warm.delete(cwd)
    clearTimeout(warm.timer)
    try {
      warm.handle.close()
    } catch {
      // ya estaba cerrado
    }
  }

  async listModels({ cwd }: { cwd: string }): Promise<TransportModel[]> {
    const sdk = await this.#load()
    const routes: Routes = { canUseTool: denyAll, onStderr: undefined }
    const queue = new InputQueue()
    const query = sdk.query({ prompt: queue, options: this.#baseOptions(cwd, routes) })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const models = await Promise.race([
        query.supportedModels(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('tiempo agotado')), MODELS_TIMEOUT_MS)
        }),
      ])
      return models.map((m) => ({
        id: m.value,
        label: m.displayName,
        ...(m.supportedEffortLevels === undefined ? {} : { efforts: [...m.supportedEffortLevels] }),
      }))
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      queue.close()
      query.close()
    }
  }
}

function wrap(query: Query, queue: InputQueue, sessionId: string): ClaudeTransportSession {
  let closed = false
  return {
    sessionId,
    messages: query,
    send: (text) => queue.push(text),
    interrupt: async () => {
      await query.interrupt()
    },
    close: () => {
      if (closed) return
      closed = true
      queue.close()
      query.close()
    },
  }
}

async function defaultFileExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  )
}

/** El SDK trae el ejecutable en un paquete opcional por plataforma, junto a él en `node_modules`. */
function bundledExecutables(): string[] {
  try {
    const sdkPath = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk')
    const scope = join(dirname(sdkPath), '..')
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
    const base = `claude-agent-sdk-${process.platform}-${process.arch}`
    const names = process.platform === 'linux' ? [base, `${base}-musl`] : [base]
    return names.map((name) => join(scope, name, exe))
  } catch {
    return []
  }
}
