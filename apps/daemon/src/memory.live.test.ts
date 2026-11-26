import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentApi, NexoClient, webSocketTransport } from '@nexo/client'
import { afterEach, describe, expect, it } from 'vitest'
import { startTestDaemon, type TestDaemon } from './test-helpers.ts'

/**
 * Pruebas reales de la memoria: solo con su variable, nunca en el CI ni en `pnpm check` (los archivos
 * `*.live.test.ts` están excluidos). Usan la cuenta del usuario, así que se lanzan a mano:
 *
 * - `NEXO_LIVE_MEMORY_OLLAMA=1` (modelo en `NEXO_LIVE_MEMORY_OLLAMA_MODEL`, por omisión `llama3.2:3b`; URL en
 *   `NEXO_OLLAMA_URL`): el resumidor Ollama dentro del daemon.
 * - `NEXO_LIVE_MEMORY_PROVIDER=<id>` (p. ej. `claude`; modelo opcional en `NEXO_LIVE_MEMORY_PROVIDER_MODEL`, p. ej.
 *   `haiku`): el resumidor «vía proveedor» con la sesión que el usuario ya tiene con ese CLI.
 *
 * `NEXO_LIVE_MEMORY_OLLAMA=1 pnpm --filter @nexo/daemon test:live` (o la otra variable).
 */
const ollama = process.env.NEXO_LIVE_MEMORY_OLLAMA === '1'
const providerId = process.env.NEXO_LIVE_MEMORY_PROVIDER

const daemons: TestDaemon[] = []
const clients: NexoClient[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const d of daemons.splice(0)) await d.cleanup()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function observe(options: Parameters<typeof startTestDaemon>[0]): Promise<void> {
  const daemon = await startTestDaemon({
    memory: {
      thresholds: { observerBatchTokens: 500, reflectorTokens: 20_000 },
      ...options?.memory,
    },
    ...options,
  })
  daemons.push(daemon)
  const client = new NexoClient({
    transport: () =>
      webSocketTransport({ url: `ws://127.0.0.1:${daemon.port}/`, token: daemon.token }),
  })
  clients.push(client)
  await client.connect()
  await client.subscribe()
  const cwd = mkdtempSync(join(tmpdir(), 'nexo-live-mem-'))
  dirs.push(cwd)
  const { workspace } = await client.call('workspace.create', { name: 'live', cwd })
  const { tab } = await client.call('tab.create', { workspaceId: workspace.id, cwd })
  const first = tab.panes[0]
  if (first === undefined) throw new Error('sin panel')
  const { pane } = await client.call('pane.split', {
    paneId: first.id,
    direction: 'row',
    kind: 'agent',
  })
  await client.call('pane.close', { paneId: first.id })
  const { session } = await client.call('agent.create', { paneId: pane.id, provider: 'fake', cwd })
  await agentApi(client).send({
    sessionId: session.id,
    text: `Decidimos usar pnpm y vitest en este proyecto; el puerto es 4317. ${'contexto '.repeat(400)}`,
  })
  const end = Date.now() + 240_000
  for (;;) {
    const r = await client.call('memory.list', { cwd })
    if (r.observations.length > 0) {
      expect(r.observations[0]?.text.trim().length).toBeGreaterThan(0)
      break
    }
    const status = await client.call('memory.status', { cwd })
    if (status.pausedReason !== undefined) throw new Error(`en pausa: ${status.pausedReason}`)
    if (Date.now() > end) throw new Error('sin observaciones en 240 s')
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

describe.skipIf(!ollama)('memoria con Ollama (real)', () => {
  it('el daemon observa una sesión con un modelo local', async () => {
    await observe({
      agentProviders: ['fake'],
      memory: {
        enabled: true,
        summarizer: {
          kind: 'ollama',
          model: process.env.NEXO_LIVE_MEMORY_OLLAMA_MODEL ?? 'llama3.2:3b',
        },
      },
    })
  }, 300_000)
})

describe.skipIf(providerId === undefined || providerId === '')(
  'memoria vía proveedor (real)',
  () => {
    it('el daemon observa una sesión con un turno de solo texto de un proveedor real', async () => {
      const id = providerId ?? ''
      const model = process.env.NEXO_LIVE_MEMORY_PROVIDER_MODEL
      await observe({
        agentProviders: ['fake', id],
        memory: {
          enabled: true,
          summarizer: { kind: 'provider', id, ...(model === undefined ? {} : { model }) },
        },
      })
    }, 300_000)
  },
)
