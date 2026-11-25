import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NexoClientError } from '@nexo/client'
import { discoverDaemon } from '@nexo/client/node'
import type {
  EventData,
  EventName,
  MethodName,
  MethodParams,
  MethodResult,
  Workspace,
} from '@nexo/contracts'
import { type ClientLike, Ctx, type Deps } from './context.ts'

type Handler = (params: unknown) => unknown

/** Cliente falso: respuestas por método, llamadas registradas y eventos emitibles a mano. */
export class FakeClient implements ClientLike {
  readonly calls: { method: string; params: unknown }[] = []
  readonly handlers = new Map<string, Handler>()
  readonly #listeners = new Map<string, Set<(...args: never[]) => void>>()
  workspaces: Workspace[] = []
  closed = false
  subscribed: EventName[] | undefined

  constructor() {
    this.handlers.set('workspace.list', () => ({ workspaces: this.workspaces }))
  }

  on(event: string, handler: (...args: never[]) => void): () => void {
    let set = this.#listeners.get(event)
    if (set === undefined) {
      set = new Set()
      this.#listeners.set(event, set)
    }
    set.add(handler)
    return () => set.delete(handler)
  }

  emit<E extends EventName>(event: E, data: EventData<E>): void {
    for (const h of [...(this.#listeners.get(event) ?? [])]) (h as (d: unknown) => void)(data)
  }

  emitState(state: string): void {
    for (const h of [...(this.#listeners.get('state') ?? [])]) (h as (s: string) => void)(state)
  }

  emitResync(): void {
    for (const h of [...(this.#listeners.get('resync') ?? [])]) (h as (i: unknown) => void)({})
  }

  listenerCount(event: string): number {
    return this.#listeners.get(event)?.size ?? 0
  }

  async subscribe(events?: EventName[]): Promise<MethodResult<'events.subscribe'>> {
    this.subscribed = events
    return { seq: 0 }
  }

  close(): void {
    this.closed = true
  }

  async call<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    this.calls.push({ method, params })
    const handler = this.handlers.get(method)
    if (handler === undefined) return {} as MethodResult<M>
    return handler(params) as MethodResult<M>
  }

  callsTo(method: string): unknown[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.params)
  }
}

export const WORK = resolve('/work/proyecto')

export class Capture {
  out = ''
  err = ''
}

export type TestEnv = {
  client: FakeClient
  cap: Capture
  deps: Deps
  abort: AbortController
  connects: { autostart: boolean }[]
}

export function makeEnv(
  options: {
    stdin?: () => AsyncIterable<Uint8Array | string>
    env?: Record<string, string | undefined>
    platform?: NodeJS.Platform
    connect?: Deps['connect']
    daemon?: Partial<Deps['daemon']>
    cwd?: string
    columns?: number
    rows?: number
  } = {},
): TestEnv {
  const client = new FakeClient()
  const cap = new Capture()
  const abort = new AbortController()
  const connects: { autostart: boolean }[] = []
  const deps: Deps = {
    io: {
      stdout: {
        write: (t) => {
          cap.out += t
        },
      },
      stderr: {
        write: (t) => {
          cap.err += t
        },
      },
      stdin: options.stdin ?? async function* () {},
      columns: options.columns,
      rows: options.rows,
    },
    connect:
      options.connect ??
      (async (o) => {
        connects.push(o)
        return client
      }),
    daemon: {
      stateDir: () => '/estado',
      locate: async () => ({ port: 4317, pid: 99 }),
      readLog: async () => undefined,
      ...options.daemon,
    },
    env: options.env ?? {},
    platform: options.platform ?? 'linux',
    cwd: () => options.cwd ?? WORK,
    signal: abort.signal,
    sleep: async () => {},
  }
  return { client, cap, deps, abort, connects }
}

export function makeCtx(env: TestEnv, options: { json?: boolean; autostart?: boolean } = {}): Ctx {
  return new Ctx(env.deps, { json: options.json ?? false, autostart: options.autostart ?? true })
}

export function workspace(
  id: string,
  name: string,
  tabs: {
    id: string
    title: string
    panes: { id: string; terminalId?: string; title?: string }[]
  }[],
  cwd?: string,
): Workspace {
  return {
    id,
    name,
    ...(cwd === undefined ? {} : { cwd }),
    tabs: tabs.map((t) => ({
      id: t.id,
      title: t.title,
      layout: { type: 'leaf', paneId: t.panes[0]?.id as string },
      panes: t.panes.map((p) => ({
        id: p.id,
        kind: 'terminal' as const,
        title: p.title ?? 'Terminal',
        ...(p.terminalId === undefined ? {} : { terminalId: p.terminalId }),
        attention: 'idle' as const,
      })),
      focusedPaneId: t.panes[0]?.id as string,
    })),
    ...(tabs[0] === undefined ? {} : { activeTabId: tabs[0].id }),
  } as unknown as Workspace
}

export const clientError = (
  code: NexoClientError['code'],
  message: string = code,
  data?: unknown,
) => new NexoClientError(code, message, data)

/** Dos espacios con ids parecidos a los reales. */
export function sampleWorkspaces(): Workspace[] {
  return [
    workspace(
      'ws-aaaa1111-0000',
      'proyecto',
      [
        {
          id: 'tab-bbbb2222-0000',
          title: 'servidor',
          panes: [
            { id: 'pane-cccc3333-0000', terminalId: 'term-dddd4444-0000', title: 'bash' },
            { id: 'pane-cccc3333-1111' },
          ],
        },
        { id: 'tab-bbbb2222-1111', title: 'pruebas', panes: [{ id: 'pane-eeee5555-0000' }] },
      ],
      WORK,
    ),
    workspace('ws-ffff6666-0000', 'otro', [], resolve('/work/otro')),
  ]
}

// ---- ayudas para pruebas de integración (procesos reales) ----

export const CLI_MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))
export const DAEMON_MAIN = fileURLToPath(new URL('../../daemon/src/main.ts', import.meta.url))

export type RunResult = { code: number | null; stdout: string; stderr: string }

/** Una prueba de integración: directorio de estado temporal y limpieza de todo lo que lanzó. */
export class Sandbox {
  readonly dir: string
  readonly children: ChildProcess[] = []

  private constructor(dir: string) {
    this.dir = dir
  }

  static async create(): Promise<Sandbox> {
    return new Sandbox(await mkdtemp(join(tmpdir(), 'nexo-cli-int-')))
  }

  env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      ...process.env,
      NEXO_STATE_DIR: this.dir,
      NEXO_PORT: '0',
      NEXO_LOG_LEVEL: 'error',
      ...extra,
    }
  }

  /** Daemon real como proceso hijo (no desacoplado), listo cuando responde. */
  async startDaemon(): Promise<ChildProcess> {
    const child = spawn(process.execPath, [DAEMON_MAIN], {
      env: this.env(),
      stdio: 'ignore',
      windowsHide: true,
    })
    this.children.push(child)
    await this.waitDaemon()
    return child
  }

  async waitDaemon(timeoutMs = 20_000): Promise<{ pid: number; port: number }> {
    const end = Date.now() + timeoutMs
    for (;;) {
      try {
        const found = await discoverDaemon({ stateDir: this.dir })
        return { pid: found.pid, port: found.port }
      } catch {
        if (Date.now() > end) throw new Error('el daemon no arrancó')
        await new Promise((r) => setTimeout(r, 50))
      }
    }
  }

  /** Ejecuta la CLI como proceso hijo. */
  nexo(
    args: string[],
    options: { env?: Record<string, string>; input?: string | Buffer; timeoutMs?: number } = {},
  ): Promise<RunResult> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [CLI_MAIN, ...args], {
        env: this.env(options.env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      this.children.push(child)
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString('utf8')
      })
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf8')
      })
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`la CLI no terminó: nexo ${args.join(' ')}\n${stdout}\n${stderr}`))
      }, options.timeoutMs ?? 30_000)
      child.on('error', reject)
      child.on('close', (code) => {
        clearTimeout(timer)
        resolvePromise({ code, stdout, stderr })
      })
      child.stdin.on('error', () => {})
      child.stdin.end(options.input)
    })
  }

  /** Lanza la CLI sin esperar a que termine (p. ej. `read --follow`). */
  spawnNexo(args: string[], env: Record<string, string> = {}): ChildProcess {
    const child = spawn(process.execPath, [CLI_MAIN, ...args], {
      env: this.env(env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.children.push(child)
    return child
  }

  async json<T = Record<string, unknown>>(args: string[]): Promise<T> {
    const [command = '', ...rest] = args
    const r = await this.nexo([command, '--json', ...rest])
    if (r.code !== 0) throw new Error(`nexo ${args.join(' ')} salió ${r.code}: ${r.stderr}`)
    return JSON.parse(r.stdout) as T
  }

  /** Mata cualquier daemon (aunque lo haya arrancado la CLI) y todos los hijos; borra el directorio. */
  async cleanup(): Promise<void> {
    try {
      const raw = await readFile(join(this.dir, 'daemon.json'), 'utf8')
      const pid = (JSON.parse(raw) as { pid?: number }).pid
      if (pid !== undefined) process.kill(pid)
    } catch {
      // ya no hay daemon
    }
    for (const child of this.children) {
      if (child.exitCode === null) child.kill()
    }
    await new Promise((r) => setTimeout(r, 200))
    await rm(this.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

export async function waitUntil<T>(
  check: () => Promise<T | undefined | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value !== undefined && value !== false) return value
    if (Date.now() > end) throw new Error('tiempo agotado esperando una condición')
    await new Promise((r) => setTimeout(r, 100))
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Script de `node -e` para las terminales de prueba: imprime LISTO y repite lo que recibe. */
export const ECHO_SCRIPT =
  "process.stdin.setEncoding('utf8');process.stdin.on('data',d=>process.stdout.write('eco:'+JSON.stringify(d)+'\\n'));console.log('LISTO');setInterval(()=>{},1000)"

/** ¿Sin sustitutos sueltos? (`toWellFormed` aún no está en la `lib` del proyecto) */
export const isWellFormed = (s: string): boolean => Buffer.from(s, 'utf8').toString('utf8') === s
