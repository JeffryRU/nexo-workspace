import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { decodeBase64, decodeUtf8, encodeBase64, encodeUtf8 } from './bytes.ts'

describe('bytes del testkit', () => {
  it('vectores conocidos', () => {
    expect([...encodeUtf8('a€🎉')]).toEqual([0x61, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x8e, 0x89])
    expect(encodeBase64(encodeUtf8('Man'))).toBe('TWFu')
    expect(encodeBase64(encodeUtf8('Ma'))).toBe('TWE=')
    expect(encodeBase64(encodeUtf8('M'))).toBe('TQ==')
    expect(encodeBase64(new Uint8Array(0))).toBe('')
    expect([...decodeBase64('TWE=')]).toEqual([0x4d, 0x61])
    expect(() => decodeBase64('***')).toThrow('base64')
  })

  it('ida y vuelta de UTF-8 y de base64', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'grapheme', maxLength: 60 }),
        fc.uint8Array({ maxLength: 40 }),
        (text, raw) => {
          expect(decodeUtf8(encodeUtf8(text))).toBe(text)
          expect([...decodeBase64(encodeBase64(raw))]).toEqual([...raw])
        },
      ),
    )
  })

  it('el UTF-8 inválido sale como U+FFFD sin lanzar', () => {
    expect(decodeUtf8(Uint8Array.from([0x61, 0xff, 0xc3, 0x28, 0xe2, 0x82]))).toContain('�')
    expect(decodeUtf8(Uint8Array.from([0xed, 0xa0, 0x80]))).toContain('�')
    expect(decodeUtf8(Uint8Array.from([0xf4, 0x90, 0x80, 0x80]))).toContain('�')
    expect(decodeUtf8(Uint8Array.from([0xe0, 0x80, 0x80]))).toContain('�')
  })
})
