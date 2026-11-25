import {
  type EventData,
  type EventName,
  PaneId,
  TabId,
  TerminalId,
  WorkspaceId,
} from '@nexo/contracts'
import {
  type AgentProviderPort,
  type BusEvent,
  type ClockPort,
  type EventBusPort,
  type FileStat,
  type FileSystemPort,
  type IdPort,
  type LogFields,
  type LoggerPort,
  type Notification,
  type NotifierPort,
  type PersistedState,
  type ProcessLauncherPort,
  type PtyExit,
  type PtyPort,
  type PtyProcess,
  PtySpawnError,
  type PtySpawnOptions,
  type RunOptions,
  type RunResult,
  type SessionStorePort,
  type Unsubscribe,
} from '@nexo/core'
import { schedule } from './timers.ts'

/** Reloj controlable: el tiempo solo avanza con `advance`. */
export class FakeClock implements ClockPort {
  #now: number
  #seq = 0
  readonly #timers = new Map<number, { at: number; callback: () => void }>()

  constructor(start = 0) {
    this.#now = start
  }

  now(): number {
    return this.#now
  }

  setTimeout(callback: () => void, ms: number): Unsubscribe {
    const id = this.#seq++
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), callback })
    return () => {
      this.#timers.delete(id)
    }
  }

  /** Avanza el tiempo y ejecuta los temporizadores vencidos en orden. */
  advance(ms: number): void {
    const target = this.#now + ms
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (due === undefined) break
      this.#timers.delete(due[0])
      this.#now = due[1].at
      due[1].callback()
    }
    this.#now = target
  }

  get pending(): number {
    return this.#timers.size
  }
}

/** Ids deterministas: `ws-1`, `tab-1`, `pane-1`, `term-1`... */
export class SequentialIds implements IdPort {
  #ws = 0
  #tab = 0
  #pane = 0
  #term = 0
  workspace(): WorkspaceId {
    return WorkspaceId.parse(`ws-${++this.#ws}`)
  }
  tab(): TabId {
    return TabId.parse(`tab-${++this.#tab}`)
  }
  pane(): PaneId {
    return PaneId.parse(`pane-${++this.#pane}`)
  }
  terminal(): TerminalId {
    return TerminalId.parse(`term-${++this.#term}`)
  }
}

/** Bus que registra todo lo publicado. */
export class RecordingEventBus implements EventBusPort {
  readonly events: BusEvent[] = []
  readonly #listeners = new Set<(event: BusEvent) => void>()

