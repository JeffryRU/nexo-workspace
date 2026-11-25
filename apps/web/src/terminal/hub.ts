import { utf8ByteLength } from '@nexo/contracts'

/** Destino de la salida de una terminal (en la práctica, una instancia de xterm). */
export interface TerminalSink {
  /** Escribe y avisa con `done` cuando xterm terminó de procesarlo (control de flujo). */
  write(data: string, done: () => void): void
  /** Vacía la pantalla antes de reescribir (la salida anterior ya no existe en el daemon). */
  reset(): void
}

export type ReadResult = { data: string; offset: number; truncated?: boolean | undefined }

export type HubDeps = {
  read: (terminalId: string, fromOffset: number) => Promise<ReadResult>
  /** `requestAnimationFrame` (inyectable en pruebas). */
  frame: (cb: () => void) => void
  /** Tope de caracteres pendientes por terminal; al pasarlo se descarta lo más antiguo. */
  maxPendingChars?: number
  /**
   * Caracteres que se entregan a xterm por fotograma en una terminal visible / oculta. Con `hiddenBudget` 0 una
   * terminal oculta no recibe nada: lo pendiente (acotado por `maxPendingChars`) se entrega al mostrarla.
   */
  visibleBudget?: number
  hiddenBudget?: number
  /** Espera antes de reintentar cerrar un hueco cuando se agotaron los reintentos seguidos (500 ms). */
  gapRecoveryMs?: number
}

type Entry = {
  id: string
  /** Final (en bytes) de lo ya aceptado, escrito o pendiente. */
  offset: number
  pending: string[]
  pendingChars: number
  sink: TerminalSink | undefined
  writing: boolean
  visible: boolean
  catchingUp: boolean
  held: { end: number; data: string }[]
  needsReset: boolean
  /** Relecturas seguidas que no cerraron el hueco (evita bucles si el daemon no avanza). */
  gapRetries: number
  /** Relectura diferida pendiente tras agotar los reintentos. */
  recovery: ReturnType<typeof setTimeout> | undefined
}

const MAX_HELD = 256
const MAX_READ_ROUNDS = 64
const MAX_GAP_RETRIES = 3

/** Corta el inicio de `data` hasta `skipBytes` bytes UTF-8 (por puntos de código, sin partir pares). */
export function sliceFromByte(data: string, skipBytes: number): string {
  if (skipBytes <= 0) return data
  let bytes = 0
  let i = 0
  while (i < data.length && bytes < skipBytes) {
    const cp = data.codePointAt(i) as number
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
    i += cp > 0xffff ? 2 : 1
  }
  return data.slice(i)
}

/**
 * Reparte la salida de las terminales a sus xterm. Mantiene el offset de cada una (sin perder ni duplicar
 * al reconectar), agrupa las escrituras por fotograma y acota la memoria de lo pendiente.
 */
export class TerminalHub {
  readonly #deps: HubDeps
  readonly #entries = new Map<string, Entry>()
  readonly #dirty = new Set<Entry>()
  #scheduled = false
  readonly #maxPending: number
  readonly #visibleBudget: number
  readonly #hiddenBudget: number
  #disposed = false

  constructor(deps: HubDeps) {
    this.#deps = deps
    this.#maxPending = deps.maxPendingChars ?? 4 * 1024 * 1024
    this.#visibleBudget = deps.visibleBudget ?? 256 * 1024
    this.#hiddenBudget = deps.hiddenBudget ?? 64 * 1024
  }

