import type { PtyExit, PtyPort, PtyProcess } from '@nexo/core'
import { afterEach, describe, expect, it } from 'vitest'
import { sleep } from '../timers.ts'

export type PtyConformanceSubject = {
  port: PtyPort
  /**
   * Comando que imprime `marker` y se queda vivo hasta que lo matan. Los adaptadores reales usan
   * un comando real (p. ej. `node -e`); el falso lo simula con su script.
   */
  command: { cmd: string; args: string[]; marker: string }
  cleanup?: () => Promise<void> | void
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('tiempo de espera agotado')
    await sleep(5)
  }
}

/**
 * Suite de conformidad de `PtyPort`. Se ejecuta contra el falso (testkit) y contra cada adaptador
 * real: `runPtyConformance('pty-node', () => ({ port, command }))`.
 */
export function runPtyConformance(name: string, create: () => PtyConformanceSubject): void {
  describe(`PtyPort conformance: ${name}`, () => {
    const live: PtyProcess[] = []
    let subject: PtyConformanceSubject

    afterEach(async () => {
      for (const p of live.splice(0)) p.kill('SIGKILL')
      await subject.cleanup?.()
    })

    const start = async (): Promise<PtyProcess> => {
      subject = create()
      const proc = await subject.port.spawn({
        cmd: subject.command.cmd,
        args: subject.command.args,
        cols: 80,
        rows: 24,
      })
      live.push(proc)
      return proc
    }

    it('spawn devuelve un proceso con pid entero positivo', async () => {
      const proc = await start()
      expect(Number.isInteger(proc.pid)).toBe(true)
      expect(proc.pid).toBeGreaterThan(0)
    })

    it('entrega la salida a onData', async () => {
      subject = create()
      const proc = await subject.port.spawn({ ...subject.command, cols: 80, rows: 24 })
      live.push(proc)
      let output = ''
      proc.onData((d) => {
        output += d
      })
      await waitFor(() => output.includes(subject.command.marker))
    })

    it('onData deja de recibir tras cancelar la suscripción', async () => {
      subject = create()
      const proc = await subject.port.spawn({ ...subject.command, cols: 80, rows: 24 })
      live.push(proc)
      let calls = 0
      const unsubscribe = proc.onData(() => {
        calls++
      })
      unsubscribe()
      await sleep(100)
      expect(calls).toBe(0)
    })

    it('kill dispara onExit exactamente una vez, aunque se llame dos veces', async () => {
      const proc = await start()
      const exits: PtyExit[] = []
      proc.onExit((e) => exits.push(e))
      proc.kill()
      proc.kill('SIGKILL')
      await waitFor(() => exits.length > 0)
      await sleep(50)
      expect(exits).toHaveLength(1)
    })

    it('onExit registrado tras la salida se invoca igualmente, una vez', async () => {
      const proc = await start()
      const first: PtyExit[] = []
      proc.onExit((e) => first.push(e))
      proc.kill()
      await waitFor(() => first.length > 0)
      const late: PtyExit[] = []
      proc.onExit((e) => late.push(e))
      await waitFor(() => late.length > 0)
      await sleep(30)
      expect(late).toHaveLength(1)
    })

    it('write y resize válidos tras la salida no lanzan', async () => {
      const proc = await start()
      const exits: PtyExit[] = []
      proc.onExit((e) => exits.push(e))
      proc.kill()
      await waitFor(() => exits.length > 0)
      expect(() => proc.write('hola')).not.toThrow()
      expect(() => proc.resize(100, 30)).not.toThrow()
    })

    it('resize con dimensiones inválidas lanza RangeError', async () => {
      const proc = await start()
      for (const [c, r] of [
        [0, 24],
        [80, 0],
        [1001, 24],
        [80, 1001],
        [1.5, 24],
        [Number.NaN, 24],
        [-1, 24],
      ] as const) {
        expect(() => proc.resize(c, r)).toThrow(RangeError)
      }
      expect(() => proc.resize(120, 40)).not.toThrow()
    })

    it('spawn rechaza dimensiones inválidas', async () => {
      subject = create()
      for (const [cols, rows] of [
        [0, 24],
        [80, 1001],
        [Number.NaN, 24],
      ] as const) {
        await expect(subject.port.spawn({ ...subject.command, cols, rows })).rejects.toThrow()
      }
    })

    it('write con datos hostiles (NUL, ESC, enorme) no lanza', async () => {
      const proc = await start()
      expect(() => proc.write('\u0000\u001b]0;x\u0007')).not.toThrow()
      expect(() => proc.write('x'.repeat(65536))).not.toThrow()
    })
  })
}
