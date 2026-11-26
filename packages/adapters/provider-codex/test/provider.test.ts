import { ProviderCapabilities } from '@nexo/contracts'
import { AgentProviderError } from '@nexo/core'
import { describe, expect, it } from 'vitest'
import { PERMISSION_POLICY } from '../src/index.ts'
import { sleep, useFakeCodex, wait } from './helpers.ts'

const h = useFakeCodex()

const reject = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  )

describe('proveedor Codex: disponibilidad y capacidades', () => {
  it('capacidades desde model/list: sin ocultos, con esfuerzos por modelo y el modelo por omisión', async () => {
    const caps = await h.provider().capabilities()
    expect(ProviderCapabilities.safeParse(caps).success).toBe(true)
    expect(caps.models).toEqual([
      { id: 'gpt-fake', label: 'GPT Fake', efforts: ['low', 'medium', 'high'] },
      { id: 'gpt-mini', label: 'GPT Mini', efforts: ['low'] },
    ])
    expect(caps).toMatchObject({
      defaultModel: 'gpt-fake',
      efforts: ['low', 'medium', 'high'],
      permissionModes: ['ask', 'accept-edits', 'plan', 'bypass'],
      resume: true,
      warmup: false,
      streaming: true,
    })
  })

  it('disponible con sesión iniciada y sin motivo', async () => {
    const p = h.provider()
    expect(await p.isAvailable()).toBe(true)
    expect(p.unavailableReason?.()).toBeUndefined()
  })

  it('sin sesión iniciada: no disponible, con el motivo «codex login» y sin tocar credenciales', async () => {
    const p = h.provider({ FAKE_CODEX_LOGGED_OUT: '1' })
    expect(await p.isAvailable()).toBe(false)
    expect(p.unavailableReason?.()).toMatch(/codex login/)
    const caps = await p.capabilities()
    expect(caps.models).toEqual([])
    const error = await reject(p.open({ cwd: h.dir() }))
    expect(error).toBeInstanceOf(AgentProviderError)
    expect((error as AgentProviderError).code).toBe('UNAVAILABLE')
  })

  it('sin la CLI: no disponible con instrucciones de instalación', async () => {
    const p = h.provider({}, { executable: '/no/existe/codex' })
    expect(await p.isAvailable()).toBe(false)
    expect(p.unavailableReason?.()).toMatch(/No se encontró Codex.*npm i -g @openai\/codex/)
  })

  it('si model/list falla sigue disponible, con esfuerzos por omisión', async () => {
    const p = h.provider({ FAKE_CODEX_MODELS_FAIL: '1' })
    expect(await p.isAvailable()).toBe(true)
    const caps = await p.capabilities()
    expect(caps.models).toEqual([])
    expect(caps.efforts).toEqual(['low', 'medium', 'high', 'xhigh'])
  })

  it('reutiliza la comprobación mientras está fresca', async () => {
    const p = h.provider({}, { probeCacheMs: 60_000 })
    await p.isAvailable()
    await p.capabilities()
    await p.isAvailable()
    expect(h.calls('account/read')).toHaveLength(1)
  })

  it('una comprobación fallida caduca pronto (3 s como mucho) para notar un login reciente', async () => {
    let now = 0
    const p = h.provider({ FAKE_CODEX_LOGGED_OUT: '1' }, { probeCacheMs: 60_000, now: () => now })
    await p.isAvailable()
    await p.isAvailable()
    expect(h.calls('account/read')).toHaveLength(1)
    now = 3500
    await p.isAvailable()
    expect(h.calls('account/read')).toHaveLength(2)
  })

  it('un proceso que no habla el protocolo da un motivo legible y no cuelga', async () => {
    const p = h.provider(
      { FAKE_CODEX_NO_INIT: '1' },
      { probeTimeoutMs: 300, limits: { requestTimeoutMs: 300 } },
    )
    expect(await p.isAvailable()).toBe(false)
    expect(p.unavailableReason?.()).toMatch(/0\.158\.0/)
  })
})

