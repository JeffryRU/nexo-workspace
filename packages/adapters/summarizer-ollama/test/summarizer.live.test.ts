import { sampleObserveRequest, sampleReflectRequest } from '@nexo/testkit'
import { describe, expect, it } from 'vitest'
import { DEFAULT_OLLAMA_URL, OllamaSummarizer } from '../src/index.ts'

/**
 * Prueba real contra un Ollama en marcha: solo con `NEXO_LIVE_MEMORY_OLLAMA=1` (modelo en
 * `NEXO_LIVE_MEMORY_OLLAMA_MODEL`, por omisión `llama3.2:3b`; URL en `NEXO_OLLAMA_URL`). No corre en el CI ni en
 * `pnpm check`: `NEXO_LIVE_MEMORY_OLLAMA=1 pnpm --filter @nexo/adapter-summarizer-ollama test:live`.
 */
const live = process.env.NEXO_LIVE_MEMORY_OLLAMA === '1'

describe.skipIf(!live)('resumidor Ollama (real)', () => {
  const summarizer = new OllamaSummarizer({
    model: process.env.NEXO_LIVE_MEMORY_OLLAMA_MODEL ?? 'llama3.2:3b',
    baseUrl: process.env.NEXO_OLLAMA_URL ?? DEFAULT_OLLAMA_URL,
  })

  it('observa y reflexiona con un modelo local', async () => {
    expect(await summarizer.isAvailable()).toBe(true)
    const observed = await summarizer.summarize(sampleObserveRequest())
    expect(observed.kind).toBe('observe')
    const reflected = await summarizer.summarize(sampleReflectRequest())
    expect(reflected.kind).toBe('reflect')
    if (reflected.kind === 'reflect') expect(reflected.text.trim().length).toBeGreaterThan(0)
  })
})
