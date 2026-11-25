import {
  LIMITS,
  type MethodParams,
  type MethodResult,
  type PaneId,
  type TerminalId,
  utf8ByteLength,
} from '@nexo/contracts'
import { DomainError } from './errors.ts'
import type { PaneDirectory } from './layout-service.ts'
import { OutputBatcher } from './output-batcher.ts'
import type { ClockPort, EventBusPort, IdPort } from './ports/misc.ts'
import {
  type PtyExit,
  type PtyPort,
  type PtyProcess,
  PtySpawnError,
  type PtySpawnOptions,
  type Unsubscribe,
} from './ports/pty.ts'
import { DEFAULT_RING_CAPACITY, RingBuffer } from './ring-buffer.ts'
import { OscTitleParser, SurrogateJoiner } from './stream-text.ts'

type Signal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGHUP'

export type TerminalServiceConfig = {
  /** Terminales vivas (o iniciándose) a la vez. */
  maxTerminals?: number
  ringCapacityBytes?: number
  batchMs?: number
  batchBytes?: number
  /** Ventana deslizante de escrituras por terminal. */
  writeRate?: { maxWrites: number; windowMs: number }
  /** Comando cuando `terminal.spawn` no trae `cmd` (el daemon sabe cuál es el shell del sistema). */
  defaultCommand?: { cmd: string; args?: readonly string[] }
}

export type TerminalServiceDeps = {
  pty: PtyPort
  bus: EventBusPort
  clock: ClockPort
  ids: IdPort
  panes: PaneDirectory
  config?: TerminalServiceConfig
}

export type TerminalInfo = {
  terminalId: TerminalId
  paneId: PaneId
  state: 'starting' | 'running' | 'exited'
  pid?: number
  cols: number
  rows: number
  /** Bytes de salida acumulados. */
  offset: number
  exit?: PtyExit
}

export const DEFAULT_MAX_TERMINALS = 64
export const DEFAULT_WRITE_RATE = { maxWrites: 1000, windowMs: 1000 }

type Entry = {
  id: TerminalId
  paneId: PaneId
  state: 'starting' | 'running' | 'exited'
  proc?: PtyProcess
  exit?: PtyExit
  cols: number
  rows: number
  ring: RingBuffer
  batcher: OutputBatcher
  joiner: SurrogateJoiner
  osc: OscTitleParser
  /** Offset del final del último `terminal.output` emitido. */
  emitted: number
  title: string
  writes: number[]
  killRequested?: Signal
  /** El panel se cerró o la terminal se reemplazó: ya no hay que emitir salida. */
  detached: boolean
  offData?: Unsubscribe
}

function invalidSize(cols: number, rows: number): boolean {
  return [cols, rows].some(
    (n) => !Number.isInteger(n) || n < LIMITS.minTerminalSize || n > LIMITS.maxTerminalSize,
  )
}

function mapSpawnError(error: unknown): DomainError {
  if (error instanceof DomainError) return error
  if (error instanceof PtySpawnError) {
    switch (error.code) {
      case 'EXECUTABLE_NOT_FOUND':
      case 'CWD_NOT_FOUND':
        return new DomainError('NOT_FOUND', error.message)
      case 'INVALID_OPTIONS':
        return new DomainError('INVALID_PARAMS', error.message)
      default:
        return new DomainError('INTERNAL', error.message)
    }
  }
  return new DomainError('INTERNAL', 'no se pudo crear la terminal')
}

/**
 * Terminales del daemon: una por panel como máximo, con búfer circular, salida agrupada, título por
 * OSC y límites de cantidad y de frecuencia de escritura. Cuando el panel se cierra
 * (`closePane`) la terminal se mata y se olvida; si solo termina el proceso, la terminal queda
 * legible hasta que se cierre el panel o se vuelva a lanzar una en él.
 */
export class TerminalService {
  readonly #deps: TerminalServiceDeps
  readonly #config: Required<Omit<TerminalServiceConfig, 'defaultCommand'>> &
    Pick<TerminalServiceConfig, 'defaultCommand'>
  readonly #terminals = new Map<TerminalId, Entry>()
  readonly #byPane = new Map<PaneId, Entry>()

