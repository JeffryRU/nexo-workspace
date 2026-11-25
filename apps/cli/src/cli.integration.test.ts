import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LsOutput, NewOutput, ReadOutput, SplitOutput } from './schemas.ts'
import { ECHO_SCRIPT, isAlive, Sandbox, waitUntil } from './test-helpers.ts'

let sandbox: Sandbox | undefined
afterEach(async () => {
  await sandbox?.cleanup()
  sandbox = undefined
})

async function fresh(): Promise<Sandbox> {
  sandbox = await Sandbox.create()
  return sandbox
}

async function readUntil(sb: Sandbox, pane: string, needle: string): Promise<string> {
  return waitUntil(async () => {
    const r = await sb.nexo(['read', pane, '--lines', '200'])
    return r.stdout.includes(needle) ? r.stdout : undefined
  })
}

describe('CLI contra un daemon real', () => {
  it('flujo completo: new, ls, send, read, split, kill, close y daemon stop', async () => {
    const sb = await fresh()
    await sb.startDaemon()

    const created = NewOutput.parse(
      await sb.json([
        'new',
        '--workspace',
        'integración',
        '--name',
        'eco',
        '--',
        'node',
        '-e',
        ECHO_SCRIPT,
      ]),
    )
    expect(created.createdWorkspace).toBe(true)
    const pane = created.paneId

    const tree = LsOutput.parse(await sb.json(['ls']))
    expect(tree.workspaces).toHaveLength(1)
    expect(tree.workspaces[0]).toMatchObject({ name: 'integración' })
    expect(tree.workspaces[0]?.tabs[0]).toMatchObject({ title: 'eco', active: true })
    expect(tree.workspaces[0]?.tabs[0]?.panes[0]).toMatchObject({
      id: pane,
      terminalId: created.terminalId,
    })
    const text = await sb.nexo(['ls'])
    expect(text.stdout).toContain('espacio ws-')
    expect(text.stdout).toContain('"')

    await readUntil(sb, pane, 'LISTO')
    const prefix = pane.slice(0, 13)
    expect((await sb.nexo(['send', prefix, '--enter', 'hola', 'mundo'])).code).toBe(0)
    const out = await readUntil(sb, pane, 'eco:"hola mundo')
    expect(out).not.toContain('\u001b')
    const raw = ReadOutput.parse(
      JSON.parse((await sb.nexo(['read', pane, '--raw', '--json'])).stdout),
    )
    expect(raw.raw).toBe(true)

    const split = SplitOutput.parse(
      await sb.json(['split', pane, '--right', '--', 'node', '-e', ECHO_SCRIPT]),
    )
    const two = LsOutput.parse(await sb.json(['ls']))
    expect(two.workspaces[0]?.tabs[0]?.panes.map((p) => p.id)).toEqual([pane, split.paneId])
    await readUntil(sb, split.paneId, 'LISTO')

    expect((await sb.nexo(['focus', pane])).code).toBe(0)
    expect((await sb.nexo(['rename', 'eco', 'renombrada'])).code).toBe(0)
    expect((await sb.nexo(['rename', 'integración', 'espacio nuevo'])).code).toBe(0)
    const renamed = LsOutput.parse(await sb.json(['ls']))
    expect(renamed.workspaces[0]?.name).toBe('espacio nuevo')
    expect(renamed.workspaces[0]?.tabs[0]?.title).toBe('renombrada')

    expect((await sb.nexo(['kill', split.paneId])).code).toBe(0)
    expect((await sb.nexo(['close', split.paneId])).code).toBe(0)
    expect((await sb.nexo(['close', 'renombrada'])).code).toBe(0)
    expect((await sb.nexo(['close', 'espacio nuevo'])).code).toBe(0)
    expect(LsOutput.parse(await sb.json(['ls'])).workspaces).toEqual([])

    const status = await sb.nexo(['daemon', 'status', '--json'])
    expect(status.code).toBe(0)
    expect(JSON.parse(status.stdout)).toMatchObject({ running: true })
    expect(status.stdout).not.toMatch(/token/i)
    const { pid } = await sb.waitDaemon()
    const stop = await sb.nexo(['daemon', 'stop'])
    expect(stop.code).toBe(0)
    expect(stop.stdout).toContain('detenido')
    await waitUntil(async () => !isAlive(pid) || undefined)
    expect((await sb.nexo(['ls', '--no-start'])).code).toBe(3)
    expect((await sb.nexo(['daemon', 'stop'])).stdout).toContain('ya estaba detenido')
  })

  it('el shell por omisión abre una terminal usable', async () => {
    const sb = await fresh()
    await sb.startDaemon()
    const created = NewOutput.parse(await sb.json(['new']))
    await sb.nexo(['send', created.paneId, '--enter', 'echo marca-nexo-123'])
    await readUntil(sb, created.paneId, 'marca-nexo-123')
  })

  it('kill termina el proceso y el panel sigue legible', async () => {
    const sb = await fresh()
    await sb.startDaemon()
    const created = NewOutput.parse(await sb.json(['new', '--', 'node', '-e', ECHO_SCRIPT]))
    await readUntil(sb, created.paneId, 'LISTO')
    expect((await sb.nexo(['kill', created.paneId])).code).toBe(0)
    expect((await sb.nexo(['read', created.paneId])).stdout).toContain('LISTO')
    const r = await sb.nexo(['send', created.paneId, 'x'])
    expect(r.code).toBe(4)
    expect(r.stderr).toMatch(/^nexo: /)
  })

  it('send --stdin trocea una entrada grande y read --follow la ve llegar', async () => {
    const sb = await fresh()
    await sb.startDaemon()
    const created = NewOutput.parse(await sb.json(['new', '--', 'node', '-e', ECHO_SCRIPT]))
    await readUntil(sb, created.paneId, 'LISTO')
    const follow = sb.spawnNexo(['read', created.paneId, '--follow'])
    let seen = ''
    follow.stdout?.on('data', (d: Buffer) => {
      seen += d.toString('utf8')
    })
    await waitUntil(async () => seen.includes('LISTO') || undefined)
    const r = await sb.nexo(['send', created.paneId, '--stdin', '--enter'], {
      input: `${'x'.repeat(150_000)}FIN`,
    })
    expect(r.code).toBe(0)
    await waitUntil(async () => seen.includes('FIN') || undefined)
    expect(seen).not.toContain('\u001b')
  })
})

