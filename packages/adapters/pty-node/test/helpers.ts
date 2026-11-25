import type { PtyExit, PtyProcess } from '@nexo/core'

export const NODE = process.execPath
export const IS_WINDOWS = process.platform === 'win32'

export function nodeArgs(script: string): string[] {
  return ['-e', script]
}

export async function waitFor(condition: () => boolean, timeoutMs = 15000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('tiempo de espera agotado')
    await new Promise((r) => setTimeout(r, 10))
  }
}

export type Collected = { output: () => string; exit: Promise<PtyExit> }

export function collect(proc: PtyProcess): Collected {
  let out = ''
  proc.onData((d) => {
    out += d
  })
  const exit = new Promise<PtyExit>((resolve) => proc.onExit(resolve))
  return { output: () => out, exit }
}

/** Script de un proceso que imprime `marker` y se queda vivo. */
export const LIVE_SCRIPT = "console.log('listo'); setInterval(() => {}, 1000)"
