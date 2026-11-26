import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ACP_AGENTS,
  effectiveAcpAgents,
  MAX_ACP_AGENTS,
  parseAcpAgents,
  RESERVED_PROVIDER_IDS,
} from '../src/index.ts'

const ok = { id: 'otro', name: 'Otro agente', command: 'otro-cli' }

describe('NEXO_ACP_AGENTS', () => {
  it('acepta una lista con args y env opcionales y rellena args', () => {
    const [a, b] = parseAcpAgents(
      JSON.stringify([ok, { ...ok, id: 'dos', args: ['--acp', '-x'], env: { MI_VAR: '1' } }]),
    )
    expect(a).toEqual({ ...ok, args: [] })
    expect(b).toMatchObject({ args: ['--acp', '-x'], env: { MI_VAR: '1' } })
  })

  it('una lista vacía es válida', () => {
    expect(parseAcpAgents('[]')).toEqual([])
  })

  it('rechaza JSON roto, algo que no es lista, claves extra y campos faltantes', () => {
    for (const bad of [
      '{',
      '',
      '{}',
      '"x"',
      JSON.stringify([{ ...ok, extra: 1 }]),
      JSON.stringify([{ id: 'a', name: 'A' }]),
      JSON.stringify([{ ...ok, command: '' }]),
      JSON.stringify([{ ...ok, name: '' }]),
      JSON.stringify([{ ...ok, args: [1] }]),
      JSON.stringify([{ ...ok, __proto__: { x: 1 }, id: 'ok1', extra: 1 }]),
    ]) {
      expect(() => parseAcpAgents(bad), bad).toThrow()
    }
  })

  it('los ids tienen forma acotada y no chocan con los proveedores incluidos', () => {
    for (const id of [
      ...RESERVED_PROVIDER_IDS,
      'Gemini',
      '1a',
      'a_b',
      'a b',
      '',
      'x'.repeat(33),
      'ñ',
    ]) {
      expect(() => parseAcpAgents(JSON.stringify([{ ...ok, id }])), id).toThrow()
    }
    for (const id of ['gemini', 'a', 'mi-agente-2', 'x'.repeat(32)]) {
      expect(() => parseAcpAgents(JSON.stringify([{ ...ok, id }])), id).not.toThrow()
    }
  })

  it('los ids deben ser únicos y no más de 16 agentes', () => {
    expect(() => parseAcpAgents(JSON.stringify([ok, ok]))).toThrow(/repetido/)
    const many = Array.from({ length: MAX_ACP_AGENTS + 1 }, (_, i) => ({ ...ok, id: `a${i}` }))
    expect(() => parseAcpAgents(JSON.stringify(many))).toThrow(/demasiados/)
  })

  it('el entorno de un agente: nombres válidos, sin NEXO_*, con tope', () => {
    for (const env of [{ 'A B': '1' }, { NEXO_TOKEN: 'x' }, { A: 1 }, { '': 'x' }]) {
      expect(() => parseAcpAgents(JSON.stringify([{ ...ok, env }])), JSON.stringify(env)).toThrow()
    }
    const big = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`V${i}`, 'x']))
    expect(() => parseAcpAgents(JSON.stringify([{ ...ok, env: big }]))).toThrow(
      /demasiadas variables/,
    )
  })

  it('el nombre no admite caracteres de control; el comando y los args no admiten NUL', () => {
    expect(() => parseAcpAgents(JSON.stringify([{ ...ok, name: 'a\nb' }]))).toThrow()
    expect(() => parseAcpAgents(JSON.stringify([{ ...ok, command: 'a\u0000b' }]))).toThrow()
    expect(() => parseAcpAgents(JSON.stringify([{ ...ok, args: ['a\u0000'] }]))).toThrow()
  })

  it('un JSON desmesurado se rechaza sin analizarlo', () => {
    expect(() => parseAcpAgents(`[${' '.repeat(300 * 1024)}]`)).toThrow(/demasiado grande/)
  })

  it('el mensaje de error dice dónde está el problema', () => {
    expect(() => parseAcpAgents(JSON.stringify([ok, { ...ok, id: 'claude' }]))).toThrow(
      /1\.id: id reservado/,
    )
  })

  it('entradas arbitrarias nunca lanzan otra cosa que Error', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), (text) => {
        try {
          parseAcpAgents(text)
        } catch (error) {
          expect(error).toBeInstanceOf(Error)
        }
      }),
    )
  })
})

describe('agentes efectivos', () => {
  it('por omisión existe «gemini» con --acp', () => {
    expect(DEFAULT_ACP_AGENTS).toEqual([
      { id: 'gemini', name: 'Gemini', command: 'gemini', args: ['--acp'] },
    ])
    expect(effectiveAcpAgents([]).map((a) => a.id)).toEqual(['gemini'])
  })

  it('los declarados se suman y uno con id «gemini» sustituye al de omisión', () => {
    const mine = {
      id: 'gemini',
      name: 'Mi Gemini',
      command: '/x/gemini',
      args: ['--acp', '-m', 'y'],
    }
    expect(effectiveAcpAgents([{ ...ok, args: [] }]).map((a) => a.id)).toEqual(['gemini', 'otro'])
    expect(effectiveAcpAgents([mine])).toEqual([mine])
  })
})
