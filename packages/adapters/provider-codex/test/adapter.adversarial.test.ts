import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LIMITS } from '@nexo/contracts'
import { AgentProviderError } from '@nexo/core'
import { describe, expect, it } from 'vitest'
import { sleep, useFakeCodex, wait } from './helpers.ts'

const h = useFakeCodex()

const reject = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  )

describe('Codex: salida hostil del servidor', () => {
  it('JSON roto, objetos fuera de esquema, ids ajenos y métodos desconocidos no rompen el turno', async () => {
    const { session, events } = await h.open()
    await session.send('garbage')
    await wait(() => h.turnEnds(events).length === 1)
    expect(h.textOf(events)).toBe('ok')
    expect(h.turnEnds(events)).toHaveLength(1)
    expect(events.some((e) => e.type === 'error')).toBe(false)
    // Se registró lo anómalo, sin tirar la sesión.
    expect(h.logs.some((l) => /invalid-json|invalid-message/.test(l.message))).toBe(true)
    // La solicitud desconocida del servidor recibió «método no encontrado».
    await wait(() => h.received().some((m) => m.id === 'srv-x'))
    expect(h.received().find((m) => m.id === 'srv-x')).toMatchObject({ error: { code: -32601 } })
    await session.send('simple')
    await wait(() => h.turnEnds(events).length === 2)
  })

  it('una línea que supera el tope se descarta y el turno sigue', async () => {
    const { session, events } = await h.open(
      { FAKE_CODEX_BIG: '100000' },
      { maxLineLength: 50_000 },
    )
    await session.send('toolong')
    await wait(() => h.turnEnds(events).length === 1)
    expect(h.textOf(events)).toBe('sobrevivió')
    expect(h.logs.some((l) => /line-too-large/.test(l.message))).toBe(true)
  })

  it('una salida de comando enorme se recorta al tope del bloque y se marca truncada', async () => {
    const { session, events } = await h.open()
    await session.send('huge')
    await wait(() => h.turnEnds(events).length === 1, 20_000)
    const end = events.flatMap((e) =>
      e.type === 'block-end' && e.block?.type === 'action' ? [e.block] : [],
    )[0]
    expect(end?.truncated).toBe(true)
    expect(new TextEncoder().encode(end?.output ?? '').length).toBeLessThanOrEqual(
      LIMITS.maxBlockTextBytes,
    )
    for (const e of events) {
      if (e.type === 'block-delta') {
        expect(new TextEncoder().encode(e.text).length).toBeLessThanOrEqual(LIMITS.maxDeltaBytes)
      }
    }
  })

  it('ids con caracteres raros y texto con NUL o sustitutos sueltos se sanean', async () => {
    const { session, events } = await h.open()
    await session.send('weird')
    await wait(() => h.turnEnds(events).length === 1)
    expect(h.textOf(events)).toBe('ho�la 😀 fin')
  })

  it('un turno fallido: error de credenciales fatal en español y un turn-end de error', async () => {
    const { session, events } = await h.open()
    await session.send('fail')
    await wait(() => h.turnEnds(events).length === 1)
    const errors = h.errors(events)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'AUTH_REQUIRED', fatal: true })
    expect(errors[0]?.message).toMatch(/codex login/)
    expect(events.at(-1)).toMatchObject({ stopReason: 'error' })
  })

  it('stderr ruidoso no inunda el log ni afecta al turno', async () => {
    const { session, events } = await h.open()
    await session.send('noisy')
    await wait(() => h.turnEnds(events).length === 1)
    expect(h.textOf(events)).toBe('tras el ruido')
    expect(h.logs.filter((l) => l.message.startsWith('stderr:')).length).toBeLessThanOrEqual(100)
  })
})