describe('proveedor Codex: open', () => {
  it('los cuatro modos normalizados fijan la política de aprobación y el sandbox', async () => {
    for (const mode of ['ask', 'accept-edits', 'plan', 'bypass'] as const) {
      await h.open({}, {}, { permissionMode: mode })
      const [start] = h.calls('thread/start')
      expect(start?.params).toMatchObject({
        approvalPolicy: PERMISSION_POLICY[mode].approvalPolicy,
        sandbox: PERMISSION_POLICY[mode].sandbox,
      })
    }
    expect(PERMISSION_POLICY).toEqual({
      ask: { approvalPolicy: 'untrusted', sandbox: 'workspace-write' },
      'accept-edits': { approvalPolicy: 'on-request', sandbox: 'workspace-write' },
      plan: { approvalPolicy: 'on-request', sandbox: 'read-only' },
      bypass: { approvalPolicy: 'never', sandbox: 'danger-full-access' },
    })
  })

  it('hace el handshake (initialize + initialized) antes de abrir el hilo y lanza «app-server» en la carpeta', async () => {
    await h.open({}, {}, { model: 'gpt-mini' })
    const methods = h.received().map((m) => m.method)
    const first = methods.indexOf('initialize')
    expect(first).toBeGreaterThanOrEqual(0)
    expect(methods.slice(first, first + 2)).toEqual(['initialize', 'initialized'])
    expect(methods.indexOf('thread/start')).toBeGreaterThan(methods.lastIndexOf('initialized') - 1)
    expect(h.readLog().some((l) => l.argv?.[0] === 'app-server')).toBe(true)
    const [start] = h.calls('thread/start')
    expect(start?.params).toMatchObject({ cwd: h.dir(), model: 'gpt-mini' })
    const [init] = h.calls('initialize')
    expect(init?.params).toMatchObject({ clientInfo: { name: 'nexo-workspace' } })
    // Sin el campo jsonrpc, como el servidor real.
    expect(init).not.toHaveProperty('jsonrpc')
  })

  it('rechaza opciones inválidas con INVALID_OPTIONS', async () => {
    const p = h.provider()
    const bad: Record<string, unknown>[] = [
      { cwd: '' },
      { cwd: '/no/existe/de/verdad' },
      { cwd: h.dir(), model: 'con espacios' },
      { cwd: h.dir(), effort: 'turbo' },
      { cwd: h.dir(), permissionMode: 'otro' },
      { cwd: h.dir(), resume: '../../etc' },
    ]
    for (const options of bad) {
      const error = await reject(p.open(options as never))
      expect(error, JSON.stringify(options)).toBeInstanceOf(AgentProviderError)
      expect((error as AgentProviderError).code).toBe('INVALID_OPTIONS')
    }
  })

  it('reanudar usa thread/resume con el hilo pedido; uno inexistente es INVALID_OPTIONS', async () => {
    const id = '0198a1b2-1111-7222-8333-444455556666'
    const { session } = await h.open({}, {}, { resume: id })
    expect(session.providerSessionId).toBe(id)
    const [resume] = h.calls('thread/resume')
    expect(resume?.params).toMatchObject({
      threadId: id,
      excludeTurns: true,
      approvalPolicy: 'untrusted',
    })
    const error = await reject(h.provider().open({ cwd: h.dir(), resume: 'faltante' }))
    expect((error as AgentProviderError).code).toBe('INVALID_OPTIONS')
    expect((error as Error).message).toMatch(/reanudar/)
  })

  it('un fallo al abrir deja sin procesos y sin sesión', async () => {
    const error = await reject(
      h
        .provider(
          { FAKE_CODEX_NO_INIT: '1' },
          { limits: { requestTimeoutMs: 200 }, probeCacheMs: 60_000 },
        )
        .open({ cwd: h.dir() }),
    )
    expect(error).toBeInstanceOf(AgentProviderError)
  })
})

