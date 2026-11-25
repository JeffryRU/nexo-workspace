import type { ProviderEvent } from '@nexo/contracts'
import { runAgentProviderConformance } from '@nexo/testkit/conformance'
import { describe, expect, it } from 'vitest'
import { ScriptedAgentProvider } from './adapters/scripted-agent-provider.ts'

runAgentProviderConformance('ScriptedAgentProvider', () => ({
  provider: new ScriptedAgentProvider({ chunkMs: 1 }),
  open: { cwd: '/work', permissionMode: 'ask' },
  prompts: { simple: 'hola', long: 'largo', permission: 'permiso' },
}))

async function collect(text: string, chunkMs = 1) {
  const provider = new ScriptedAgentProvider({ chunkMs })
  const session = await provider.open({ cwd: '/w' })
  const events: ProviderEvent[] = []
  session.onEvent((e) => events.push(e))
  await session.send(text)
  for (let i = 0; i < 400 && !events.some((e) => e.type === 'turn-end'); i++) {
    await new Promise((r) => setTimeout(r, 5))
  }
  return { events, session, provider }
}

describe('ScriptedAgentProvider', () => {
  it('responde con eco', async () => {
    const { events } = await collect('hola')
    expect(events.find((e) => e.type === 'block-end')).toMatchObject({
      block: { text: 'Eco: hola' },
    })
  })

  it('editar emite una acción edit con diff unificado', async () => {
    const { events } = await collect('editar')
    const end = events.find((e) => e.type === 'block-end' && e.block?.type === 'action')
    expect(end).toMatchObject({
      block: { kind: 'edit', status: 'ok', diff: { path: 'src/app.ts' } },
    })
    const patch = (end as { block: { diff: { patch: string } } }).block.diff.patch
    expect(patch).toContain('@@ -1,4 +1,4 @@')
    expect(patch).toContain('+const port = 4317')
  })

  it('ansi emite una acción exec con salida coloreada', async () => {
    const { events } = await collect('ansi')
    const end = events.find((e) => e.type === 'block-end' && e.block?.type === 'action')
    expect(end).toMatchObject({ block: { kind: 'exec', status: 'ok', exitCode: 0 } })
    expect((end as { block: { output: string } }).block.output).toContain('\u001b[31m')
  })

  it('bloques n emite n bloques de texto completos y se acota', async () => {
    const { events } = await collect('bloques 250')
    expect(events.filter((e) => e.type === 'block-end')).toHaveLength(250)
    const huge = await collect('bloques 99999999')
    expect(huge.events.filter((e) => e.type === 'block-end')).toHaveLength(9000)
  })

  it('lento n emite n trozos', async () => {
    const { events } = await collect('lento 7')
    expect(events.filter((e) => e.type === 'block-delta')).toHaveLength(7)
  })

  it('lento con un número hostil se acota', async () => {
    const { events, session } = await collect('lento -5')
    expect(events.filter((e) => e.type === 'block-delta').length).toBeGreaterThanOrEqual(1)
    await session.close()
  })

  it('rechazar el permiso deja la acción en error', async () => {
    const provider = new ScriptedAgentProvider()
    const session = await provider.open({ cwd: '/w' })
    const events: ProviderEvent[] = []
    session.onEvent((e) => events.push(e))
    await session.send('permiso')
    await new Promise((r) => setTimeout(r, 10))
    await session.respond({ type: 'permission', requestId: 'req-1', optionId: 'deny' })
    await new Promise((r) => setTimeout(r, 20))
    expect(events.find((e) => e.type === 'block-end')).toMatchObject({
      block: { status: 'error' },
    })
  })

  it('no reanuda sesiones desconocidas ni acepta modelos no declarados', async () => {
    const provider = new ScriptedAgentProvider()
    await expect(provider.open({ cwd: '/w', resume: 'nope' })).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    })
    await expect(provider.open({ cwd: '/w', model: 'otro' })).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    })
    const s = await provider.open({ cwd: '/w' })
    const again = await provider.open({ cwd: '/w', resume: s.providerSessionId })
    expect(again.providerSessionId).toBe(s.providerSessionId)
  })
})
