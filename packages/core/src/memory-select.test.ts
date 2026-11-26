import type { Block, BlockId } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { DEFAULT_SELECT_LIMITS, pendingObserverTokens, selectForObserver } from './memory-select.ts'

const base = (index: number) => ({
  id: `b${index}` as BlockId,
  index,
  turn: 1,
  seq: 0,
  createdAt: 1,
})
const user = (index: number, text: string): Block => ({ ...base(index), type: 'user', text })
const agent = (index: number, text: string, complete = true): Block => ({
  ...base(index),
  type: 'text',
  text,
  complete,
})
const usage = (index: number): Block => ({
  ...base(index),
  type: 'usage',
  stopReason: 'end-turn',
  usage: { inputTokens: 99999, outputTokens: 5 },
})
const action = (index: number, over: Record<string, unknown> = {}): Block =>
  ({
    ...base(index),
    type: 'action',
    kind: 'exec',
    status: 'ok',
    tool: 'Bash',
    title: 'npm test',
    ...over,
  }) as Block

describe('selectForObserver', () => {
  it('elige texto, razonamiento resumido, acciones y errores; nunca usage, permisos ni planes', () => {
    const blocks: Block[] = [
      user(0, 'hola'),
      { ...base(1), type: 'reasoning', text: 'r'.repeat(5000), complete: true },
      action(2, { output: 'salida', exitCode: 0 }),
      usage(3),
      { ...base(4), type: 'plan', entries: [] },
      { ...base(5), type: 'error', code: 'E1', message: 'se rompió', fatal: false },
      agent(6, 'listo'),
    ]
    const r = selectForObserver(blocks, -1)
    expect(r).not.toBeNull()
    expect(r?.range).toEqual({ from: 0, to: 6 })
    expect(r?.lines.map((l) => l.index)).toEqual([0, 1, 2, 5, 6])
    expect(r?.transcript).not.toContain('99999')
    const reasoning = r?.lines[1]?.text ?? ''
    expect(reasoning.length).toBeLessThan(DEFAULT_SELECT_LIMITS.maxReasoningChars + 30)
    expect(r?.transcript.split('\n')[0]).toBe('[#0] usuario: hola')
    expect(r?.tokens).toBe(r?.lines.reduce((a, l) => a + l.tokens, 0))
  })

  it('recorta la salida de las acciones conservando principio y final', () => {
    const out = `${'INICIO '.repeat(5)}${'x'.repeat(5000)} FINAL-FIN`
    const r = selectForObserver([action(0, { output: out, path: 'src/a.ts' })], -1)
    const line = r?.lines[0]?.text ?? ''
    expect(line).toContain('INICIO')
    expect(line).toContain('FINAL-FIN')
    expect(line).toContain('[…]')
    expect(line).toContain('ruta src/a.ts')
    expect(line.length).toBeLessThan(1200)
  })

  it('solo mira bloques nuevos y se detiene en el primer bloque abierto', () => {
    const blocks = [user(0, 'a'), agent(1, 'b'), agent(2, 'en curso', false), user(3, 'c')]
    expect(selectForObserver(blocks, -1)?.range).toEqual({ from: 0, to: 1 })
    expect(selectForObserver(blocks, 1)).toBeNull()
    const running = selectForObserver([user(0, 'a'), action(1, { status: 'running' })], -1)
    expect(running?.range).toEqual({ from: 0, to: 0 })
  })

  it('un permiso o pregunta pendiente también cierra el lote', () => {
    const permission = {
      ...base(1),
      type: 'permission',
      tool: 'Bash',
      title: 'rm',
      options: [{ id: 'a', label: 'ok', kind: 'allow-once' }],
      state: 'pending',
    } as Block
    expect(selectForObserver([user(0, 'a'), permission, user(2, 'b')], -1)?.range.to).toBe(0)
  })

  it('respeta el tope de tokens del lote pero siempre toma al menos un bloque', () => {
    const blocks = Array.from({ length: 10 }, (_, i) => user(i, 'palabra '.repeat(100)))
    const r = selectForObserver(blocks, -1, { ...DEFAULT_SELECT_LIMITS, maxBatchTokens: 500 })
    expect(r?.lines.length).toBeGreaterThan(0)
    expect(r?.lines.length).toBeLessThan(10)
    expect(r?.tokens).toBeLessThanOrEqual(500)
    const one = selectForObserver(blocks, -1, { ...DEFAULT_SELECT_LIMITS, maxBatchTokens: 1 })
    expect(one?.lines).toHaveLength(1)
    expect(one?.range).toEqual({ from: 0, to: 0 })
  })

  it('ordena por índice, ignora duplicados y no se rompe con huecos', () => {
    const r = selectForObserver([user(5, 'c'), user(2, 'a'), user(2, 'a'), user(9, 'd')], -1)
    expect(r?.lines.map((l) => l.index)).toEqual([2, 5, 9])
    expect(selectForObserver([], -1)).toBeNull()
    expect(selectForObserver([usage(0)], -1)).toBeNull()
  })

  it('pendingObserverTokens cuenta todo lo nuevo sin tope', () => {
    const blocks = Array.from({ length: 50 }, (_, i) => user(i, 'palabra '.repeat(400)))
    expect(pendingObserverTokens(blocks, -1)).toBeGreaterThan(DEFAULT_SELECT_LIMITS.maxBatchTokens)
    expect(pendingObserverTokens(blocks, 49)).toBe(0)
  })
})
