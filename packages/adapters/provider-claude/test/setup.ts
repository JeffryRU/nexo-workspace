import type { ProviderEvent } from '@nexo/contracts'
import type { AgentProviderSession } from '@nexo/core'
import { afterEach } from 'vitest'
import { type ClaudeProviderOptions, createClaudeProvider } from '../src/provider.ts'
import { FakeTransport, tempDir } from './helpers.ts'

const dirs: { remove: () => void }[] = []
const sessions: AgentProviderSession[] = []

/** Registra la limpieza de las sesiones y carpetas que abre `setup` (llamar en el nivel del archivo). */
export function useCleanup(): void {
  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.close().catch(() => {})
    for (const d of dirs.splice(0)) d.remove()
  })
}

export async function setup(options: ClaudeProviderOptions = {}, transport = new FakeTransport()) {
  const dir = tempDir()
  dirs.push(dir)
  const provider = createClaudeProvider({
    transport,
    env: {},
    interruptTimeoutMs: 80,
    ...options,
  })
  const session = await provider.open({ cwd: dir.path })
  sessions.push(session)
  const events: ProviderEvent[] = []
  session.onEvent((e) => events.push(e))
  const fake = transport.last
  return { provider, session, events, fake, transport, dir }
}

export const wait = async (cond: () => boolean, ms = 3000) => {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('tiempo agotado')
    await new Promise((r) => setTimeout(r, 2))
  }
}