describe('proveedor Codex: turnos', () => {
  it('un turno simple: session-info, texto por deltas, uso y turn-end', async () => {
    const { session, events } = await h.open({}, {}, { model: 'gpt-fake', effort: 'high' })
    await session.send('simple hola')
    await wait(() => h.turnEnds(events).length === 1)
    expect(events[0]).toMatchObject({
      type: 'session-info',
      providerSessionId: session.providerSessionId,
      model: 'gpt-fake',
      effort: 'high',
      permissionMode: 'ask',
    })
    expect(h.textOf(events)).toBe('Hola mundo')
    expect(events.find((e) => e.type === 'usage')).toBeDefined()
    expect(events.at(-1)).toMatchObject({
      type: 'turn-end',
      stopReason: 'end-turn',
      usage: { durationMs: 1234 },
    })
    const [turn] = h.calls('turn/start')
    expect(turn?.params).toMatchObject({
      threadId: session.providerSessionId,
      input: [{ type: 'text', text: 'simple hola', text_elements: [] }],
      model: 'gpt-fake',
      effort: 'high',
    })
  })

  it('session-info solo en el primer turno; el segundo turno funciona', async () => {
    const { session, events } = await h.open()
    await session.send('uno')
    await wait(() => h.turnEnds(events).length === 1)
    await session.send('dos')
    await wait(() => h.turnEnds(events).length === 2)
    expect(events.filter((e) => e.type === 'session-info')).toHaveLength(1)
  })

  it('rechaza texto vacío (INVALID_OPTIONS) y un segundo send con turno en curso (BUSY)', async () => {
    const { session, events } = await h.open()
    expect(((await reject(session.send(''))) as AgentProviderError).code).toBe('INVALID_OPTIONS')
    await session.send('long')
    expect(((await reject(session.send('otro'))) as AgentProviderError).code).toBe('BUSY')
    await session.interrupt()
    await wait(() => h.turnEnds(events).length === 1)
  })

  it('traduce todos los tipos de item a bloques', async () => {
    const { session, events } = await h.open()
    await session.send('rich')
    await wait(() => h.turnEnds(events).length === 1)
    const starts = events.flatMap((e) => (e.type === 'block-start' ? [e.block] : []))
    expect(starts.map((b) => (b.type === 'action' ? `action:${b.kind}` : b.type))).toEqual([
      'reasoning',
      'action:exec',
      'action:edit',
      'action:search',
      'action:other',
      'text',
    ])
    const ends = events.flatMap((e) =>
      e.type === 'block-end' && e.block?.type === 'action' ? [e.block] : [],
    )
    expect(ends[0]).toMatchObject({ status: 'error', exitCode: 2, output: 'a\nb\n' })
    expect(ends[1]).toMatchObject({ status: 'ok', diff: { path: 'src/a.ts' } })
    expect(ends[3]).toMatchObject({ tool: 'mcp__git__status', output: 'limpio' })
    expect(h.textOf(events)).toContain('Primero miro.\n\nLuego edito.')
    expect(events.find((e) => e.type === 'usage')).toMatchObject({
      usage: { inputTokens: 6, outputTokens: 4 },
    })
  })
})

