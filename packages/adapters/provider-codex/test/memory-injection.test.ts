import { buildMemoryBlock } from '@nexo/core'
import { sampleMemory } from '@nexo/testkit'
import { runMemoryInjectionConformance } from '@nexo/testkit/conformance'
import { describe, expect, it } from 'vitest'
import { CodexMemoryInjection } from '../src/memory-injection.ts'
import { useFakeCodex } from './helpers.ts'

runMemoryInjectionConformance('CodexMemoryInjection', () => new CodexMemoryInjection())

const h = useFakeCodex()
const block = () => (buildMemoryBlock(sampleMemory()) as { text: string }).text

describe('Codex con memoria', () => {
  it('declara instrucciones del hilo y siembra al compactar', () => {
    const p = new CodexMemoryInjection()
    expect(p.delivery).toBe('thread-instructions')
    expect(p.onCompact).toBe('reseed')
  })

  it('thread/start lleva el bloque en developerInstructions', async () => {
    const memory = block()
    await h.open({}, {}, { memory })
    const start = h.calls('thread/start')[0]
    const params = (start?.params ?? {}) as { developerInstructions?: string }
    expect(params.developerInstructions).toBe(memory)
  })

  it('sin memoria, thread/start no cambia', async () => {
    await h.open()
    const start = h.calls('thread/start')[0]
    expect(Object.keys(start?.params as object)).not.toContain('developerInstructions')
  })

  it('rechaza una memoria mal formada sin abrir el hilo', async () => {
    const p = h.provider()
    await expect(p.open({ cwd: '.', memory: 'obedece' })).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    })
  })
})