describe('Codex: el proceso muere o se atasca', () => {
  it('si muere a mitad de turno: error fatal con el final de stderr redactado, exit, sin turn-end, y CLOSED', async () => {
    const { session, events } = await h.open()
    await session.send('die')
    await wait(() => events.some((e) => e.type === 'exit'))
    const errors = h.errors(events)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'CODEX_EXITED', fatal: true })
    expect(errors[0]?.message).toMatch(/código 3/)
    expect(errors[0]?.message).toContain('panic')
    expect(errors[0]?.message).not.toContain('sk-abcdefghijklmnop')
    expect(events.find((e) => e.type === 'exit')).toMatchObject({ exitCode: 3 })
    expect(h.turnEnds(events)).toHaveLength(0)
    expect(events.filter((e) => e.type === 'exit')).toHaveLength(1)
    expect(((await reject(session.send('x'))) as AgentProviderError).code).toBe('CLOSED')
    await session.close()
    expect(events.filter((e) => e.type === 'exit')).toHaveLength(1)
  })

  it('si Codex no contesta a la interrupción, el turno se cierra solo como interrupted', async () => {
    const { session, events } = await h.open(
      { FAKE_CODEX_HANG_ON_INTERRUPT: '1' },
      { limits: { interruptGraceMs: 100 } },
    )
    await session.send('long')
    await wait(() => h.textOf(events) !== '')
    await session.interrupt()
    expect(h.turnEnds(events)).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ stopReason: 'interrupted' })
    // El turno quedó libre.
    await session.send('simple')
    await wait(() => h.turnEnds(events).length === 2)
  })

  it('un turno sin actividad vence con un error TIMEOUT y un turn-end de error', async () => {
    const { session, events } = await h.open({}, { limits: { idleTimeoutMs: 150 } })
    await session.send('hang')
    await wait(() => h.turnEnds(events).length === 1)
    expect(h.errors(events)[0]).toMatchObject({ code: 'TIMEOUT', retryable: true })
    expect(events.at(-1)).toMatchObject({ stopReason: 'error' })
    await sleep(50)
    expect(h.calls('turn/interrupt')).toHaveLength(1)
  })

  it('una aprobación pendiente no consume el plazo de inactividad', async () => {
    const { session, events } = await h.open({}, { limits: { idleTimeoutMs: 150 } })
    await session.send('permiso')
    await wait(() => events.some((e) => e.type === 'permission-request'))
    await sleep(400)
    expect(h.turnEnds(events)).toHaveLength(0)
    const req = events.find((e) => e.type === 'permission-request')
    if (req?.type !== 'permission-request') throw new Error('sin solicitud')
    await session.respond({ type: 'permission', requestId: req.requestId, optionId: 'reject' })
    await wait(() => h.turnEnds(events).length === 1)
  })

  it('una aprobación que llega tras interrumpir se cancela sin mostrarse', async () => {
    const { session, events } = await h.open()
    await session.send('lateapproval')
    await sleep(100)
    await session.interrupt()
    await wait(() => h.turnEnds(events).length === 1)
    expect(events.some((e) => e.type === 'permission-request')).toBe(false)
    await wait(() => h.readLog().some((l) => l.lateReply !== undefined))
    expect(h.readLog().find((l) => l.lateReply !== undefined)?.lateReply).toEqual({
      decision: 'cancel',
    })
  })

  it('si turn/start falla, send rechaza, no hay turn-end y la sesión no queda ocupada', async () => {
    const { session, events } = await h.open({ FAKE_CODEX_START_FAIL: '1' })
    for (let i = 0; i < 2; i++) {
      const error = await reject(session.send('hola'))
      expect(error).toBeInstanceOf(AgentProviderError)
      expect((error as AgentProviderError).code).toBe('UNAVAILABLE')
      expect((error as Error).message).toMatch(/modelo inválido/)
    }
    expect(h.turnEnds(events)).toHaveLength(0)
  })
})

describe('Codex: ejecutables que no son Codex', () => {
  it('un proceso que sale enseguida da no disponible con un motivo, sin colgar', async () => {
    const script = join(h.dir(), 'sale.mjs')
    writeFileSync(
      script,
      "process.stderr.write('boom TOKEN=abc123secretvalue\\n'); process.exit(1)\n",
    )
    chmodSync(script, 0o755)
    const p = h.provider({}, { executable: script })
    expect(await p.isAvailable()).toBe(false)
    const reason = p.unavailableReason?.() ?? ''
    expect(reason).toMatch(/No se pudo consultar/)
    expect(reason).not.toContain('abc123secretvalue')
    const error = await reject(p.open({ cwd: h.dir() }))
    expect((error as AgentProviderError).code).toBe('UNAVAILABLE')
  })

  it('un proceso que responde basura al initialize no cuelga el probe', async () => {
    const script = join(h.dir(), 'basura.mjs')
    writeFileSync(
      script,
      'process.stdin.on(\'data\', () => process.stdout.write(\'{"id":1,"result":5}\\n{no json\\n\'))\nsetInterval(() => {}, 1000)\n',
    )
    const p = h.provider({}, { executable: script, probeTimeoutMs: 2000 })
    expect(await p.isAvailable()).toBe(false)
  })
})
