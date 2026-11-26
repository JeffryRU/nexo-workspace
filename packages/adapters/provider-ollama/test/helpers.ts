import { ProviderEvent } from '@nexo/contracts'
import type { AgentProviderSession } from '@nexo/core'
import { afterAll, afterEach, beforeAll, expect } from 'vitest'
import { createOllamaProvider, type OllamaProviderOptions } from '../src/provider.ts'
import { defaultChat, FakeOllama } from './fake-ollama.ts'

export const wait = async (cond: () => boolean, ms = 4000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('tiempo agotado')
    await new Promise((r) => setTimeout(r, 3))
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Servidor falso por archivo de pruebas y sesiones cerradas al terminar cada prueba. */
export function useFake() {
  const fake = new FakeOllama()
  const sessions: AgentProviderSession[] = []
  beforeAll(async () => {
    await fake.start()
  })
  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.close().catch(() => {})
    fake.chatHandler = defaultChat
    fake.tagsHandler = undefined
    fake.models = ['llama3.2:latest', 'qwen3:8b']
    fake.calls.length = 0
    fake.aborted = 0
  })
  afterAll(() => fake.stop())

  async function open(
    options: OllamaProviderOptions = {},
    openOptions: { model?: string; effort?: string; memory?: string } = {},
  ) {
    const provider = createOllamaProvider({ baseUrl: fake.url, probeCacheMs: 0, ...options })
    const session = await provider.open({ cwd: '/tmp', ...openOptions })
    sessions.push(session)
    const events: ProviderEvent[] = []
    session.onEvent((e) => {
      // Todo evento que sale del adaptador debe cumplir el contrato.
      expect(ProviderEvent.safeParse(e).success, JSON.stringify(e).slice(0, 300)).toBe(true)
      events.push(e)
    })
    return { provider, session, events }
  }
  const turnEnds = (events: ProviderEvent[]) => events.filter((e) => e.type === 'turn-end')
  const errors = (events: ProviderEvent[]) =>
    events.flatMap((e) => (e.type === 'error' ? [e.error] : []))
  const textOf = (events: ProviderEvent[]) =>
    events.flatMap((e) => (e.type === 'block-delta' ? [e.text] : [])).join('')

  return { fake, open, turnEnds, errors, textOf }
}
