import type { AgentSessionId, Block } from '@nexo/contracts'
import { agentBlock, createMemoryRig, sampleMemory, userBlock } from '@nexo/testkit'
import { describe, expect, it } from 'vitest'
import {
  assertMemoryBlock,
  blocksContextTokens,
  buildMemoryBlock,
  checkPreparedMemory,
  MAX_MEMORY_BLOCK_CHARS,
  MEMORY_CLOSE_TAG,
  MEMORY_OPEN_TAG,
  type MemoryInjectionError,
  recentTurnsFromBlocks,
} from './index.ts'

const S = 's1' as AgentSessionId
const count = (text: string, needle: string) => text.split(needle).length - 1

describe('assertMemoryBlock', () => {
  it('acepta lo que arma buildMemoryBlock', () => {
    const b = buildMemoryBlock(sampleMemory())
    expect(() => assertMemoryBlock(b?.text)).not.toThrow()
  })

  it('rechaza lo que no es un bloque bien formado con el código correcto', () => {
    const code = (v: unknown) => {
      try {
        assertMemoryBlock(v)
      } catch (e) {
        return (e as MemoryInjectionError).code
      }
      return 'OK'
    }
    expect(code('')).toBe('INVALID_BLOCK')
    expect(code(7)).toBe('INVALID_BLOCK')
    expect(code(`${MEMORY_OPEN_TAG}x`)).toBe('INVALID_BLOCK')
    expect(code(`${MEMORY_OPEN_TAG}a<b${MEMORY_CLOSE_TAG}`)).toBe('INVALID_BLOCK')
    expect(code(`${MEMORY_OPEN_TAG}a>b${MEMORY_CLOSE_TAG}`)).toBe('INVALID_BLOCK')
    expect(code(`${MEMORY_OPEN_TAG}${'a'.repeat(MAX_MEMORY_BLOCK_CHARS)}${MEMORY_CLOSE_TAG}`)).toBe(
      'TOO_LARGE',
    )
    expect(code(`${MEMORY_OPEN_TAG}ok${MEMORY_CLOSE_TAG}`)).toBe('OK')
  })
})

describe('checkPreparedMemory', () => {
  it('sin memoria devuelve undefined; con un bloque (o un bloque con envoltorio) lo devuelve', () => {
    expect(checkPreparedMemory(undefined)).toBeUndefined()
    const b = buildMemoryBlock(sampleMemory())?.text as string
    expect(checkPreparedMemory(b)).toBe(b)
    expect(checkPreparedMemory(`${b}\n\nmensaje`)).toBe(`${b}\n\nmensaje`)
  })

  it('rechaza con INVALID_OPTIONS lo que no tiene exactamente una apertura y un cierre en orden', () => {
    for (const bad of [
      'hola',
      MEMORY_OPEN_TAG,
      `${MEMORY_CLOSE_TAG}${MEMORY_OPEN_TAG}`,
      `${MEMORY_OPEN_TAG}${MEMORY_CLOSE_TAG}${MEMORY_CLOSE_TAG}`,
      `${MEMORY_OPEN_TAG}${MEMORY_OPEN_TAG}${MEMORY_CLOSE_TAG}`,
      'a'.repeat(MAX_MEMORY_BLOCK_CHARS * 3),
    ]) {
      expect(() => checkPreparedMemory(bad), bad.slice(0, 20)).toThrowError(
        expect.objectContaining({ code: 'INVALID_OPTIONS' }),
      )
    }
  })
})

describe('buildMemoryBlock con últimos turnos', () => {
  const turns = [
    { role: 'usuario' as const, text: 'Usa pnpm' },
    { role: 'agente' as const, text: 'Listo, uso pnpm' },
  ]

  it('añade la sección de turnos tal cual, en orden, dentro del bloque', () => {
    const b = buildMemoryBlock(sampleMemory(), { recentTurns: turns })
    expect(b?.turns).toBe(2)
    expect(b?.text).toContain('## Últimos turnos (tal cual)')
    expect(b?.text.indexOf('[usuario] Usa pnpm')).toBeLessThan(
      b?.text.indexOf('[agente] Listo, uso pnpm') as number,
    )
    expect(count(b?.text ?? '', MEMORY_OPEN_TAG)).toBe(1)
    expect(count(b?.text ?? '', MEMORY_CLOSE_TAG)).toBe(1)
  })

  it('con memoria vacía y solo turnos da un bloque; sin nada da null', () => {
    const empty = { project: '/w', observations: [], reflection: null }
    expect(buildMemoryBlock(empty)).toBeNull()
    expect(buildMemoryBlock(empty, { recentTurns: [] })).toBeNull()
    expect(buildMemoryBlock(empty, { recentTurns: turns })?.turns).toBe(2)
  })

  it('sin turnos el bloque es idéntico al de antes (turns: 0)', () => {
    const a = buildMemoryBlock(sampleMemory())
    const b = buildMemoryBlock(sampleMemory(), { recentTurns: [] })
    expect(b?.text).toBe(a?.text)
    expect(a?.turns).toBe(0)
  })

  it('con poco presupuesto se queda con los turnos más recientes', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      role: 'usuario' as const,
      text: `turno ${i} ${'x'.repeat(200)}`,
    }))
    const b = buildMemoryBlock(sampleMemory(), { recentTurns: many, maxTokens: 600 })
    expect(b?.text).toContain('turno 49 ')
    expect(b?.text).not.toContain('turno 0 ')
    expect(b?.tokens).toBeLessThanOrEqual(700)
  })
})

