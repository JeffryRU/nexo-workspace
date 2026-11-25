/**
 * Modelo puro de una lista virtualizada con alturas variables. Cada elemento arranca con una altura estimada
 * y pasa a la medida real cuando se dibuja. Las sumas acumuladas se recalculan de forma perezosa desde el
 * primer elemento que cambió, así que lo habitual (cambios al final, mientras llega texto) es barato.
 */
export class VirtualModel {
  #ids: readonly string[] = []
  #heights: number[] = []
  readonly #measured = new Map<string, number>()
  /** `#prefix[i]` es la altura de los elementos anteriores a `i`; válido hasta `#valid` (exclusive). */
  #prefix: number[] = [0]
  #valid = 1
  readonly #estimate: (id: string) => number

  constructor(estimate: (id: string) => number) {
    this.#estimate = estimate
  }

  get count(): number {
    return this.#ids.length
  }

  get total(): number {
    this.#fill(this.#ids.length)
    return this.#prefix[this.#ids.length] as number
  }

  /** Reemplaza la lista de ids; conserva las medidas de los que siguen existiendo. */
  setIds(ids: readonly string[]): void {
    const prev = this.#ids
    let same = 0
    const max = Math.min(prev.length, ids.length)
    while (same < max && prev[same] === ids[same]) same++
    this.#ids = ids
    const heights = this.#heights.slice(0, same)
    for (let i = same; i < ids.length; i++) {
      const id = ids[i] as string
      heights.push(this.#measured.get(id) ?? this.#estimate(id))
    }
    this.#heights = heights
    this.#valid = Math.min(this.#valid, same + 1)
    if (this.#measured.size > ids.length * 2 + 64) {
      const live = new Set(ids)
      for (const id of this.#measured.keys()) if (!live.has(id)) this.#measured.delete(id)
    }
  }

  indexOf(id: string): number {
    return this.#ids.indexOf(id)
  }

  /** Registra la altura real de un elemento. Devuelve la diferencia con la anterior (0 si no cambió). */
  measure(id: string, height: number): number {
    if (!Number.isFinite(height) || height <= 0) return 0
    const h = Math.round(height * 100) / 100
    this.#measured.set(id, h)
    const i = this.#ids.indexOf(id)
    if (i < 0) return 0
    return this.#set(i, h)
  }

  #set(i: number, h: number): number {
    const old = this.#heights[i] as number
    if (Math.abs(old - h) < 0.5) return 0
    this.#heights[i] = h
    this.#valid = Math.min(this.#valid, i + 1)
    return h - old
  }

  heightOf(i: number): number {
    return this.#heights[i] ?? 0
  }

  offsetOf(i: number): number {
    const k = Math.max(0, Math.min(i, this.#ids.length))
    this.#fill(k)
    return this.#prefix[k] as number
  }

  #fill(upTo: number): void {
    while (this.#valid <= upTo) {
      const i = this.#valid - 1
      this.#prefix[this.#valid] = (this.#prefix[i] as number) + (this.#heights[i] as number)
      this.#valid++
    }
  }

  /** Índice del elemento que contiene `offset` (se acota a [0, count - 1]). */
  indexAt(offset: number): number {
    const n = this.#ids.length
    if (n === 0) return 0
    this.#fill(n)
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((this.#prefix[mid] as number) <= offset) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /** Elementos a dibujar para el tramo visible, con colchón (`overscan`, en px) arriba y abajo. */
  window(
    scrollTop: number,
    viewport: number,
    overscan: number,
  ): { start: number; end: number; padTop: number; padBottom: number; total: number } {
    const n = this.#ids.length
    const total = this.total
    if (n === 0) return { start: 0, end: 0, padTop: 0, padBottom: 0, total }
    const top = Math.max(0, scrollTop - overscan)
    const bottom = Math.max(0, scrollTop) + Math.max(0, viewport) + overscan
    const start = this.indexAt(top)
    let end = this.indexAt(bottom) + 1
    end = Math.min(n, Math.max(end, start + 1))
    return {
      start,
      end,
      padTop: this.offsetOf(start),
      padBottom: Math.max(0, total - this.offsetOf(end)),
      total,
    }
  }

  slice(start: number, end: number): string[] {
    return this.#ids.slice(start, end)
  }
}
