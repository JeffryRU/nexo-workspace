import { describe, expect, it, vi } from 'vitest'
import { manualFrames } from '../test-helpers.ts'
import { type ReadResult, sliceFromByte, TerminalHub, type TerminalSink } from './hub.ts'

class Sink implements TerminalSink {
  out = ''
  resets = 0
  hold = false
  dones: (() => void)[] = []
  write(data: string, done: () => void): void {
    this.out += data
    if (this.hold) this.dones.push(done)
    else done()
  }
  reset(): void {
    this.resets++
    this.out = ''
  }
}

function setup(
  read: (id: string, from: number) => Promise<ReadResult> = async () => ({ data: '', offset: 0 }),
) {
  const frames = manualFrames()
  const reader = vi.fn(read)
  const hub = new TerminalHub({ read: reader, frame: frames.frame })
  return { hub, frames, reader }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('sliceFromByte', () => {
  it('corta por bytes UTF-8 sin partir caracteres', () => {
    expect(sliceFromByte('abc', 0)).toBe('abc')
    expect(sliceFromByte('abc', 2)).toBe('c')
    expect(sliceFromByte('ñab', 2)).toBe('ab')
    expect(sliceFromByte('a😀b', 5)).toBe('b')
    expect(sliceFromByte('abc', 99)).toBe('')
  })
})

describe('TerminalHub', () => {
  it('con hiddenBudget 0 una terminal oculta no recibe nada y al mostrarse recibe lo pendiente', async () => {
    const frames = manualFrames()
    const hub = new TerminalHub({
      read: async () => ({ data: '', offset: 0 }),
      frame: frames.frame,
      hiddenBudget: 0,
    })
    const sink = new Sink()
    hub.sync(['x1'])
    await tick()
    hub.attach('x1', sink)
    hub.setVisible('x1', false)
    hub.onOutput('x1', 3, 'abc')
    frames.flush(5)
    expect(sink.out).toBe('')
    expect(hub.pendingCharsOf('x1')).toBe(3)
    hub.setVisible('x1', true)
    frames.flush()
    expect(sink.out).toBe('abc')
    expect(hub.pendingCharsOf('x1')).toBe(0)
  })

  it('escribe la salida agrupada por fotograma', async () => {
    const { hub, frames } = setup()
    const sink = new Sink()
    hub.sync(['x1'])
    await tick()
    hub.attach('x1', sink)
    hub.onOutput('x1', 3, 'abc')
    hub.onOutput('x1', 6, 'def')
    expect(sink.out).toBe('')
    frames.flush()
    expect(sink.out).toBe('abcdef')
    expect(hub.offsetOf('x1')).toBe(6)
  })

  it('descarta duplicados y recorta solapes parciales', async () => {
    const { hub, frames } = setup()
    const sink = new Sink()
    hub.sync(['x1'])
    await tick()
    hub.attach('x1', sink)
    hub.onOutput('x1', 3, 'abc')
    hub.onOutput('x1', 3, 'abc')
    hub.onOutput('x1', 5, 'bcde') // solapa un byte con lo anterior
    frames.flush()
    expect(sink.out).toBe('abcde'.slice(0, 3) + 'de'.slice(0))
    expect(hub.offsetOf('x1')).toBe(5)
  })

  it('ignora terminales desconocidas y no crece por ellas', () => {
    const { hub } = setup()
    hub.onOutput('fantasma', 4, 'hola')
    expect(hub.has('fantasma')).toBe(false)
    expect(hub.pendingCharsOf('fantasma')).toBe(0)
  })

  it('al conocer una terminal pide su historial desde 0', async () => {
    const { hub, frames, reader } = setup(async (_id, from) =>
      from === 0 ? { data: 'historial', offset: 9 } : { data: '', offset: 9 },
    )
    const sink = new Sink()
    hub.sync(['x1'])
    hub.attach('x1', sink)
    await tick()
    frames.flush()
    expect(sink.out).toBe('historial')
    expect(reader).toHaveBeenCalledWith('x1', 0)
    expect(hub.offsetOf('x1')).toBe(9)
  })

  it('un hueco en los eventos dispara una relectura desde el último offset, sin perder ni duplicar', async () => {
    const full = 'AAAABBBBCCCC'
    let first = true
    const { hub, frames, reader } = setup(async (_id, from) => {
      if (first) {
        first = false
        return { data: '', offset: 0 }
      }
      const data = full.slice(from)
      return { data, offset: full.length }
    })
    const sink = new Sink()
    hub.sync(['x1'])
    await tick()
    hub.attach('x1', sink)
    hub.onOutput('x1', 4, 'AAAA')
    // se pierde BBBB: llega CCCC (fin 12)
    hub.onOutput('x1', 12, 'CCCC')
    await tick()
    frames.flush()
    expect(sink.out).toBe('AAAABBBBCCCC')
    expect(reader).toHaveBeenCalledWith('x1', 4)
    expect(hub.offsetOf('x1')).toBe(12)
  })

  it('los eventos que llegan durante la relectura se retienen y luego se aplican', async () => {
    let release!: (r: ReadResult) => void
    const { hub, frames } = setup(
      () =>
        new Promise<ReadResult>((r) => {
          release = r
        }),
    )
    const sink = new Sink()
    hub.sync(['x1'])
    hub.attach('x1', sink)
    hub.onOutput('x1', 8, 'HISTORIA') // retenido (se está leyendo)
    hub.onOutput('x1', 11, 'fin')
    release({ data: 'HISTORIA', offset: 8 })
    await tick()
    release({ data: '', offset: 8 })
    await tick()
    frames.flush()
    expect(sink.out).toBe('HISTORIAfin')
  })

  it('si el búfer del daemon ya descartó el offset (truncated) vacía la pantalla', async () => {
    const { hub, frames } = setup(async (_id, from) =>
      from === 0 ? { data: 'nuevo', offset: 105, truncated: true } : { data: '', offset: 105 },
    )
    const sink = new Sink()
    sink.out = 'viejo'
    hub.sync(['x1'])
    hub.attach('x1', sink)
    await tick()
    frames.flush()
    expect(sink.resets).toBe(1)
    expect(sink.out).toBe('nuevo')
  })

  it('resync relee de todas las terminales desde su offset', async () => {
    const { hub, reader } = setup()
    hub.sync(['a', 'b'])
    await tick()
    reader.mockClear()
    await hub.resync()
    expect(reader.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b'])
  })

  it('si la lectura falla (sin conexión) no rompe y se puede reintentar', async () => {
    let fail = true
    const { hub, frames } = setup(async () => {
      if (fail) throw new Error('desconectado')
      return { data: 'ok', offset: 2 }
    })
    const sink = new Sink()
    hub.sync(['x1'])
    hub.attach('x1', sink)
    await tick()
    fail = false
    await hub.resync()
    frames.flush()
    expect(sink.out).toBe('ok')
  })

  it('olvida las terminales que ya no están en la lista', () => {
    const { hub } = setup()
    hub.sync(['a', 'b'])
    hub.sync(['b'])
    expect(hub.has('a')).toBe(false)
    expect(hub.has('b')).toBe(true)
  })

  it('espera a que xterm termine de escribir antes de entregar más (control de flujo)', async () => {
    const { hub, frames } = setup()
    const sink = new Sink()
    sink.hold = true
    hub.sync(['x1'])
    await tick()
    hub.attach('x1', sink)
    hub.onOutput('x1', 1, 'a')
    frames.flush()
    hub.onOutput('x1', 2, 'b')
    frames.flush()
    expect(sink.out).toBe('a')
    sink.dones.shift()?.()
    frames.flush()
    expect(sink.out).toBe('ab')
  })

  it('sin sink la salida queda pendiente hasta que se conecta uno', async () => {
    const { hub, frames } = setup()
    hub.sync(['x1'])
    await tick()
    hub.onOutput('x1', 3, 'abc')
    frames.flush()
    const sink = new Sink()
    const detach = hub.attach('x1', sink)
    frames.flush()
    expect(sink.out).toBe('abc')
    detach()
    hub.onOutput('x1', 4, 'd')
    frames.flush()
    expect(sink.out).toBe('abc')
  })

  it('attach a una terminal desconocida no hace nada y dispose limpia', () => {
    const { hub } = setup()
    expect(() => hub.attach('nada', new Sink())()).not.toThrow()
    hub.setVisible('nada', true)
    hub.dispose()
    hub.onOutput('x', 1, 'a')
    expect(hub.has('x')).toBe(false)
  })
})
