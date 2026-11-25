import { utf8ByteLength } from '@nexo/contracts'
import { indexAfterBytes, indexOfSuffixWithin, skipBytes } from './utf8.ts'

export const DEFAULT_RING_CAPACITY = 2 * 1024 * 1024

export type RingReadOptions = {
  /** Offset absoluto desde el que leer. Sin él, lo más reciente (hasta `maxBytes`). */
  fromOffset?: number
  maxBytes?: number
}

export type RingReadResult = {
  data: string
  /** Offset absoluto del final de `data`. */
  offset: number
  /** `fromOffset` ya se descartó: `data` empieza en lo más antiguo disponible. */
  truncated: boolean
}

/**
 * Búfer circular de salida con capacidad en bytes UTF-8 y offset absoluto (bytes escritos desde el
 * inicio). Al recortar, descarta bytes del principio sin partir un carácter, así que `size` puede
 * quedar hasta 3 bytes por debajo de la capacidad.
 */
export class RingBuffer {
  readonly capacity: number
  #chunks: string[] = []
  #size = 0
  #total = 0

  constructor(capacity = DEFAULT_RING_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 4) {
      throw new RangeError('la capacidad debe ser un entero >= 4 bytes')
    }
    this.capacity = capacity
  }

  /** Bytes escritos desde el inicio (nunca decrece). */
  get offset(): number {
    return this.#total
  }

  /** Bytes retenidos ahora (<= capacidad). */
  get size(): number {
    return this.#size
  }

  /** Offset absoluto del primer byte retenido. */
  get startOffset(): number {
    return this.#total - this.#size
  }

  write(data: string): void {
    if (data.length === 0) return
    const bytes = utf8ByteLength(data)
    this.#total += bytes
    if (bytes >= this.capacity) {
      const chunk = data.slice(indexOfSuffixWithin(data, this.capacity))
      this.#chunks = [chunk]
      this.#size = utf8ByteLength(chunk)
      return
    }
    this.#chunks.push(data)
    this.#size += bytes
    this.#trim()
  }

  #trim(): void {
    while (this.#size > this.capacity) {
      const excess = this.#size - this.capacity
      const first = this.#chunks[0] as string
      const firstBytes = utf8ByteLength(first)
      if (firstBytes <= excess) {
        this.#chunks.shift()
        this.#size -= firstBytes
      } else {
        const { index, skipped } = skipBytes(first, excess)
        this.#chunks[0] = first.slice(index)
        this.#size -= skipped
      }
    }
  }

  read(options: RingReadOptions = {}): RingReadResult {
    const { fromOffset, maxBytes } = options
    const text = this.#chunks.length === 1 ? (this.#chunks[0] as string) : this.#chunks.join('')
    this.#chunks = text.length === 0 ? [] : [text]
    const start = this.startOffset
    if (fromOffset === undefined) {
      const from = maxBytes === undefined ? 0 : indexOfSuffixWithin(text, maxBytes)
      return { data: text.slice(from), offset: this.#total, truncated: false }
    }
    if (fromOffset >= this.#total) return { data: '', offset: this.#total, truncated: false }
    const truncated = fromOffset < start
    const { index, skipped } = skipBytes(text, Math.max(0, fromOffset - start))
    const end = maxBytes === undefined ? text.length : indexAfterBytes(text, index, maxBytes)
    const data = text.slice(index, end)
    return { data, offset: start + skipped + utf8ByteLength(data), truncated }
  }
}