  constructor(deps: TerminalServiceDeps) {
    this.#deps = deps
    const c = deps.config ?? {}
    this.#config = {
      maxTerminals: c.maxTerminals ?? DEFAULT_MAX_TERMINALS,
      ringCapacityBytes: c.ringCapacityBytes ?? DEFAULT_RING_CAPACITY,
      batchMs: c.batchMs ?? 8,
      batchBytes: Math.min(c.batchBytes ?? 64 * 1024, LIMITS.maxMessageBytes),
      writeRate: c.writeRate ?? DEFAULT_WRITE_RATE,
      ...(c.defaultCommand === undefined ? {} : { defaultCommand: c.defaultCommand }),
    }
  }

  async spawn(params: MethodParams<'terminal.spawn'>): Promise<MethodResult<'terminal.spawn'>> {
    const { paneId, cols, rows } = params
    const context = this.#deps.panes.paneContext(paneId)
    if (context === undefined) throw new DomainError('NOT_FOUND', `panel inexistente: ${paneId}`)
    if (context.pane.kind !== 'terminal') {
      throw new DomainError('CONFLICT', 'solo los paneles de terminal admiten terminales')
    }
    if (invalidSize(cols, rows)) throw new DomainError('INVALID_PARAMS', 'tamaño fuera de rango')
    const cmd = params.cmd ?? this.#config.defaultCommand?.cmd
    if (cmd === undefined) throw new DomainError('INVALID_PARAMS', 'falta el comando')
    const args = params.args ?? (params.cmd === undefined ? this.#config.defaultCommand?.args : [])
    const previous = this.#byPane.get(paneId)
    if (previous !== undefined && previous.state !== 'exited') {
      throw new DomainError('CONFLICT', 'el panel ya tiene una terminal')
    }
    if (this.#alive() >= this.#config.maxTerminals) {
      throw new DomainError('CONFLICT', 'se alcanzó el máximo de terminales', {
        limit: this.#config.maxTerminals,
      })
    }
    const id = this.#deps.ids.terminal()
    if (this.#terminals.has(id)) throw new DomainError('CONFLICT', `id de terminal repetido: ${id}`)
    if (previous !== undefined) this.#forget(previous)

    const entry = this.#createEntry(id, paneId, cols, rows, context.pane.title)
    this.#terminals.set(id, entry)
    this.#byPane.set(paneId, entry)
    this.#deps.panes.attachTerminal(paneId, id)

    const cwd = params.cwd ?? context.cwd
    const options: PtySpawnOptions = {
      cmd,
      args: args ?? [],
      cols,
      rows,
      ...(cwd === undefined ? {} : { cwd }),
      ...(params.env === undefined ? {} : { env: params.env }),
    }
    let proc: PtyProcess
    try {
      proc = await this.#deps.pty.spawn(options)
    } catch (error) {
      if (!entry.detached) {
        this.#forget(entry)
        this.#deps.panes.detachTerminal(paneId, id)
      }
      throw mapSpawnError(error)
    }
    if (entry.detached) {
      proc.kill('SIGKILL')
      throw new DomainError('CONFLICT', 'el panel se cerró mientras se creaba la terminal')
    }
    entry.proc = proc
    entry.state = 'running'
    entry.offData = proc.onData((data) => this.#onData(entry, data))
    proc.onExit((exit) => this.#onExit(entry, exit))
    if (entry.killRequested !== undefined) proc.kill(entry.killRequested)
    else if (entry.cols !== cols || entry.rows !== rows) proc.resize(entry.cols, entry.rows)
    return { terminalId: id }
  }

  write(params: MethodParams<'terminal.write'>): MethodResult<'terminal.write'> {
    const entry = this.#get(params.terminalId)
    if (utf8ByteLength(params.data) > LIMITS.maxWriteBytes) {
      throw new DomainError(
        'PAYLOAD_TOO_LARGE',
        `máximo ${LIMITS.maxWriteBytes} bytes por escritura`,
      )
    }
    const proc = this.#liveProc(entry)
    this.#consumeWriteQuota(entry)
    proc.write(params.data)
    return {}
  }

  resize(params: MethodParams<'terminal.resize'>): MethodResult<'terminal.resize'> {
    const entry = this.#get(params.terminalId)
    if (invalidSize(params.cols, params.rows)) {
      throw new DomainError('INVALID_PARAMS', 'tamaño fuera de rango')
    }
    if (entry.state === 'exited') throw new DomainError('CONFLICT', 'la terminal ya terminó')
    entry.cols = params.cols
    entry.rows = params.rows
    entry.proc?.resize(params.cols, params.rows)
    return {}
  }

  read(params: MethodParams<'terminal.read'>): MethodResult<'terminal.read'> {
    const entry = this.#get(params.terminalId)
    const result = entry.ring.read({
      maxBytes: params.maxBytes ?? LIMITS.maxReadBytes,
      ...(params.fromOffset === undefined ? {} : { fromOffset: params.fromOffset }),
    })
    return {
      data: result.data,
      offset: result.offset,
      ...(result.truncated ? { truncated: true } : {}),
    }
  }

  kill(params: MethodParams<'terminal.kill'>): MethodResult<'terminal.kill'> {
    const entry = this.#get(params.terminalId)
    const signal = params.signal ?? 'SIGTERM'
    if (entry.state === 'starting') entry.killRequested = signal
    else if (entry.state === 'running') entry.proc?.kill(signal)
    return {}
  }

  list(): TerminalInfo[] {
    return [...this.#terminals.values()].map((e) => ({
      terminalId: e.id,
      paneId: e.paneId,
      state: e.state,
      ...(e.proc === undefined ? {} : { pid: e.proc.pid }),
      cols: e.cols,
      rows: e.rows,
      offset: e.ring.offset,
      ...(e.exit === undefined ? {} : { exit: e.exit }),
    }))
  }

  /** Terminal del panel, si tiene. */
  terminalOf(paneId: PaneId): TerminalId | undefined {
    return this.#byPane.get(paneId)?.id
  }

  /** El panel se cerró: mata su terminal y la olvida. No toca el panel. */
  closePane(paneId: PaneId): void {
    const entry = this.#byPane.get(paneId)
    if (entry === undefined) return
    this.#forget(entry)
    entry.detached = true
    entry.batcher.dispose()
    entry.offData?.()
    if (entry.state === 'running') entry.proc?.kill('SIGKILL')
  }

  /** Mata todas las terminales (apagado del daemon). */
  shutdown(): void {
    for (const paneId of [...this.#byPane.keys()]) this.closePane(paneId)
  }

  #alive(): number {
    let n = 0
    for (const e of this.#terminals.values()) if (e.state !== 'exited') n++
    return n
  }

  #get(id: TerminalId): Entry {
    const entry = this.#terminals.get(id)
    if (entry === undefined) throw new DomainError('NOT_FOUND', `terminal inexistente: ${id}`)
    return entry
  }

  #liveProc(entry: Entry): PtyProcess {
    if (entry.state === 'exited') throw new DomainError('CONFLICT', 'la terminal ya terminó')
    if (entry.proc === undefined) throw new DomainError('CONFLICT', 'la terminal aún se inicia')
    return entry.proc
  }

  #consumeWriteQuota(entry: Entry): void {
    const { maxWrites, windowMs } = this.#config.writeRate
    const now = this.#deps.clock.now()
    const writes = entry.writes
    let drop = 0
    while (drop < writes.length && (writes[drop] as number) <= now - windowMs) drop++
    if (drop > 0) writes.splice(0, drop)
    if (writes.length >= maxWrites) {
      const retryAfterMs = Math.max(1, (writes[0] as number) + windowMs - now)
      throw new DomainError('RATE_LIMITED', 'demasiadas escrituras', { retryAfterMs })
    }
    writes.push(now)
  }

  #createEntry(id: TerminalId, paneId: PaneId, cols: number, rows: number, title: string): Entry {
    const entry: Entry = {
      id,
      paneId,
      state: 'starting',
      cols,
      rows,
      ring: new RingBuffer(this.#config.ringCapacityBytes),
      joiner: new SurrogateJoiner(),
      osc: new OscTitleParser(),
      emitted: 0,
      title,
      writes: [],
      detached: false,
      batcher: undefined as unknown as OutputBatcher,
    }
    entry.batcher = new OutputBatcher({
      clock: this.#deps.clock,
      flushMs: this.#config.batchMs,
      maxBytes: this.#config.batchBytes,
      emit: (data) => {
        entry.emitted += utf8ByteLength(data)
        this.#deps.bus.publish({
          event: 'terminal.output',
          data: { terminalId: id, offset: entry.emitted, data },
        })
      },
    })
    return entry
  }

  #forget(entry: Entry): void {
    if (this.#terminals.get(entry.id) === entry) this.#terminals.delete(entry.id)
    if (this.#byPane.get(entry.paneId) === entry) this.#byPane.delete(entry.paneId)
  }

  #onData(entry: Entry, data: string): void {
    if (entry.detached || entry.state === 'exited') return
    this.#ingest(entry, entry.joiner.push(data))
  }

  #ingest(entry: Entry, text: string): void {
    if (text.length === 0) return
    entry.ring.write(text)
    entry.batcher.push(text)
    const titles = entry.osc.feed(text)
    const title = titles[titles.length - 1]
    if (title !== undefined && title !== entry.title) {
      entry.title = title
      this.#deps.panes.setPaneTitle(entry.paneId, title)
      this.#deps.bus.publish({ event: 'pane.title', data: { paneId: entry.paneId, title } })
    }
  }

  #onExit(entry: Entry, exit: PtyExit): void {
    if (entry.state === 'exited') return
    if (!entry.detached) {
      this.#ingest(entry, entry.joiner.flush())
      entry.batcher.flush()
    }
    entry.state = 'exited'
    entry.exit = exit
    entry.batcher.dispose()
    entry.offData?.()
    this.#deps.bus.publish({
      event: 'terminal.exit',
      data: { terminalId: entry.id, exitCode: exit.exitCode, signal: exit.signal },
    })
  }
}