  publish(event: BusEvent): void {
    this.events.push(event)
    for (const listener of [...this.#listeners]) listener(event)
  }

  subscribe(listener: (event: BusEvent) => void): Unsubscribe {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  ofType<E extends EventName>(name: E): EventData<E>[] {
    return this.events.filter((e) => e.event === name).map((e) => e.data as EventData<E>)
  }
}

/** Proceso PTY falso: se programa con `emitData`, `exit` y `kill`. */
export class FakePtyProcess implements PtyProcess {
  readonly written: string[] = []
  size: { cols: number; rows: number }
  exited: PtyExit | undefined
  killedWith: string | undefined
  readonly #dataListeners = new Set<(data: string) => void>()
  readonly #exitListeners = new Set<(exit: PtyExit) => void>()

  constructor(
    readonly pid: number,
    readonly options: PtySpawnOptions,
  ) {
    this.size = { cols: options.cols, rows: options.rows }
  }

  write(data: string): void {
    if (this.exited === undefined) this.written.push(data)
  }

  resize(cols: number, rows: number): void {
    assertSize(cols, rows)
    if (this.exited === undefined) this.size = { cols, rows }
  }

  kill(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGHUP' = 'SIGTERM'): void {
    if (this.exited !== undefined) return
    this.killedWith = signal
    this.exit({ exitCode: null, signal })
  }

  onData(listener: (data: string) => void): Unsubscribe {
    this.#dataListeners.add(listener)
    return () => {
      this.#dataListeners.delete(listener)
    }
  }

  onExit(listener: (exit: PtyExit) => void): Unsubscribe {
    const exited = this.exited
    if (exited !== undefined) {
      void Promise.resolve().then(() => listener(exited))
      return () => {}
    }
    this.#exitListeners.add(listener)
    return () => {
      this.#exitListeners.delete(listener)
    }
  }

  /** Emite salida como si viniera del proceso. */
  emitData(data: string): void {
    if (this.exited !== undefined) return
    for (const listener of [...this.#dataListeners]) listener(data)
  }

  /** Termina el proceso (una sola vez). */
  exit(exit: Partial<PtyExit> = {}): void {
    if (this.exited !== undefined) return
    const final: PtyExit = { exitCode: 0, signal: null, ...exit }
    this.exited = final
    const listeners = [...this.#exitListeners]
    this.#exitListeners.clear()
    this.#dataListeners.clear()
    for (const listener of listeners) listener(final)
  }
}

function assertSize(cols: number, rows: number): void {
  for (const n of [cols, rows]) {
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      throw new RangeError(`dimensión fuera de rango: ${n}`)
    }
  }
}

export type FakePtyScript = (process: FakePtyProcess) => void

export class FakePtyPort implements PtyPort {
  readonly processes: FakePtyProcess[] = []
  #pid = 1000
  #nextFailure: Error | undefined
  readonly #script: FakePtyScript | undefined
  readonly #missingCmds: ReadonlySet<string>
  readonly #missingCwds: ReadonlySet<string>

  /**
   * `script` corre justo después de que `spawn` resuelve (ya se pueden registrar oyentes).
   * `missingCmds` y `missingCwds` simulan ejecutables y directorios que no existen.
   */
  constructor(
    options: {
      script?: FakePtyScript
      missingCmds?: readonly string[]
      missingCwds?: readonly string[]
    } = {},
  ) {
    this.#script = options.script
    this.#missingCmds = new Set(options.missingCmds ?? [])
    this.#missingCwds = new Set(options.missingCwds ?? [])
  }

  /** El siguiente `spawn` rechaza con este error. */
  failNextSpawn(error: Error): void {
    this.#nextFailure = error
  }

  async spawn(options: PtySpawnOptions): Promise<PtyProcess> {
    try {
      assertSize(options.cols, options.rows)
    } catch (error) {
      throw new PtySpawnError('INVALID_OPTIONS', (error as Error).message, { cause: error })
    }
    if (this.#missingCmds.has(options.cmd)) {
      throw new PtySpawnError('EXECUTABLE_NOT_FOUND', `ejecutable no encontrado: ${options.cmd}`)
    }
    if (options.cwd !== undefined && this.#missingCwds.has(options.cwd)) {
      throw new PtySpawnError('CWD_NOT_FOUND', `directorio no encontrado: ${options.cwd}`)
    }
    if (this.#nextFailure !== undefined) {
      const error = this.#nextFailure
      this.#nextFailure = undefined
      throw error
    }
    const proc = new FakePtyProcess(++this.#pid, options)
    this.processes.push(proc)
    const script = this.#script
    if (script !== undefined) schedule(() => script(proc), 0)
    return proc
  }
}

export class FakeSessionStore implements SessionStorePort {
  state: PersistedState | null = null
  saves = 0
  async load(): Promise<PersistedState | null> {
    return this.state
  }
  async save(state: PersistedState): Promise<void> {
    this.saves++
    this.state = state
  }
}

export class FakeNotifier implements NotifierPort {
  readonly sent: Notification[] = []
  async notify(notification: Notification): Promise<void> {
    this.sent.push(notification)
  }
}

export class FakeFileSystem implements FileSystemPort {
  readonly files = new Map<string, string>()
  readonly dirs = new Set<string>(['/'])

  async readText(path: string): Promise<string> {
    const content = this.files.get(path)
    if (content === undefined) throw new Error(`ENOENT: ${path}`)
    return content
  }
  async writeText(path: string, content: string): Promise<void> {
    this.files.set(path, content)
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path)
  }
  async stat(path: string): Promise<FileStat> {
    const content = this.files.get(path)
    if (content !== undefined) {
      return { isFile: true, isDirectory: false, size: content.length, mtimeMs: 0 }
    }
    if (this.dirs.has(path)) return { isFile: false, isDirectory: true, size: 0, mtimeMs: 0 }
    throw new Error(`ENOENT: ${path}`)
  }
  async readDir(path: string): Promise<string[]> {
    if (!this.dirs.has(path)) throw new Error(`ENOENT: ${path}`)
    const prefix = path.endsWith('/') ? path : `${path}/`
    const names = new Set<string>()
    for (const p of [...this.files.keys(), ...this.dirs]) {
      if (p.startsWith(prefix) && p !== prefix)
        names.add(p.slice(prefix.length).split('/')[0] ?? '')
    }
    return [...names].sort()
  }
  async mkdir(path: string): Promise<void> {
    this.dirs.add(path)
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path)
    this.dirs.delete(path)
  }
}

export type LogEntry = {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  fields?: LogFields
}

export class FakeLogger implements LoggerPort {
  readonly entries: LogEntry[] = []
  #log(level: LogEntry['level'], message: string, fields?: LogFields): void {
    this.entries.push(fields === undefined ? { level, message } : { level, message, fields })
  }
  debug(message: string, fields?: LogFields): void {
    this.#log('debug', message, fields)
  }
  info(message: string, fields?: LogFields): void {
    this.#log('info', message, fields)
  }
  warn(message: string, fields?: LogFields): void {
    this.#log('warn', message, fields)
  }
  error(message: string, fields?: LogFields): void {
    this.#log('error', message, fields)
  }
}

/** Lanzador de procesos programable: `respond` decide el resultado de cada `run`. */
export class FakeProcessLauncher implements ProcessLauncherPort {
  readonly calls: RunOptions[] = []
  respond: (options: RunOptions) => RunResult | Promise<RunResult> = () => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
  })
  async run(options: RunOptions): Promise<RunResult> {
    this.calls.push(options)
    return this.respond(options)
  }
}

export class FakeAgentProvider implements AgentProviderPort {
  available = true
  constructor(readonly id = 'fake') {}
  async isAvailable(): Promise<boolean> {
    return this.available
  }
}