  /** Terminales conocidas: las nuevas piden su historial; las que ya no existen se olvidan. */
  sync(ids: Iterable<string>): void {
    const live = new Set(ids)
    for (const id of [...this.#entries.keys()]) {
      if (!live.has(id)) {
        const e = this.#entries.get(id) as Entry
        clearTimeout(e.recovery)
        this.#dirty.delete(e)
        this.#entries.delete(id)
      }
    }
    for (const id of live) this.#track(id)
  }

  has(id: string): boolean {
    return this.#entries.has(id)
  }

  offsetOf(id: string): number | undefined {
    return this.#entries.get(id)?.offset
  }

  pendingCharsOf(id: string): number {
    return this.#entries.get(id)?.pendingChars ?? 0
  }

  attach(id: string, sink: TerminalSink): () => void {
    // El panel puede enterarse de su terminal antes que `sync`: se registra ya.
    const entry = this.#track(id)
    entry.sink = sink
    this.#markDirty(entry)
    return () => {
      if (entry.sink === sink) entry.sink = undefined
    }
  }

  setVisible(id: string, visible: boolean): void {
    const entry = this.#entries.get(id)
    if (entry === undefined) return
    entry.visible = visible
    if (entry.pendingChars > 0) this.#markDirty(entry)
  }

  /** Evento `terminal.output`; ignora terminales desconocidas. */
  onOutput(id: string, end: number, data: string): void {
    const entry = this.#entries.get(id)
    if (entry === undefined || this.#disposed) return
    if (entry.catchingUp) {
      if (entry.held.length < MAX_HELD) entry.held.push({ end, data })
      return
    }
    this.#accept(entry, end, data)
  }

  /** Tras reconectar o perder eventos: relee de cada terminal lo que falta desde su último offset. */
  async resync(): Promise<void> {
    await Promise.all([...this.#entries.values()].map((e) => this.#catchUp(e)))
  }

  dispose(): void {
    this.#disposed = true
    for (const e of this.#entries.values()) clearTimeout(e.recovery)
    this.#entries.clear()
    this.#dirty.clear()
  }

  #track(id: string): Entry {
    const known = this.#entries.get(id)
    if (known !== undefined) return known
    const entry = this.#newEntry(id)
    this.#entries.set(id, entry)
    void this.#catchUp(entry)
    return entry
  }

  #newEntry(id: string): Entry {
    return {
      id,
      offset: 0,
      pending: [],
      pendingChars: 0,
      sink: undefined,
      writing: false,
      visible: false,
      catchingUp: false,
      held: [],
      needsReset: false,
      gapRetries: 0,
      recovery: undefined,
    }
  }

  #accept(entry: Entry, end: number, data: string): void {
    const bytes = utf8ByteLength(data)
    const start = end - bytes
    if (end <= entry.offset) return
    if (start > entry.offset) {
      if (entry.gapRetries >= MAX_GAP_RETRIES) {
        // No se descarta para siempre: tras una ráfaga (el daemon descarta lo viejo más rápido de lo que se
        // relee) el hueco solo se cierra cuando la salida se calma, así que se reintenta más tarde.
        this.#scheduleRecovery(entry)
        return
      }
      entry.gapRetries++
      entry.held.push({ end, data })
      void this.#catchUp(entry)
      return
    }
    entry.gapRetries = 0
    this.#push(entry, start < entry.offset ? sliceFromByte(data, entry.offset - start) : data)
    entry.offset = end
  }

  #scheduleRecovery(entry: Entry): void {
    if (entry.recovery !== undefined) return
    entry.recovery = setTimeout(() => {
      entry.recovery = undefined
      if (this.#disposed || this.#entries.get(entry.id) !== entry) return
      entry.gapRetries = 0
      void this.#catchUp(entry)
    }, this.#deps.gapRecoveryMs ?? 500)
  }

  #push(entry: Entry, data: string): void {
    if (data.length === 0) return
    entry.pending.push(data)
    entry.pendingChars += data.length
    while (entry.pendingChars > this.#maxPending && entry.pending.length > 1) {
      const dropped = entry.pending.shift() as string
      entry.pendingChars -= dropped.length
    }
    if (entry.pendingChars > this.#maxPending) {
      // Un único fragmento enorme: se conserva su final.
      const only = entry.pending[0] as string
      entry.pending[0] = only.slice(only.length - this.#maxPending)
      entry.pendingChars = this.#maxPending
    }
    this.#markDirty(entry)
  }

  async #catchUp(entry: Entry): Promise<void> {
    if (entry.catchingUp) return
    entry.catchingUp = true
    try {
      for (let round = 0; round < MAX_READ_ROUNDS; round++) {
        let result: ReadResult
        try {
          result = await this.#deps.read(entry.id, entry.offset)
        } catch {
          return // sin conexión: el próximo resync lo reintenta
        }
        if (this.#entries.get(entry.id) !== entry) return
        if (result.truncated === true) {
          entry.pending = []
          entry.pendingChars = 0
          entry.needsReset = true
        }
        if (result.data.length === 0 || result.offset <= entry.offset) {
          if (result.truncated === true) entry.offset = Math.max(entry.offset, result.offset)
          break
        }
        this.#push(entry, result.data)
        entry.offset = result.offset
      }
    } finally {
      entry.catchingUp = false
      const held = entry.held
      entry.held = []
      if (this.#entries.get(entry.id) === entry)
        for (const h of held) this.#accept(entry, h.end, h.data)
    }
  }

  #markDirty(entry: Entry): void {
    this.#dirty.add(entry)
    if (this.#scheduled) return
    this.#scheduled = true
    this.#deps.frame(() => this.#flush())
  }

  #flush(): void {
    this.#scheduled = false
    for (const entry of [...this.#dirty]) {
      this.#dirty.delete(entry)
      this.#writeSome(entry)
    }
  }

  #writeSome(entry: Entry): void {
    const sink = entry.sink
    if (sink === undefined || entry.writing) {
      return
    }
    if (entry.needsReset) {
      entry.needsReset = false
      sink.reset()
    }
    if (entry.pendingChars === 0) return
    const budget = entry.visible ? this.#visibleBudget : this.#hiddenBudget
    if (budget <= 0) return
    let chunk = ''
    while (entry.pending.length > 0 && chunk.length < budget) {
      const next = entry.pending[0] as string
      const room = budget - chunk.length
      if (next.length <= room) {
        chunk += next
        entry.pending.shift()
      } else {
        let cut = room
        const code = next.charCodeAt(cut - 1)
        if (code >= 0xd800 && code <= 0xdbff) cut--
        if (cut === 0) {
          if (chunk !== '') break
          cut = Math.min(next.length, room + 1)
        }
        chunk += next.slice(0, cut)
        entry.pending[0] = next.slice(cut)
      }
    }
    entry.pendingChars -= chunk.length
    entry.writing = true
    sink.write(chunk, () => {
      entry.writing = false
      if (entry.pendingChars > 0) this.#markDirty(entry)
    })
  }
}
