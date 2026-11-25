import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PaneId, TabId } from '@nexo/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { type ClientState, type NexoClient, NexoClientError } from '../index.ts'
import { connectToDaemon } from './connect.ts'
import { discoverDaemon, ensureDaemon } from './discovery.ts'

const MAIN = fileURLToPath(new URL('../../../../apps/daemon/src/main.ts', import.meta.url))

const children: ChildProcess[] = []
const clients: NexoClient[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const child of children.splice(0)) child.kill()
  await new Promise((r) => setTimeout(r, 100))
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true, maxRetries: 5 })
})

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nexo-int-'))
  dirs.push(dir)
  return dir
}

/** Arranca el daemon real como proceso hijo, en puerto efímero y con el directorio de estado dado. */
function startDaemon(dir: string): ChildProcess {
  const child = spawn(process.execPath, [MAIN], {
    env: { ...process.env, NEXO_PORT: '0', NEXO_STATE_DIR: dir, NEXO_LOG_LEVEL: 'error' },
    stdio: 'ignore',
    windowsHide: true,
  })
  children.push(child)
  return child
}

function waitFor<T>(
  check: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 20_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const end = Date.now() + timeoutMs
    const tryOnce = async () => {
      const value = await check()
      if (value !== undefined) return resolve(value)
      if (Date.now() > end) return reject(new Error('tiempo agotado'))
      setTimeout(() => void tryOnce(), 50)
    }
    void tryOnce()
  })
}

describe('cliente contra el daemon real', () => {
  it('descubre, conecta, opera, detecta la caída y reconecta al reiniciar', async () => {
    const dir = await stateDir()
    let child: ChildProcess | undefined
    const location = await ensureDaemon({
      stateDir: dir,
      start: () => {
        child = startDaemon(dir)
      },
    })
    expect(location.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/$/)
    expect((await discoverDaemon({ stateDir: dir })).pid).toBeGreaterThan(0)

    const client = await connectToDaemon({
      discovery: { stateDir: dir },
      client: { reconnect: { baseMs: 50, maxMs: 300 }, autoResync: true },
    })
    clients.push(client)
    const states: ClientState[] = []
    client.on('state', (s) => states.push(s))
    const resyncs: string[] = []
    client.on('resync', (i) => resyncs.push(i.reason))

    await client.subscribe()
    const info = await client.call('daemon.info', {})
    expect(info.protocol).toBe(1)

    const { workspace } = await client.call('workspace.create', { name: 'int' })
    const { tab } = await client.call('tab.create', { workspaceId: workspace.id })
    const paneId = tab.panes[0]?.id
    expect(paneId).toBeDefined()
    let output = ''
    client.on('terminal.output', (d) => {
      output += d.data
    })
    await client.call('terminal.spawn', {
      paneId: paneId as PaneId,
      cmd: process.execPath,
      args: ['-e', 'console.log("HOLA-" + (40 + 2)); setInterval(() => {}, 1000)'],
      cols: 80,
      rows: 24,
    })
    await waitFor(() => (output.includes('HOLA-42') ? true : undefined))

    // Un método que falla en el daemon llega como error tipado.
    const bad = await client
      .call('tab.close', { tabId: 'no-existe' as TabId })
      .catch((e: unknown) => e)
    expect(bad).toBeInstanceOf(NexoClientError)

    // Se mata el daemon: la conexión cae y las llamadas fallan con DISCONNECTED.
    child?.kill('SIGKILL')
    await waitFor(() => (client.state === 'reconnecting' ? true : undefined))
    await expect(client.call('daemon.info', {})).rejects.toMatchObject({ code: 'DISCONNECTED' })

    // Se reinicia: el cliente redescubre (nuevo puerto y token), re-suscribe y avisa con resync.
    startDaemon(dir)
    await waitFor(() => (client.state === 'open' ? true : undefined))
    expect(resyncs).toContain('reconnect')
    expect(states).toContain('reconnecting')
    const again = await client.call('daemon.info', {})
    expect(again.pid).not.toBe(info.pid)
    expect((await client.call('workspace.list', {})).workspaces).toEqual([])
    // La suscripción se restauró: un espacio nuevo se anuncia.
    const changed = new Promise<string>((resolve) => {
      client.on('workspace.changed', (d) => resolve('workspace' in d ? d.workspace.name : 'otro'))
    })
    await client.call('workspace.create', { name: 'tras-reinicio' })
    expect(await changed).toBe('tras-reinicio')
  })

  it('autentica también por mensaje auth y rechaza un token incorrecto', async () => {
    const dir = await stateDir()
    startDaemon(dir)
    const location = await waitFor(async () =>
      discoverDaemon({ stateDir: dir }).catch(() => undefined),
    )
    const viaMessage = await connectToDaemon({ discovery: { stateDir: dir }, auth: 'message' })
    clients.push(viaMessage)
    expect((await viaMessage.call('daemon.info', {})).protocol).toBe(1)

    const { webSocketTransport, NexoClient: Client } = await import('../index.ts')
    const wrong = new Client({
      reconnect: false,
      transport: () => webSocketTransport({ url: location.url, token: 'x'.repeat(43) }),
    })
    await expect(wrong.connect()).rejects.toBeInstanceOf(NexoClientError)
    const wrongMsg = new Client({
      reconnect: false,
      transport: () =>
        webSocketTransport({ url: location.url, token: 'y'.repeat(43), auth: 'message' }),
    })
    await expect(wrongMsg.connect()).rejects.toBeInstanceOf(NexoClientError)
  })

  it('close() es definitivo: no reconecta aunque el daemon siga vivo', async () => {
    const dir = await stateDir()
    startDaemon(dir)
    await waitFor(async () => discoverDaemon({ stateDir: dir }).catch(() => undefined))
    const client = await connectToDaemon({ discovery: { stateDir: dir } })
    client.close()
    expect(client.state).toBe('closed')
    await new Promise((r) => setTimeout(r, 600))
    expect(client.state).toBe('closed')
  })
})
