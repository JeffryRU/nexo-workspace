import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { NexoClient, NexoClientError, webSocketTransport } from '@nexo/client'
import { LIMITS } from '@nexo/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { startTestDaemon, type TestDaemon } from './test-helpers.ts'

const daemons: TestDaemon[] = []
const clients: NexoClient[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const c of clients.splice(0)) c.close()
  for (const d of daemons.splice(0)) await d.cleanup()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function boot() {
  const daemon = await startTestDaemon({ agentProviders: [] })
  daemons.push(daemon)
  const client = new NexoClient({
    transport: () =>
      webSocketTransport({ url: `ws://127.0.0.1:${daemon.port}/`, token: daemon.token }),
  })
  clients.push(client)
  await client.connect()
  return client
}

function project(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'nexo-fsd-')))
  dirs.push(base)
  const root = join(base, 'proyecto')
  mkdirSync(join(root, '.ssh'), { recursive: true })
  writeFileSync(join(root, 'LEEME.md'), '# Proyecto\n\nHola ñandú')
  writeFileSync(join(root, '.ssh', 'id_rsa'), 'clave')
  writeFileSync(join(root, '.env'), 'TOKEN=x')
  writeFileSync(join(base, 'fuera.txt'), 'no debe verse')
  writeFileSync(
    join(root, 'foto.png'),
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 8, 9]),
  )
  return root
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    if (e instanceof NexoClientError) return e.code
    throw e
  }
  return 'OK'
}

describe('fs.* en el daemon', () => {
  it('lee dentro de un espacio de trabajo y rechaza lo demás', async () => {
    const client = await boot()
    const root = project()
    await client.call('workspace.create', { name: 'p', cwd: root })

    const st = await client.call('fs.stat', { path: join(root, 'LEEME.md') })
    expect(st).toMatchObject({ kind: 'file', type: 'markdown', mime: 'text/markdown' })
    const r = await client.call('fs.read', { path: join(root, 'LEEME.md') })
    expect(r).toMatchObject({ data: '# Proyecto\n\nHola ñandú', encoding: 'utf8', eof: true })
    const img = await client.call('fs.read', { path: join(root, 'foto.png') })
    expect([img.type, img.encoding]).toEqual(['png', 'base64'])
    expect([...Buffer.from(img.data, 'base64').subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect((await client.call('fs.stat', { path: root })).kind).toBe('directory')

    expect(await code(client.call('fs.read', { path: join(root, '.ssh', 'id_rsa') }))).toBe(
      'FORBIDDEN',
    )
    expect(await code(client.call('fs.read', { path: join(root, '.env') }))).toBe('FORBIDDEN')
    expect(await code(client.call('fs.read', { path: `${root}${sep}..${sep}fuera.txt` }))).toBe(
      'INVALID_PARAMS',
    )
    expect(await code(client.call('fs.read', { path: join(root, '..', 'fuera.txt') }))).toBe(
      'FORBIDDEN',
    )
    expect(await code(client.call('fs.read', { path: join(root, 'nada.md') }))).toBe('NOT_FOUND')
    expect(await code(client.call('fs.read', { path: 'relativa.md' }))).toBe('INVALID_PARAMS')
  })

  it('las raíces siguen a los espacios abiertos: cerrar el espacio revoca el acceso', async () => {
    const client = await boot()
    const root = project()
    expect(await code(client.call('fs.stat', { path: join(root, 'LEEME.md') }))).toBe('FORBIDDEN')
    const { workspace } = await client.call('workspace.create', { name: 'p', cwd: root })
    expect(await code(client.call('fs.stat', { path: join(root, 'LEEME.md') }))).toBe('OK')
    await client.call('workspace.close', { workspaceId: workspace.id })
    expect(await code(client.call('fs.stat', { path: join(root, 'LEEME.md') }))).toBe('FORBIDDEN')
  })

  it('un espacio sin carpeta no abre nada', async () => {
    const client = await boot()
    const root = project()
    await client.call('workspace.create', { name: 'sin carpeta' })
    expect(await code(client.call('fs.stat', { path: join(root, 'LEEME.md') }))).toBe('FORBIDDEN')
  })

  it('un archivo grande se lee por trozos y cada respuesta cabe en un mensaje', async () => {
    const client = await boot()
    const root = project()
    const size = 3 * LIMITS.maxFsChunkBytes + 123
    writeFileSync(join(root, 'grande.bin'), new Uint8Array(size).fill(7))
    await client.call('workspace.create', { name: 'p', cwd: root })
    const path = join(root, 'grande.bin')
    const first = await client.call('fs.stat', { path })
    let offset = 0
    let total = 0
    for (let i = 0; i < 10; i++) {
      const r = await client.call('fs.read', {
        path,
        offset,
        length: LIMITS.maxFsChunkBytes,
        expectMtimeMs: first.mtimeMs,
      })
      total += Buffer.from(r.data, 'base64').length
      offset += r.length
      if (r.eof) break
    }
    expect(total).toBe(size)
  })

  it('un archivo por encima del tope responde PAYLOAD_TOO_LARGE', async () => {
    const client = await boot()
    const root = project()
    writeFileSync(join(root, 'enorme.txt'), new Uint8Array(LIMITS.maxFsTextBytes + 1).fill(0x61))
    await client.call('workspace.create', { name: 'p', cwd: root })
    expect(await code(client.call('fs.read', { path: join(root, 'enorme.txt') }))).toBe(
      'PAYLOAD_TOO_LARGE',
    )
  })

  it('un panel viewer apunta a un archivo que luego se lee por fs.read', async () => {
    const client = await boot()
    const root = project()
    const { workspace } = await client.call('workspace.create', { name: 'p', cwd: root })
    const { tab } = await client.call('tab.create', { workspaceId: workspace.id })
    const first = tab.panes[0]
    if (first === undefined) throw new Error('sin panel')
    const { pane } = await client.call('pane.split', {
      paneId: first.id,
      direction: 'row',
      kind: 'viewer',
      path: join(root, 'LEEME.md'),
    })
    expect(pane).toMatchObject({ kind: 'viewer', title: 'LEEME.md' })
    const { workspaces } = await client.call('snapshot', {})
    expect(workspaces[0]?.tabs[0]?.panes.find((p) => p.id === pane.id)?.viewerPath).toBe(
      join(root, 'LEEME.md'),
    )
    const { pane: moved } = await client.call('viewer.open', {
      paneId: pane.id,
      path: join(root, 'foto.png'),
    })
    expect(moved.title).toBe('foto.png')
  })
})
