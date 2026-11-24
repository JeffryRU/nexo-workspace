// El testkit no depende de tipos de Node; declara solo lo que usa del entorno.
declare function setTimeout(callback: () => void, ms?: number): unknown

export function schedule(callback: () => void, ms = 0): void {
  setTimeout(callback, ms)
}

export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => schedule(resolve, ms))
}