describe('autoarranque', () => {
  it('arranca el daemon desacoplado, lo espera y sigue; el daemon sobrevive a la CLI', async () => {
    const sb = await fresh()
    const created = await sb.nexo(['new', '--json', '--', 'node', '-e', ECHO_SCRIPT], {
      env: { NEXO_LOG_LEVEL: 'info' },
    })
    expect(created.code, created.stderr).toBe(0)
    const { pid } = await sb.waitDaemon()
    expect(isAlive(pid)).toBe(true)
    expect((await readFile(join(sb.dir, 'daemon.log'), 'utf8')).length).toBeGreaterThan(0)
    const status = await sb.nexo(['daemon', 'status', '--no-start'])
    expect(status.code).toBe(0)
    expect(status.stdout).toContain(`pid:      ${pid}`)
    const log = await sb.nexo(['daemon', 'log', '-n', '5'])
    expect(log.code).toBe(0)
    expect(log.stdout).toContain('daemon escuchando')
    await sb.nexo(['daemon', 'stop'])
    await waitUntil(async () => !isAlive(pid) || undefined)
  })

  it('--no-start no arranca nada y sale 3', async () => {
    const sb = await fresh()
    const r = await sb.nexo(['ls', '--no-start'])
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('no está corriendo')
    await expect(readFile(join(sb.dir, 'daemon.json'))).rejects.toThrow()
  })

  it('dos CLI a la vez comparten un solo daemon', async () => {
    const sb = await fresh()
    const [a, b] = await Promise.all([
      sb.nexo(['new', '--json', '--', 'node', '-e', ECHO_SCRIPT]),
      sb.nexo(['new', '--json', '--', 'node', '-e', ECHO_SCRIPT]),
    ])
    expect(a.code, a.stderr).toBe(0)
    expect(b.code, b.stderr).toBe(0)
    const tree = LsOutput.parse(await sb.json(['ls']))
    expect(tree.workspaces.flatMap((w) => w.tabs)).toHaveLength(2)
  })
})
