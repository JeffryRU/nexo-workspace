import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { companionApi, NexoClient, NexoClientError, webSocketTransport } from '@nexo/client'
import { AgentSessionId, type CompanionStateView } from '@nexo/contracts'
import { encodeUtf8, tinyCompanion } from '@nexo/testkit'
import { afterEach, describe, expect, it } from 'vitest'
import { startTestDaemon, type TestDaemon } from './test-helpers.ts'

const daemons: TestDaemon[] = []
const clients: NexoClient[] = []

afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const d of daemons.splice(0)) await d.cleanup()
})

async function until(check: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 5000
  while (!check()) {
    if (Date.now() > end) throw new Error(`tiempo agotado: ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function install(stateDir: string, id: string, files = tinyCompanion({ id })) {
  for (const [rel, bytes] of Object.entries(files)) {
    const target = join(stateDir, 'companions', id, ...rel.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
  }
}

async function connect(daemon: TestDaemon) {
  const client = new NexoClient({
    transport: () =>
      webSocketTransport({ url: `ws://127.0.0.1:${daemon.port}/`, token: daemon.token }),
  })
  clients.push(client)
  await client.connect()
  await client.subscribe(['companion.state'])
  return { client, api: companionApi(client) }
}

const status = (sessionId: string, st: 'working' | 'needs-input' | 'done' | 'idle') =>
  ({
    event: 'agent.status',
    data: { sessionId: AgentSessionId.parse(sessionId), status: st, updatedAt: 1 },
  }) as const

const FAST = {
  minShowMs: { idle: 0, done: 20, thinking: 20, busy: 20, error: 20, waiting: 20 },
  doneHoldMs: 60,
} as const

describe('companion.* en el daemon', () => {
  it('sin mascota por omisión y sin carpeta de paquetes', async () => {
    const daemon = await startTestDaemon({ companionTiming: FAST })
    daemons.push(daemon)
    const { api } = await connect(daemon)
    expect(await api.list()).toEqual({ companions: [], invalid: [], selected: null })
    expect(await api.state()).toMatchObject({ state: 'idle', selected: null })
  })

  it('lista, describe, sirve recursos, elige y persiste entre reinicios', async () => {
    const daemon = await startTestDaemon({ companionTiming: FAST })
    daemons.push(daemon)
    await install(daemon.stateDir, 'tiny')
    await install(daemon.stateDir, 'roto', { 'companion.json': encodeUtf8('{') })
    const { api } = await connect(daemon)

    const list = await api.list()
    expect(list.companions.map((c) => c.id)).toEqual(['tiny'])
    expect(list.invalid.map((i) => i.id)).toEqual(['roto'])
    const { companion } = await api.get({ id: 'tiny' })
    expect(companion.manifest.states.idle.src).toBe('idle.png')
    const asset = await api.asset({ id: 'tiny', path: 'idle.png' })
    expect(asset.mime).toBe('image/png')
    expect(Buffer.from(asset.data, 'base64').length).toBe(asset.bytes)
    expect(Buffer.from(asset.data, 'base64').subarray(1, 4).toString()).toBe('PNG')

    expect(await api.select({ id: 'tiny' })).toEqual({ selected: 'tiny' })
    expect(
      JSON.parse(await readFile(join(daemon.stateDir, 'companion-settings.json'), 'utf8')),
    ).toEqual({
      version: 1,
      selected: 'tiny',
    })

    // Reinicio con el mismo directorio de estado: la elección sigue.
    await daemon.stop()
    daemons.pop()
    const again = await startTestDaemon({ stateDir: daemon.stateDir, companionTiming: FAST })
    daemons.push(again)
    const second = await connect(again)
    expect(await second.api.state()).toMatchObject({ selected: 'tiny' })
    expect(await second.api.select({ id: null })).toEqual({ selected: null })
  })

  it('errores tipados: desconocido, roto, recurso no declarado y parámetros inválidos', async () => {
    const daemon = await startTestDaemon({ companionTiming: FAST })
    daemons.push(daemon)
    await install(daemon.stateDir, 'tiny')
    await install(daemon.stateDir, 'roto', { 'companion.json': encodeUtf8('{') })
    const { client, api } = await connect(daemon)
    await expect(api.get({ id: 'nada' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(api.select({ id: 'nada' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(api.select({ id: 'roto' })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    await expect(api.asset({ id: 'tiny', path: 'companion.json' })).rejects.toBeInstanceOf(
      NexoClientError,
    )
    await expect(api.asset({ id: 'tiny', path: '../roto/companion.json' })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    })
    await expect(
      client.call('companion.select', { id: 'tiny', x: 1 } as never),
    ).rejects.toBeInstanceOf(NexoClientError)
    expect((await api.state()).selected).toBeNull()
  })

  it('el estado sigue a los agentes y se avisa por companion.state', async () => {
    const daemon = await startTestDaemon({ companionTiming: FAST })
    daemons.push(daemon)
    await install(daemon.stateDir, 'tiny')
    const { api } = await connect(daemon)
    const got: CompanionStateView[] = []
    api.onState((s) => got.push(s))
    await api.select({ id: 'tiny' })
    daemon.bus.publish(status('s1', 'working'))
    await until(() => got.some((s) => s.state === 'thinking'), 'thinking')
    daemon.bus.publish(status('s1', 'needs-input'))
    await until(() => got.some((s) => s.state === 'waiting'), 'waiting')
    daemon.bus.publish(status('s1', 'done'))
    await until(() => got.some((s) => s.state === 'done'), 'done')
    await until(() => got.at(-1)?.state === 'idle', 'vuelve a idle')
    expect(got.every((s) => s.selected === 'tiny')).toBe(true)
    expect(got.map((s) => s.state)).toEqual(['idle', 'thinking', 'waiting', 'done', 'idle'])
  })

  it('un companion-settings.json corrupto o de otra versión arranca sin mascota', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'nexo-companion-state-'))
    await writeFile(join(stateDir, 'companion-settings.json'), '{"version":9,"selected":"tiny"}')
    const daemon = await startTestDaemon({ stateDir, companionTiming: FAST })
    daemons.push(daemon)
    const { api } = await connect(daemon)
    expect((await api.state()).selected).toBeNull()
  })
})