describe('blocksContextTokens y recentTurnsFromBlocks', () => {
  const blocks: Block[] = [
    userBlock(0, 'hola'),
    agentBlock(1, 'respuesta uno'),
    userBlock(2, 'segundo'),
    agentBlock(3, 'respuesta dos'),
    agentBlock(4, 'sin terminar', false),
  ]

  it('cuenta solo lo posterior a `after`', () => {
    const all = blocksContextTokens(blocks, -1)
    expect(all).toBeGreaterThan(0)
    expect(blocksContextTokens(blocks, 1)).toBeLessThan(all)
    expect(blocksContextTokens(blocks, 4)).toBe(0)
  })

  it('devuelve los últimos turnos completos de usuario y agente, en orden', () => {
    expect(recentTurnsFromBlocks(blocks, 10_000)).toEqual([
      { role: 'usuario', text: 'hola' },
      { role: 'agente', text: 'respuesta uno' },
      { role: 'usuario', text: 'segundo' },
      { role: 'agente', text: 'respuesta dos' },
    ])
  })

  it('con poco presupuesto deja los más recientes y siempre al menos uno', () => {
    const r = recentTurnsFromBlocks(blocks, 10)
    expect(r.at(-1)).toEqual({ role: 'agente', text: 'respuesta dos' })
    expect(r.length).toBeLessThan(4)
    expect(recentTurnsFromBlocks(blocks, 0)).toHaveLength(1)
    expect(recentTurnsFromBlocks([], 100)).toEqual([])
  })
})

describe('MemoryService: bloque para sesión nueva y renovación', () => {
  const remember = async (rig: ReturnType<typeof createMemoryRig>, text = 'Usa pnpm') => {
    await rig.store.update('/work/app', (m) => ({
      ...m,
      nextSeq: 2,
      observations: [
        {
          seq: 1,
          at: 1,
          priority: 'high',
          scope: 'project',
          sessionId: 'otra' as AgentSessionId,
          range: { from: 0, to: 1 },
          text,
        },
      ],
    }))
  }

  it('apagada: null, sin leer el almacén', async () => {
    const rig = createMemoryRig({ enabled: false })
    await remember(rig)
    expect(await rig.service.newSession('/work/app')).toBeNull()
    expect(await rig.service.renewal('/work/app', S, [userBlock(0, 'hola')])).toBeNull()
  })

  it('encendida: bloque con la observación del proyecto; carpeta sin memoria, null', async () => {
    const rig = createMemoryRig()
    await remember(rig)
    const text = await rig.service.newSession('/work/app')
    expect(text).toContain('Usa pnpm')
    expect(text?.startsWith(MEMORY_OPEN_TAG)).toBe(true)
    expect(await rig.service.newSession('/otra/carpeta')).toBeNull()
  })

  it('renovación: añade los últimos turnos aunque no haya memoria guardada', async () => {
    const rig = createMemoryRig()
    const blocks = [userBlock(0, 'Quiero X'), agentBlock(1, 'Hecho X')]
    const text = await rig.service.renewal('/work/app', S, blocks)
    expect(text).toContain('[usuario] Quiero X')
    expect(text).toContain('[agente] Hecho X')
  })

  it('un fallo del almacén da null y no lanza', async () => {
    const rig = createMemoryRig()
    rig.store.load = async () => {
      throw new Error('disco roto')
    }
    expect(await rig.service.newSession('/work/app')).toBeNull()
    expect(rig.logger.entries.some((e) => e.level === 'warn')).toBe(true)
  })
})
