import { describe, expect, it } from 'vitest'
import { manualFrames } from '../test-helpers.ts'
import { TerminalHub, type TerminalSink } from './hub.ts'

class CountingSink implements TerminalSink {
  total = 0
  maxChunk = 0
  writes = 0
  write(data: string, done: () => void): void {
    this.total += data.length
    this.maxChunk = Math.max(this.maxChunk, data.length)
    this.writes++
    done()
  }
  reset(): void {}
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('hub: ráfagas y datos hostiles', () => {
  it('10 MB a una terminal oculta: memoria acotada y entregas por fotograma pequeñas', async () => {
    const frames = manualFrames()
    const hub = new TerminalHub({
      frame: frames.frame,
      read: async () => ({ data: '', offset: 0 }),
      maxPendingChars: 1024 * 1024,
      hiddenBudget: 32 * 1024,
    })
    const sink = new CountingSink()
    hub.sync(['x1'])
    await tick()
    hub.attach('x1', sink)
    hub.setVisible('x1', false)
    const chunk = 'x'.repeat(1024 * 1024)
    let offset = 0
    for (let i = 0; i < 10; i++) {
      offset += chunk.length
      hub.onOutput('x1', offset, chunk)
      expect(hub.pendingCharsOf('x1')).toBeLessThanOrEqual(1024 * 1024)
    }
    frames.flush(1)
    expect(sink.maxChunk).toBeLessThanOrEqual(32 * 1024)
    // En un solo fotograma jamás se entrega más que el presupuesto.
    expect(sink.total).toBeLessThanOrEqual(32 * 1024)
    // Vaciando fotograma a fotograma se termina: no hay bucle infinito.
    frames.flush(100_000)
    expect(hub.pendingCharsOf('x1')).toBe(0)
    expect(sink.total).toBeLessThanOrEqual(1024 * 1024)
  })

  it('un único fragmento mayor que el tope conserva solo su final', async () => {
    const frames = manualFrames()
    const hub = new TerminalHub({
      frame: frames.frame,
      read: async () => ({ data: '', offset: 0 }),
      maxPendingChars: 1000,
    })
    hub.sync(['x1'])
    await tick()
    hub.onOutput('x1', 5000, 'y'.repeat(5000))
    expect(hub.pendingCharsOf('x1')).toBe(1000)
  })

  it('no parte un par sustituto al trocear', async () => {
    const frames = manualFrames()
    const hub = new TerminalHub({
      frame: frames.frame,
      read: async () => ({ data: '', offset: 0 }),
      visibleBudget: 5,
    })
    const pieces: string[] = []
    hub.sync(['x1'])
    await tick()
    hub.attach('x1', {
      write: (d, done) => {
        pieces.push(d)
        done()
      },
      reset: () => {},
    })
    hub.setVisible('x1', true)
    hub.onOutput('x1', 40, '😀'.repeat(10))
    frames.flush(100)
    for (const p of pieces) expect(p).not.toMatch(/[\ud800-\udbff]$/)
    expect(pieces.join('')).toBe('😀'.repeat(10))
  })

  it('offsets absurdos (muy grandes, retrocesos) no rompen ni bloquean', async () => {
    const frames = manualFrames()
    let reads = 0
    const hub = new TerminalHub({
      frame: frames.frame,
      read: async () => {
        reads++
        return { data: 'z', offset: reads } // avanza 1 byte por lectura, nunca termina
      },
    })
    hub.sync(['x1'])
    await tick()
    hub.onOutput('x1', Number.MAX_SAFE_INTEGER, 'a')
    await tick()
    await new Promise((r) => setTimeout(r, 20))
    expect(reads).toBeLessThanOrEqual(400) // tope de rondas por relectura × reintentos de hueco
    hub.onOutput('x1', -5, 'a')
    hub.onOutput('x1', 0, '')
  })

  it('miles de eventos para terminales inexistentes no acumulan estado', () => {
    const frames = manualFrames()
    const hub = new TerminalHub({
      frame: frames.frame,
      read: async () => ({ data: '', offset: 0 }),
    })
    for (let i = 0; i < 5000; i++) hub.onOutput(`fantasma-${i}`, 10, '0123456789')
    expect(frames.pending).toBe(0)
  })

  it('una terminal eliminada durante la relectura no revive', async () => {
    const frames = manualFrames()
    let release!: (v: { data: string; offset: number }) => void
    const hub = new TerminalHub({
      frame: frames.frame,
      read: () =>
        new Promise((r) => {
          release = r
        }),
    })
    hub.sync(['x1'])
    hub.sync([])
    release({ data: 'tarde', offset: 5 })
    await tick()
    expect(hub.has('x1')).toBe(false)
    expect(frames.pending).toBe(0)
  })
})
