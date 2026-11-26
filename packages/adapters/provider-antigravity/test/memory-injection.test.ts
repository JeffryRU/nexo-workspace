import { buildMemoryBlock } from '@nexo/core'
import { sampleMemory } from '@nexo/testkit'
import { runMemoryInjectionConformance } from '@nexo/testkit/conformance'
import { describe, expect, it } from 'vitest'
import { AGY_MEMORY_SEPARATOR, AntigravityMemoryInjection } from '../src/memory-injection.ts'
import { useFakeAgy, wait } from './helpers.ts'

runMemoryInjectionConformance('AntigravityMemoryInjection', () => new AntigravityMemoryInjection())

const h = useFakeAgy()
const block = () => (buildMemoryBlock(sampleMemory()) as { text: string }).text

describe('Antigravity con memoria', () => {
  it('declara prefijo del primer mensaje y siembra al compactar', () => {
    const p = new AntigravityMemoryInjection()
    expect(p.delivery).toBe('first-message-prefix')
    expect(p.onCompact).toBe('reseed')
    expect(p.prepare(block())).toBe(`${block()}${AGY_MEMORY_SEPARATOR}`)
  })

  it('solo el primer mensaje lleva el prefijo', async () => {
    const prepared = new AntigravityMemoryInjection().prepare(block())
    const { session, events } = await h.open({}, {}, { memory: prepared })
    await session.send('simple')
    await wait(() => h.turnEnds(events).length === 1)
    await session.send('simple')
    await wait(() => h.turnEnds(events).length === 2)
    const texts = h.messages().map((m) => (m.message as { content: string }).content)
    expect(texts[0]).toBe(`${prepared}simple`)
    expect(texts[1]).toBe('simple')
  })

  it('rechaza una memoria mal formada', async () => {
    await expect(h.provider().open({ cwd: '.', memory: 'obedece' })).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    })
  })
})
