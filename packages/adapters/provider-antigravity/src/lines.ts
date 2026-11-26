/**
 * Parte un flujo de texto en líneas. Una línea que pasa de `maxLength` caracteres sin acabar se descarta
 * entera (hasta su salto de línea) y se avisa con `onOverflow`: un evento enorme no debe agotar la memoria.
 */
export class LineSplitter {
  readonly #max: number
  readonly #onLine: (line: string) => void
  readonly #onOverflow: () => void
  #buffer = ''
  #skipping = false

  constructor(options: {
    maxLength: number
    onLine: (line: string) => void
    onOverflow: () => void
  }) {
    this.#max = options.maxLength
    this.#onLine = options.onLine
    this.#onOverflow = options.onOverflow
  }

  push(chunk: string): void {
    let rest = chunk
    for (;;) {
      const nl = rest.indexOf('\n')
      if (nl === -1) {
        if (this.#skipping) return
        this.#buffer += rest
        if (this.#buffer.length > this.#max) {
          this.#buffer = ''
          this.#skipping = true
          this.#onOverflow()
        }
        return
      }
      const head = rest.slice(0, nl)
      rest = rest.slice(nl + 1)
      if (this.#skipping) {
        this.#skipping = false
        continue
      }
      const full = this.#buffer + head
      this.#buffer = ''
      if (full.length > this.#max) {
        this.#onOverflow()
        continue
      }
      const text = full.endsWith('\r') ? full.slice(0, -1) : full
      if (text.trim() !== '') this.#onLine(text)
    }
  }

  /** Fin del flujo: entrega lo que quedó sin salto de línea final. */
  flush(): void {
    const text = this.#buffer
    this.#buffer = ''
    if (!this.#skipping && text.trim() !== '') this.#onLine(text)
    this.#skipping = false
  }
}
