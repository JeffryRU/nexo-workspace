import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentNewOutput,
  MemoryListOutput,
  MemoryRecallOutput,
  MemorySearchOutput,
  MemoryStatusOutput,
} from './schemas.ts'
import { Sandbox, waitUntil } from './test-helpers.ts'

let sandbox: Sandbox | undefined
const dirs: string[] = []
afterEach(async () => {
  await sandbox?.cleanup()
  sandbox = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const MEMORY_ON = {
  NEXO_AGENT_PROVIDERS: 'fake',
  NEXO_MEMORY: 'on',
  NEXO_MEMORY_SUMMARIZER: 'fake',
  NEXO_MEMORY_OBSERVER_TOKENS: '500',
  NEXO_MEMORY_REFLECTOR_TOKENS: '20000',
}

describe('nexo memory contra el daemon real (proveedor y resumidor falsos)', () => {
  it('con la memoria activada, una sesión genera observaciones que se ven con nexo memory ls', async () => {
    const sb = await Sandbox.create()
    sandbox = sb
    await sb.startDaemon(MEMORY_ON)
    const cwd = mkdtempSync(join(tmpdir(), 'nexo-cli-mem-'))
    dirs.push(cwd)

    const status0 = MemoryStatusOutput.parse(await sb.json(['memory', 'status', '--cwd', cwd]))
    expect(status0).toMatchObject({
      enabled: true,
      summarizer: 'fake',
      thresholds: { observerBatchTokens: 500, reflectorTokens: 20000 },
    })
    expect(status0.pausedReason).toBeUndefined()

    const created = AgentNewOutput.parse(
      await sb.json(['agent', 'new', '--provider', 'fake', '--cwd', cwd, '--name', 'mem']),
    )
    const id = created.sessionId
    await sb.json(['agent', 'send', id, `Usemos pnpm en este proyecto. ${'detalle '.repeat(400)}`])

    const listed = await waitUntil(async () => {
      const r = MemoryListOutput.parse(await sb.json(['memory', 'ls', '--cwd', cwd]))
      return r.observations.length > 0 ? r : undefined
    })
    expect(listed.observations[0]).toMatchObject({ sessionId: id, scope: 'project' })

    // texto legible
    const text = await sb.nexo(['memory', 'ls', '--cwd', cwd])
    expect(text.code).toBe(0)
    expect(text.stdout).toContain('[media] [proyecto]')
    expect(text.stdout).toContain('Observado:')

    const status = MemoryStatusOutput.parse(await sb.json(['memory', 'status', '--cwd', cwd]))
    expect(status.usage.calls).toBeGreaterThan(0)
    expect(status.project?.observations).toBeGreaterThanOrEqual(listed.observations.length)

    const found = MemorySearchOutput.parse(
      await sb.json(['memory', 'search', '--cwd', cwd, 'observado']),
    )
    expect(found.observations.length).toBeGreaterThan(0)

    const first = listed.observations[0]
    if (first === undefined) throw new Error('sin observación')
    const recalled = MemoryRecallOutput.parse(
      await sb.json(['memory', 'recall', id.slice(0, 14), `${first.range.from}-${first.range.to}`]),
    )
    expect(recalled.blocks.length).toBeGreaterThan(0)
    const recallText = await sb.nexo(['memory', 'recall', id, String(first.range.from)])
    expect(recallText.code).toBe(0)
    expect(recallText.stdout).toContain('Usemos pnpm')

    // errores: sesión inexistente (2) y rango inválido (1)
    expect((await sb.nexo(['memory', 'recall', 'nadie', '0'])).code).toBe(2)
    expect((await sb.nexo(['memory', 'recall', id, '9-2'])).code).toBe(1)
  })

  it('apagada por omisión: status lo dice y ls no muestra nada', async () => {
    const sb = await Sandbox.create()
    sandbox = sb
    await sb.startDaemon({ NEXO_AGENT_PROVIDERS: 'fake' })
    const status = MemoryStatusOutput.parse(await sb.json(['memory', 'status']))
    expect(status.enabled).toBe(false)
    const text = await sb.nexo(['memory', 'status'])
    expect(text.stdout).toContain('apagada')
    const ls = await sb.nexo(['memory', 'ls'])
    expect(ls.code).toBe(0)
    expect(ls.stdout).toContain('No hay observaciones')
  })
})
