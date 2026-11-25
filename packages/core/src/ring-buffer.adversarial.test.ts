import { utf8ByteLength } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { RingBuffer } from './ring-buffer.ts'

describe('RingBuffer (adversarial)', () => {
  it('ráfaga de 50 MB en un solo trozo: queda la capacidad y el offset es exacto', () => {
    const ring = new RingBuffer()
    const big = 'x'.repeat(50 * 1024 * 1024)
    ring.write(big)
    expect(ring.offset).toBe(50 * 1024 * 1024)
    expect(ring.size).toBe(2 * 1024 * 1024)
    expect(ring.read().data.length).toBe(2 * 1024 * 1024)
  })

  it('ráfaga de 50 MB en trozos de 64 KiB con multibyte: nunca supera la capacidad', () => {
    const ring = new RingBuffer()
    const piece = '€'.repeat(21845)
    let total = 0
    for (let i = 0; i < 800; i++) {
      ring.write(piece)
      total += utf8ByteLength(piece)
      expect(ring.size).toBeLessThanOrEqual(2 * 1024 * 1024)
    }
    expect(ring.offset).toBe(total)
    const { data } = ring.read()
    expect(data).toBe('€'.repeat(data.length))
    expect(data.length * 3).toBeGreaterThan(2 * 1024 * 1024 - 3)
  })

  it('caracteres de 4 bytes con capacidad mínima', () => {
    const ring = new RingBuffer(4)
    for (let i = 0; i < 100; i++) ring.write('😀')
    expect(ring.read().data).toBe('😀')
    ring.write('é')
    expect(ring.read().data).toBe('é')
    expect(ring.size).toBeLessThanOrEqual(4)
  })

  it('sustitutos sueltos o invertidos no rompen los límites', () => {
    const ring = new RingBuffer(10)
    for (const junk of ['\ud83d', '\ude00', '\ude00\ud83d', 'a\ud83d', '\ud83d😀']) {
      ring.write(junk.repeat(20))
      expect(ring.size).toBeLessThanOrEqual(10)
      expect(ring.size).toBe(utf8ByteLength(ring.read().data))
    }
  })

  it('offsets y límites hostiles no lanzan ni devuelven basura', () => {
    const ring = new RingBuffer(16)
    ring.write('hola')
    expect(ring.read({ fromOffset: Number.MAX_SAFE_INTEGER })).toEqual({
      data: '',
      offset: 4,
      truncated: false,
    })
    expect(ring.read({ fromOffset: 0, maxBytes: 0 })).toEqual({
      data: '',
      offset: 0,
      truncated: false,
    })
    expect(ring.read({ maxBytes: 0 }).data).toBe('')
    expect(ring.read({ fromOffset: 0, maxBytes: 1 }).data).toBe('h')
  })

  it('lecturas con maxBytes menor que un carácter no parten el carácter', () => {
    const ring = new RingBuffer(64)
    ring.write('😀😀')
    expect(ring.read({ fromOffset: 0, maxBytes: 3 })).toEqual({
      data: '',
      offset: 0,
      truncated: false,
    })
    expect(ring.read({ fromOffset: 0, maxBytes: 5 }).data).toBe('😀')
  })

  it('muchas escrituras diminutas siguen consistentes', () => {
    const ring = new RingBuffer(1000)
    let all = ''
    for (let i = 0; i < 20000; i++) {
      const c = String.fromCharCode(97 + (i % 26))
      ring.write(c)
      all += c
    }
    expect(ring.read().data).toBe(all.slice(-1000))
    expect(ring.offset).toBe(20000)
  })
})
