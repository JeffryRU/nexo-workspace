import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { blocksToText, renderBlock } from './render.ts'
import { block } from './test-helpers.ts'

type B = Parameters<typeof renderBlock>[0]
const r = (n: number, fields: Record<string, unknown>, options = {}) =>
  renderBlock(block(n, fields) as B, options)

describe('renderBlock', () => {
  it('mensajes y razonamiento', () => {
    expect(r(0, { type: 'user', text: 'hola' })).toMatchObject({
      index: 0,
      type: 'user',
      text: 'hola',
    })
    expect(r(1, { type: 'text', text: 'x', complete: true, truncated: true }).truncated).toBe(true)
    expect(r(2, { type: 'reasoning', text: 'pienso', complete: false }).text).toBe('pienso')
  })

  it('acciones: sin salida por omisión, con diff omitido y código de salida', () => {
    const base = {
      type: 'action',
      kind: 'exec',
      status: 'ok',
      tool: 'Bash',
      title: 'ls',
      output: 'secreto',
      exitCode: 2,
    }
    const hidden = r(0, base)
    expect(hidden.text).toContain('exec Bash: ls')
    expect(hidden.text).toContain('código de salida: 2')
    expect(hidden.text).not.toContain('secreto')
    expect(hidden.state).toBe('ok')
    const shown = r(0, base, { includeActionOutput: true })
    expect(shown.text).toContain('salida:\nsecreto')
    const edit = r(0, {
      type: 'action',
      kind: 'edit',
      status: 'ok',
      tool: 'Edit',
      title: 'e',
      path: '/a/b',
      diff: { path: '/a/b', patch: '-x\n+y' },
    })
    expect(edit.text).toContain('ruta: /a/b')
    expect(edit.text).toContain('(omitido)')
    expect(edit.text).not.toContain('+y')
    const long = r(0, { ...base, output: 'z'.repeat(10_000) }, { includeActionOutput: true })
    expect(long.truncated).toBe(true)
  })

  it('permisos, preguntas, planes, errores y uso', () => {
    const perm = r(0, {
      type: 'permission',
      tool: 'Bash',
      title: 'rm',
      detail: 'detalle',
      state: 'pending',
      options: [{ id: 'a', label: 'Sí', kind: 'allow-once' }],
    })
    expect(perm.text).toContain('a=Sí (allow-once)')
    expect(perm.state).toBe('pending')
    const q = r(0, {
      type: 'question',
      state: 'pending',
      questions: [
        {
          id: 'q',
          question: '¿Cuál?',
          options: [{ label: 'A' }, { label: 'B' }],
          multiSelect: false,
          allowText: false,
        },
      ],
    })
    expect(q.text).toBe('¿Cuál? [A | B]')
    expect(r(0, { type: 'plan', entries: [{ text: 'paso', status: 'pending' }] }).text).toBe(
      '[pending] paso',
    )
    const e = r(0, { type: 'error', code: 'E', message: 'mal', fatal: true })
    expect(e).toMatchObject({ state: 'fatal', text: 'E: mal' })
    expect(r(0, { type: 'error', code: 'E', message: 'mal', fatal: false }).state).toBe('error')
    expect(
      r(0, {
        type: 'usage',
        stopReason: 'end-turn',
        usage: { inputTokens: 5, outputTokens: 7, costUsd: 0.1 },
      }).text,
    ).toBe('fin: end-turn, entrada 5, salida 7, costo US$ 0.1')
  })

  it('blocksToText numera y marca lo recortado', () => {
    const text = blocksToText([
      { index: 3, type: 'user', turn: 1, text: 'a' },
      { index: 4, type: 'action', turn: 1, text: 'b', state: 'ok', truncated: true },
    ])
    expect(text).toContain('#3 usuario (turno 1)\na')
    expect(text).toContain('#4 acción ok (turno 1)\nb\n[recortado]')
  })

  it('propiedad: el texto de un bloque de texto nunca trae ESC ni pasa del tope', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 600 }), (text) => {
        const out = r(0, { type: 'text', text, complete: true }, { perBlockBytes: 64 })
        expect(out.text.includes('\x1b')).toBe(false)
        expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(64)
      }),
      { numRuns: 200 },
    )
  })
})
