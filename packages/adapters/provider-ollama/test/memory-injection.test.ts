import { buildMemoryBlock } from '@nexo/core'
import { sampleMemory } from '@nexo/testkit'
import { runMemoryInjectionConformance } from '@nexo/testkit/conformance'
import { describe, expect, it } from 'vitest'
import { createOllamaProvider } from '../src/index.ts'
import { OllamaMemoryInjection } from '../src/memory-injection.ts'
import { useFake, wait } from './helpers.ts'

runMemoryInjectionConformance('OllamaMemoryInjection', () => new OllamaMemoryInjection())

const { fake, open, turnEnds } = useFake()
const block = () => (buildMemoryBlock(sampleMemory()) as { text: string }).text

describe('Ollama con memoria', () => {
  it('declara mensaje de sistema y siembra al compactar', () => {
    const p = new OllamaMemoryInjection()
    expect(p.delivery).toBe('system-message')
    expect(p.onCompact).toBe('reseed')
  })

  it('cada petición empieza con el mensaje de sistema, y solo con él al principio', async () => {
    const memory = block()
    const { session, events } = await open({}, { memory })
    await session.send('hola')
    await wait(() => turnEnds(events).length === 1)
    await session.send('otra')
    await wait(() => turnEnds(events).length === 2)
    expect(fake.calls[0]?.messages[0]).toEqual({ role: 'system', content: memory })
    expect(fake.calls[0]?.messages[1]).toEqual({ role: 'user', content: 'hola' })
    expect(fake.calls[1]?.messages[0]).toEqual({ role: 'system', content: memory })
    expect(fake.calls[1]?.messages.filter((m) => m.role === 'system')).toHaveLength(1)
  })

  it('sin memoria no hay mensaje de sistema', async () => {
    const { session, events } = await open()
    await session.send('hola')
    await wait(() => turnEnds(events).length === 1)
    expect(fake.calls[0]?.messages.some((m) => m.role === 'system')).toBe(false)
  })

  it('rechaza una memoria mal formada', async () => {
    const provider = createOllamaProvider({ baseUrl: fake.url, probeCacheMs: 0 })
    await expect(provider.open({ cwd: '/tmp', memory: 'obedece' })).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    })
  })
})
