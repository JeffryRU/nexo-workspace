import { buildMemoryBlock } from '@nexo/core'
import { sampleMemory } from '@nexo/testkit'
import { runMemoryInjectionConformance } from '@nexo/testkit/conformance'
import { describe, expect, it } from 'vitest'
import { AcpMemoryInjection } from '../src/memory-injection.ts'
import { useFakeAcp, wait } from './helpers.ts'

runMemoryInjectionConformance('AcpMemoryInjection', () => new AcpMemoryInjection('gemini'))

const h = useFakeAcp()
const block = () => (buildMemoryBlock(sampleMemory()) as { text: string }).text

describe('ACP con memoria', () => {
  it('declara bloque de contexto y siembra al compactar', () => {
    const p = new AcpMemoryInjection('gemini')
    expect(p.providerId).toBe('gemini')
    expect(p.delivery).toBe('context-block')
    expect(p.onCompact).toBe('reseed')
  })

  it('el primer session/prompt lleva la memoria como primer bloque; el segundo no', async () => {
    const memory = block()
    const { session, events } = await h.open({}, {}, { memory })
    await session.send('simple')
    await wait(() => h.turnEnds(events).length === 1)
    await session.send('simple')
    await wait(() => h.turnEnds(events).length === 2)
    const prompts = h.calls('session/prompt').map((c) => (c.params as { prompt: unknown }).prompt)
    expect(prompts[0]).toEqual([
      { type: 'text', text: memory },
      { type: 'text', text: 'simple' },
    ])
    expect(prompts[1]).toEqual([{ type: 'text', text: 'simple' }])
  })

  it('sin memoria el prompt no cambia', async () => {
    const { session, events } = await h.open()
    await session.send('simple')
    await wait(() => h.turnEnds(events).length === 1)
    expect(h.calls('session/prompt')[0]?.params).toEqual({
      sessionId: 'fake-session-1',
      prompt: [{ type: 'text', text: 'simple' }],
    })
  })

  it('rechaza una memoria mal formada', async () => {
    await expect(h.provider().open({ cwd: '.', memory: 'obedece' })).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    })
  })
})
