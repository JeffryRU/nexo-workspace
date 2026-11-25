import { utf8ByteLength } from '@nexo/contracts'
import type { ClockPort } from './ports/misc.ts'
import type { Unsubscribe } from './ports/pty.ts'
import { splitByBytes } from './utf8.ts'

export const DEFAULT_BATCH_MS = 8
export const DEFAULT_BATCH_BYTES = 64 * 1024

export type OutputBatcherOptions = {
  clock: ClockPort
  /** Se llama con cada trozo agrupado (<= `maxBytes` bytes UTF-8). */
  emit: (data: string) => void
  flushMs?: number
  maxBytes?: number
}

/**
 * Agrupa la salida y la emite cada `flushMs` o al llegar a `maxBytes`, lo que ocurra antes. Una
 * ráfaga mayor se parte en trozos de `maxBytes` (sin partir caracteres); el resto espera al
 * temporizador.
 */
export class OutputBatcher {
  readonly #clock: ClockPort
  readonly #emit: (data: string) => void
  readonly #flushMs: number
  readonly #maxBytes: number
  #pending: string[] = []
  #pendingBytes = 0
  #timer: Unsubscribe | undefined
  #disposed = false

  constructor(options: OutputBatcherOptions) {
    this.#clock = options.clock
    this.#emit = options.emit
    this.#flushMs = options.flushMs ?? DEFAULT_BATCH_MS
    this.#maxBytes = Math.max(4, options.maxBytes ?? DEFAULT_BATCH_BYTES)
  }

  get pendingBytes(): number {
    return this.#pendingBytes
  }

  push(data: string): void {
    if (this.#disposed || data.length === 0) return
    this.#pending.push(data)
    this.#pendingBytes += utf8ByteLength(data)
    if (this.#pendingBytes >= this.#maxBytes) {
      this.#cancelTimer()
      const pieces = splitByBytes(this.#pending.join(''), this.#maxBytes)
      const last = pieces[pieces.length - 1] as string
      const lastBytes = utf8ByteLength(last)
      const keepLast = lastBytes < this.#maxBytes
      this.#pending = keepLast ? [last] : []
      this.#pendingBytes = keepLast ? lastBytes : 0
      for (const piece of keepLast ? pieces.slice(0, -1) : pieces) this.#emit(piece)
    }
    if (this.#pendingBytes > 0 && this.#timer === undefined && !this.#disposed) {
      this.#timer = this.#clock.setTimeout(() => {
        this.#timer = undefined
        this.flush()
      }, this.#flushMs)
    }
  }

  /** Emite ya todo lo pendiente. */
  flush(): void {
    this.#cancelTimer()
    if (this.#pendingBytes === 0) return
    const pieces = splitByBytes(this.#pending.join(''), this.#maxBytes)
    this.#pending = []
    this.#pendingBytes = 0
    for (const piece of pieces) this.#emit(piece)
  }

  /** Descarta lo pendiente y no vuelve a emitir. */
  dispose(): void {
    this.#disposed = true
    this.#cancelTimer()
    this.#pending = []
    this.#pendingBytes = 0
  }

  #cancelTimer(): void {
    this.#timer?.()
    this.#timer = undefined
  }
}
