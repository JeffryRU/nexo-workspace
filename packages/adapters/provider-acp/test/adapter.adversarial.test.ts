import { LIMITS } from '@nexo/contracts'
import { AgentProviderError } from '@nexo/core'
import { describe, expect, it } from 'vitest'
import { useFakeAcp, wait } from './helpers.ts'

const h = useFakeAcp()

const reject = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  )

describe('ACP: salida hostil del agente', () => {
  it('actualizaciones fuera de esquema, JSON roto, sesiones ajenas y métodos desconocidos no rompen el turno', async () => {
    const { session, events } = await h.open()
    await session.send('basura')
    await wait(() => h.turnEnds(events).length === 1)
    expect(h.textOf(events)).toBe('sobreviví.')
    expect(h.textOf(events)).not.toContain('AJENO')
    expect(h.errors(events)).toEqual([])
    expect(h.logs.some((l) => /invalid-json|invalid-message/.test(l.message))).toBe(true)
    // La llamada sin título cae al nombre de la herramienta y el estado raro, a pendiente.
    const action = events.find((e) => e.type === 'block-start' && e.block.type === 'action')
    expect(action).toMatchObject({
      block: { type: 'action', kind: 'other', status: 'pending', callId: 'k1' },
    })
    await session.send('simple')
    await wait(() => h.turnEnds(events).length === 2)
  })

  it('un tool_call_update sin su tool_call crea la acción y la cierra', async () => {
    const { session, events } = await h.open()
    await session.send('huerfano')
    await wait(() => h.turnEnds(events).length === 1)
    const start = events.find((e) => e.type === 'block-start' && e.block.type === 'action')
    expect(start).toMatchObject({ block: { title: 'Sin alta', kind: 'read', callId: 'zz' } })
    const end = events.find((e) => e.type === 'block-end' && e.block?.type === 'action')
    expect(end).toMatchObject({ block: { status: 'ok' } })
    expect(h.textOf(events)).toBe('seguí.')
  })

  it('un permiso que llega después de cancelar se responde «cancelled» sin mostrarse', async () => {
    const { session, events } = await h.open()
    await session.send('latepermiso')
    await session.interrupt()
    await wait(() => h.turnEnds(events).length === 1)
    await wait(() => h.readLog().some((l) => l.lateReply !== undefined))
    expect(h.readLog().find((l) => l.lateReply !== undefined)?.lateReply).toEqual({
      outcome: { outcome: 'cancelled' },
    })
    expect(events.some((e) => e.type === 'permission-request')).toBe(false)
  })

  it('un agente que muere a mitad de turno: error fatal con el final de stderr redactado, exit y nada más', async () => {
    const { session, events } = await h.open()
    await session.send('morir')
    await wait(() => events.some((e) => e.type === 'exit'))
    const error = h.errors(events)[0]
    expect(error).toMatchObject({ code: 'ACP_EXITED', fatal: true })
    expect(error?.message).toMatch(/código 3/)
    expect(error?.message).toContain('fallo fatal')
    expect(error?.message).not.toContain('abcdefghijklmnop1234')
    expect(events.filter((e) => e.type === 'turn-end')).toHaveLength(0)
    expect(events.at(-1)).toMatchObject({ type: 'exit', exitCode: 3 })
    const after = await reject(session.send('simple'))
    expect((after as AgentProviderError).code).toBe('CLOSED')
  })

  it('un agente que muere en initialize: no disponible, sin colgarse', async () => {
    const p = h.provider({ FAKE_ACP_DIE: 'init' })
    expect(await p.isAvailable()).toBe(false)
    expect(p.unavailableReason?.()).toMatch(/terminó/)
    const error = await reject(p.open({ cwd: h.dir() }))
    expect((error as AgentProviderError).code).toBe('UNAVAILABLE')
  })

  it('un agente que no responde a initialize: no disponible al agotar el plazo', async () => {
    const p = h.provider({ FAKE_ACP_HANG: 'init' }, { probeTimeoutMs: 300 })
    expect(await p.isAvailable()).toBe(false)
    expect(p.unavailableReason?.()).toMatch(/no respondió/)
  })

  it('una línea que supera el tope se descarta y el turno sigue', async () => {
    const { session, events } = await h.open({ FAKE_ACP_BIG: '100000' }, { maxLineLength: 50_000 })
    await session.send('grande')
    await wait(() => h.turnEnds(events).length === 1)
    expect(h.textOf(events)).toBe('después de la línea enorme')
    expect(h.logs.some((l) => /line-too-large/.test(l.message))).toBe(true)
  })

  it('un texto enorme llega en deltas que respetan el tope', async () => {
    const { session, events } = await h.open({ FAKE_ACP_BIG: String(3 * 1024 * 1024) })
    await session.send('grande')
    await wait(() => h.turnEnds(events).length === 1, 20_000)
    for (const e of events) {
      if (e.type === 'block-delta') {
        expect(new TextEncoder().encode(e.text).length).toBeLessThanOrEqual(LIMITS.maxDeltaBytes)
      }
    }
  })

  it('stderr ruidoso no inunda el log, no filtra secretos y no afecta al turno', async () => {
    const { session, events } = await h.open({ FAKE_ACP_STDERR: '1' })
    await session.send('simple')
    await wait(() => h.turnEnds(events).length === 1)
    const stderrLines = h.logs.filter((l) => l.message.startsWith('stderr:'))
    // 100 líneas como mucho por proceso (el de la comprobación y el de la sesión).
    expect(stderrLines.length).toBeLessThanOrEqual(200)
    for (const l of h.logs) expect(l.message).not.toContain('sk-abcdefghijklmnop')
  })

  it('una versión incompatible del protocolo impide abrir y lo dice', async () => {
    const error = await reject(h.provider({ FAKE_ACP_VERSION: '2' }).open({ cwd: h.dir() }))
    expect(error).toBeInstanceOf(AgentProviderError)
    expect((error as AgentProviderError).code).toBe('UNAVAILABLE')
    expect((error as AgentProviderError).message).toMatch(/versión 2/)
  })

  it('el agente no responde a session/cancel: el turno se cierra solo como interrumpido', async () => {
    const { session, events } = await h.open(
      { FAKE_ACP_HANG_ON_CANCEL: '1' },
      { limits: { interruptGraceMs: 200 } },
    )
    await session.send('long')
    await wait(() => events.some((e) => e.type === 'block-delta'))
    await session.interrupt()
    expect(h.turnEnds(events)).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'turn-end', stopReason: 'interrupted' })
    await session.send('simple')
    await wait(() => h.turnEnds(events).length === 2)
  })

  it('un turno sin señales del agente se corta por inactividad con un error reintentable', async () => {
    const { session, events } = await h.open({}, { limits: { idleTimeoutMs: 200 } })
    await session.send('hang')
    await wait(() => h.turnEnds(events).length === 1)
    expect(h.errors(events)[0]).toMatchObject({ code: 'TIMEOUT', retryable: true })
    expect(events.at(-1)).toMatchObject({ stopReason: 'error' })
    await wait(() => h.calls('session/cancel').length === 1)
  })

  it('actualizaciones del turno que llegan después de su respuesta se ignoran', async () => {
    const { session, events } = await h.open()
    await session.send('tarde')
    await wait(() => h.turnEnds(events).length === 1)
    await new Promise((r) => setTimeout(r, 80))
    expect(h.textOf(events)).toBe('fin')
  })

  it('una respuesta a una solicitud o a una pregunta desconocidas se rechaza sin tocar al agente', async () => {
    const { session } = await h.open()
    const unknown = await reject(
      session.respond({ type: 'permission', requestId: 'req-9', optionId: 'x' }),
    )
    expect((unknown as AgentProviderError).code).toBe('UNKNOWN_REQUEST')
    const question = await reject(
      session.respond({ type: 'question', requestId: 'q', answers: [] } as never),
    )
    expect((question as AgentProviderError).code).toBe('UNKNOWN_REQUEST')
  })
})
