import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { harness } from './helpers.ts'

/** Parte `text` en trozos según `cuts` (posiciones relativas), sin perder nada. */
function chunk(text: string, cuts: number[]): string[] {
  const points = [...new Set(cuts.map((c) => c % (text.length + 1)))].sort((a, b) => a - b)
  const out: string[] = []
  let last = 0
  for (const p of points) {
    out.push(text.slice(last, p))
    last = p
  }
  out.push(text.slice(last))
  return out
}

// Normalizada por JSON (sin -0 ni claves que se pierdan) para poder comparar tras un viaje de ida y vuelta.
const json = fc.jsonValue({ maxDepth: 3 }).map((v) => JSON.parse(JSON.stringify(v)) as unknown)
const method = fc
  .string({ minLength: 1, maxLength: 20, unit: 'binary' })
  .filter((m) => m.trim() !== '')

describe('JsonRpcConnection: propiedades', () => {
  it('el resultado no depende de cómo se parta el flujo', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ method, params: json }), { minLength: 1, maxLength: 8 }),
        fc.array(fc.nat(), { maxLength: 20 }),
        (messages, cuts) => {
          const text = messages.map((m) => `${JSON.stringify(m)}\n`).join('')
          const whole = harness()
          whole.conn.feed(text)
          const split = harness()
          for (const part of chunk(text, cuts)) split.conn.feed(part)
          expect(split.notifications).toEqual(whole.notifications)
          expect(whole.notifications).toHaveLength(messages.length)
        },
      ),
    )
  })

  it('cada solicitud recibe exactamente su respuesta, en cualquier orden', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(json, { minLength: 1, maxLength: 10 }),
        fc.nat(),
        async (results, seed) => {
          const h = harness({ requestTimeoutMs: 0 })
          const promises = results.map((_, i) => h.conn.request(`m${i}`))
          const order = results
            .map((_, i) => i)
            .sort((a, b) => ((a * 7919 + seed) % 13) - ((b * 7919 + seed) % 13))
          for (const i of order)
            h.conn.feed(`${JSON.stringify({ id: i + 1, result: results[i] })}\n`)
          expect(await Promise.all(promises)).toEqual(results)
          expect(h.conn.pendingCount).toBe(0)
          expect(h.issues).toEqual([])
        },
      ),
    )
  })

  it('basura arbitraria nunca lanza ni deja la conexión en estado inconsistente', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ unit: 'binary', maxLength: 200 }), { maxLength: 30 }),
        (parts) => {
          const h = harness({ maxIssues: 10_000 })
          for (const p of parts) h.conn.feed(p)
          h.conn.end()
          expect(h.conn.pendingCount).toBe(0)
          expect(h.closes).toHaveLength(1)
        },
      ),
    )
  })

  it('lo que se escribe es una línea JSON válida por mensaje', () => {
    fc.assert(
      fc.property(method, json, (m, params) => {
        const h = harness()
        h.conn.notify(m, params)
        h.conn.request(m, params, { timeoutMs: 0 }).catch(() => {})
        for (const line of h.written) {
          expect(line.endsWith('\n')).toBe(true)
          expect(line.slice(0, -1)).not.toContain('\n')
          expect(() => JSON.parse(line)).not.toThrow()
        }
        h.conn.close()
      }),
    )
  })
})
