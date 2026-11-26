/**
 * Divisor de NDJSON sobre bytes. Los trozos llegan partidos en cualquier punto (también en mitad de un
 * carácter UTF-8): solo se decodifica una línea cuando está completa, así que el resultado no depende de
 * cómo se parta el flujo. Una línea más larga que `maxLineBytes` es un desbordamiento: se deja de acumular
 * (memoria acotada) y quien lo use debe abortar la respuesta.
 */
export class NdjsonSplitter {
  readonly #maxLineBytes: number
  readonly #decoder = new TextDecoder('utf-8')
  #parts: Uint8Array[] = []
  #size = 0
  #overflow = false

  constructor(maxLineBytes: number) {
    this.#maxLineBytes = maxLineBytes
  }

  get overflowed(): boolean {
    return this.#overflow
  }

  /** Añade bytes y devuelve las líneas completas (sin salto, sin vacías). */
  push(chunk: Uint8Array): string[] {
    if (this.#overflow) return []
    const out: string[] = []
    let start = 0
    while (start < chunk.length) {
      const nl = chunk.indexOf(0x0a, start)
      const end = nl === -1 ? chunk.length : nl
      this.#size += end - start
      if (this.#size > this.#maxLineBytes) {
        this.#overflow = true
        this.#parts = []
        return out
      }
      if (end > start) this.#parts.push(chunk.slice(start, end))
      if (nl === -1) break
      this.#emit(out)
      start = nl + 1
    }
    return out
  }

  /** Lo que quedó sin salto de línea al terminar el flujo (puede ser una línea válida). */
  flush(): string[] {
    if (this.#overflow) return []
    const out: string[] = []
    this.#emit(out)
    return out
  }

  #emit(out: string[]): void {
    const size = this.#size
    const parts = this.#parts
    this.#parts = []
    this.#size = 0
    if (size === 0) return
    let bytes: Uint8Array
    if (parts.length === 1 && parts[0] !== undefined) bytes = parts[0]
    else {
      bytes = new Uint8Array(size)
      let at = 0
      for (const p of parts) {
        bytes.set(p, at)
        at += p.length
      }
    }
    const text = this.#decoder.decode(bytes).replace(/\r$/, '')
    if (text.trim() !== '') out.push(text)
  }
}
