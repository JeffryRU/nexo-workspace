import { utf8ByteLength } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { DEFAULT_RING_CAPACITY, RingBuffer } from './ring-buffer.ts'

describe('RingBuffer', () => {
  it('usa 2 MiB por omisión y empieza vacío', () => {
    const ring = new RingBuffer()
    expect(ring.capacity).toBe(DEFAULT_RING_CAPACITY)
    expect(DEFAULT_RING_CAPACITY).toBe(2 * 1024 * 1024)
    expect(ring.read()).toEqual({ data: '', offset: 0, truncated: false })
  })

  it('rechaza capacidades inválidas', () => {
    for (const c of [0, 3, -1, 1.5, Number.NaN]) expect(() => new RingBuffer(c)).toThrow(RangeError)
  })

  it('el offset cuenta bytes UTF-8, no caracteres', () => {
    const ring = new RingBuffer(100)
    ring.write('aé€😀')
    expect(ring.offset).toBe(1 + 2 + 3 + 4)
    expect(ring.read().data).toBe('aé€😀')
    expect(ring.read().offset).toBe(10)
  })

  it('al llenarse conserva el sufijo y nunca supera la capacidad', () => {
    const ring = new RingBuffer(10)
    ring.write('0123456789')
    ring.write('abc')
    expect(ring.size).toBe(10)
    expect(ring.read().data).toBe('3456789abc')
    expect(ring.offset).toBe(13)
    expect(ring.startOffset).toBe(3)
  })

  it('no parte un carácter al recortar: descarta de más, nunca de menos', () => {
    const ring = new RingBuffer(5)
    ring.write('ab')
    ring.write('😀😀')
    // 'ab' + 8 bytes: sobran 5; se salta 'ab' y un emoji completo
    expect(ring.read().data).toBe('😀')
    expect(ring.size).toBeLessThanOrEqual(5)
  })

  it('un trozo mayor que la capacidad deja solo su sufijo (sin partir un par sustituto)', () => {
    const ring = new RingBuffer(6)
    ring.write('xyz😀😀😀')
    expect(ring.read().data).toBe('😀')
    expect(ring.offset).toBe(3 + 12)
    expect(ring.size).toBe(4)
  })

  it('lee desde un offset absoluto y devuelve el offset del final', () => {
    const ring = new RingBuffer(100)
    ring.write('hola ')
    ring.write('mundo')
    expect(ring.read({ fromOffset: 5 })).toEqual({ data: 'mundo', offset: 10, truncated: false })
    expect(ring.read({ fromOffset: 10 })).toEqual({ data: '', offset: 10, truncated: false })
    expect(ring.read({ fromOffset: 999 })).toEqual({ data: '', offset: 10, truncated: false })
  })

  it('indica truncated cuando el offset pedido ya se descartó', () => {
    const ring = new RingBuffer(5)
    ring.write('0123456789')
    expect(ring.read({ fromOffset: 2 })).toEqual({ data: '56789', offset: 10, truncated: true })
    expect(ring.read({ fromOffset: 5 }).truncated).toBe(false)
  })

  it('un offset en mitad de un carácter avanza al siguiente carácter', () => {
    const ring = new RingBuffer(100)
    ring.write('a😀b')
    expect(ring.read({ fromOffset: 2 })).toEqual({ data: 'b', offset: 6, truncated: false })
  })

  it('maxBytes limita la lectura: desde el offset toma lo más antiguo, sin offset lo más reciente', () => {
    const ring = new RingBuffer(100)
    ring.write('abcdef')
    expect(ring.read({ fromOffset: 1, maxBytes: 2 })).toEqual({
      data: 'bc',
      offset: 3,
      truncated: false,
    })
    expect(ring.read({ maxBytes: 2 })).toEqual({ data: 'ef', offset: 6, truncated: false })
    ring.write('😀')
    expect(ring.read({ maxBytes: 3 }).data).toBe('')
    expect(ring.read({ fromOffset: 6, maxBytes: 3 })).toEqual({
      data: '',
      offset: 6,
      truncated: false,
    })
  })

  it('leer no altera lo que se lee después', () => {
    const ring = new RingBuffer(8)
    ring.write('abc')
    ring.read()
    ring.write('defghij')
    expect(ring.read().data).toBe('cdefghij')
    expect(ring.size).toBe(utf8ByteLength('cdefghij'))
  })

  it('ignora escrituras vacías', () => {
    const ring = new RingBuffer(8)
    ring.write('')
    expect(ring.offset).toBe(0)
  })
})
