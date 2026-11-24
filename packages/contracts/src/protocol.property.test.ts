import { arbHostileJson, arbMutated, arbRequest, arbServerMessage } from '@atalaya/testkit'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { ERROR_CODES, parseRequest, parseServerMessage } from './index.ts'

const KNOWN = new Set<string>(ERROR_CODES)

describe('propiedades del protocolo', () => {
  it('toda petición válida generada parsea y hace ida y vuelta por JSON', () => {
    fc.assert(
      fc.property(arbRequest, (request) => {
        const r = parseRequest(JSON.stringify(request))
        expect(r.ok).toBe(true)
        if (r.ok) {
          expect(r.value.method).toBe(request.method)
          expect(r.value.id).toBe(request.id)
          // ida y vuelta: serializar lo parseado y volver a parsear da lo mismo
          expect(parseRequest(JSON.stringify(r.value))).toEqual(r)
        }
      }),
    )
  })

  it('todo mensaje del servidor válido generado parsea', () => {
    fc.assert(
      fc.property(arbServerMessage, (message) => {
        const r = parseServerMessage(JSON.stringify(message))
        expect(r.ok).toBe(true)
      }),
    )
  })

  it('un mensaje mutado o falla con un código conocido o es válido; nunca lanza', () => {
    fc.assert(
      fc.property(
        arbRequest.chain((req) => arbMutated(JSON.stringify(req))),
        (text) => {
          const r = parseRequest(text)
          if (!r.ok) expect(KNOWN.has(r.error.code)).toBe(true)
        },
      ),
      { numRuns: 500 },
    )
    fc.assert(
      fc.property(
        arbServerMessage.chain((msg) => arbMutated(JSON.stringify(msg))),
        (text) => {
          const r = parseServerMessage(text)
          if (!r.ok) expect(KNOWN.has(r.error.code)).toBe(true)
        },
      ),
      { numRuns: 500 },
    )
  })

  it('JSON arbitrario nunca lanza y los fallos llevan código conocido', () => {
    fc.assert(
      fc.property(arbHostileJson, (value) => {
        for (const r of [
          parseRequest(JSON.stringify(value)),
          parseServerMessage(JSON.stringify(value)),
        ]) {
          if (!r.ok) expect(KNOWN.has(r.error.code)).toBe(true)
        }
      }),
      { numRuns: 500 },
    )
  })

  it('texto arbitrario (incluso binario) nunca lanza', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (text) => {
        expect(() => parseRequest(text)).not.toThrow()
        expect(() => parseServerMessage(text)).not.toThrow()
      }),
    )
  })
})