describe('proveedor Codex: aprobaciones', () => {
  const answerOf = (id: string) => h.received().find((m) => m.id === id)?.result

  async function ask(prompt: string) {
    const ctx = await h.open()
    await ctx.session.send(prompt)
    await wait(() => ctx.events.some((e) => e.type === 'permission-request'))
    const request = ctx.events.find((e) => e.type === 'permission-request')
    if (request?.type !== 'permission-request') throw new Error('sin solicitud')
    return { ...ctx, request }
  }

  it('una aprobación de comando se muestra y «Permitir» responde accept', async () => {
    const { session, events, request } = await ask('permiso')
    expect(request).toMatchObject({ tool: 'shell', title: 'Ejecutar: rm -rf build' })
    expect(request.detail).toContain('Motivo: limpiar')
    expect(request.options.map((o) => o.id)).toEqual(['allow', 'allow-session', 'reject'])
    await session.respond({ type: 'permission', requestId: request.requestId, optionId: 'allow' })
    await wait(() => h.turnEnds(events).length === 1)
    expect(answerOf('srv-1')).toEqual({ decision: 'accept' })
    const end = events.flatMap((e) =>
      e.type === 'block-end' && e.block?.type === 'action' ? [e.block] : [],
    )
    expect(end[0]).toMatchObject({ status: 'ok', exitCode: 0, output: 'borrado\n' })
  })

  it('«Rechazar» responde decline y «Permitir en esta sesión» acceptForSession', async () => {
    const a = await ask('permiso')
    await a.session.respond({
      type: 'permission',
      requestId: a.request.requestId,
      optionId: 'reject',
    })
    await wait(() => h.turnEnds(a.events).length === 1)
    expect(answerOf('srv-1')).toEqual({ decision: 'decline' })
    const end = a.events.flatMap((e) =>
      e.type === 'block-end' && e.block?.type === 'action' ? [e.block] : [],
    )
    expect(end[0]).toMatchObject({ status: 'error' })

    const b = await ask('permiso')
    await b.session.respond({
      type: 'permission',
      requestId: b.request.requestId,
      optionId: 'allow-session',
    })
    await wait(() => h.turnEnds(b.events).length === 1)
    expect(answerOf('srv-1')).toEqual({ decision: 'acceptForSession' })
  })

  it('aprobación de parche', async () => {
    const { session, events, request } = await ask('patch')
    expect(request).toMatchObject({ tool: 'apply_patch', title: 'Aplicar cambios en archivos' })
    await session.respond({ type: 'permission', requestId: request.requestId, optionId: 'allow' })
    await wait(() => h.turnEnds(events).length === 1)
    expect(answerOf('srv-1')).toEqual({ decision: 'accept' })
  })

  it('respuestas inválidas: opción inexistente, solicitud desconocida, pregunta; la solicitud sigue pendiente', async () => {
    const { session, events, request } = await ask('permiso')
    const code = async (r: Parameters<typeof session.respond>[0]) =>
      ((await reject(session.respond(r))) as AgentProviderError).code
    expect(
      await code({ type: 'permission', requestId: request.requestId, optionId: 'constructor' }),
    ).toBe('INVALID_OPTIONS')
    expect(await code({ type: 'permission', requestId: 'req-99', optionId: 'allow' })).toBe(
      'UNKNOWN_REQUEST',
    )
    expect(await code({ type: 'question', requestId: request.requestId, answers: [] })).toBe(
      'UNKNOWN_REQUEST',
    )
    await session.respond({ type: 'permission', requestId: request.requestId, optionId: 'allow' })
    expect(
      await code({ type: 'permission', requestId: request.requestId, optionId: 'allow' }),
    ).toBe('UNKNOWN_REQUEST')
    await wait(() => h.turnEnds(events).length === 1)
  })

  it('interrumpir con una aprobación pendiente la cancela (cancel) y termina como interrupted', async () => {
    const { session, events, request } = await ask('permiso')
    await session.interrupt()
    await wait(() => h.turnEnds(events).length === 1)
    expect(
      events.some((e) => e.type === 'request-cancelled' && e.requestId === request.requestId),
    ).toBe(true)
    expect(events.at(-1)).toMatchObject({ stopReason: 'interrupted' })
    await wait(() => answerOf('srv-1') !== undefined)
    expect(answerOf('srv-1')).toEqual({ decision: 'cancel' })
    expect(h.calls('turn/interrupt')).toHaveLength(1)
  })
})

describe('proveedor Codex: interrupción y cierre', () => {
  it('turn/interrupt lleva el hilo y el turno; el turno acaba como interrupted y se puede seguir', async () => {
    const { session, events } = await h.open()
    await session.send('long')
    await wait(() => h.textOf(events) !== '')
    await session.interrupt()
    await wait(() => h.turnEnds(events).length === 1)
    const [call] = h.calls('turn/interrupt')
    const turn = h.calls('turn/start')[0]
    expect(call?.params).toMatchObject({ threadId: session.providerSessionId })
    expect(typeof (call?.params as { turnId?: unknown } | undefined)?.turnId).toBe('string')
    expect(turn).toBeDefined()
    expect(events.at(-1)).toMatchObject({ stopReason: 'interrupted' })
    await session.send('simple')
    await wait(() => h.turnEnds(events).length === 2)
  })

  it('close emite un solo exit, mata el proceso y luego send rechaza con CLOSED', async () => {
    const { session, events } = await h.open()
    await session.send('long')
    await session.close()
    await session.close()
    expect(events.filter((e) => e.type === 'exit')).toHaveLength(1)
    expect(events.some((e) => e.type === 'turn-end')).toBe(false)
    expect(((await reject(session.send('x'))) as AgentProviderError).code).toBe('CLOSED')
    await sleep(20)
    expect(events.filter((e) => e.type === 'exit')).toHaveLength(1)
  })

  it('onEvent cancelado deja de recibir', async () => {
    const { session } = await h.open()
    let n = 0
    const off = session.onEvent(() => {
      n++
    })
    off()
    await session.send('simple')
    await sleep(300)
    expect(n).toBe(0)
  })
})
