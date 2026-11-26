import { LIMITS, ProviderCapabilities, type ProviderEvent } from '@nexo/contracts'
import { AgentProviderError } from '@nexo/core'
import { describe, expect, it } from 'vitest'
import { ACP_PROTOCOL_VERSION, classifyMode, MODE_ALIASES, mapModes } from '../src/index.ts'
import { type LogLine, sleep, useFakeAcp, wait } from './helpers.ts'

const h = useFakeAcp()

const reject = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  )

const blocks = (events: ProviderEvent[]) =>
  events.flatMap((e) => (e.type === 'block-start' ? [e.block] : []))

describe('proveedor ACP: disponibilidad y capacidades', () => {
  it('declara la identidad del agente y capacidades válidas con modos y modelos del agente', async () => {
    const p = h.provider()
    expect(p.id).toBe('fake-acp')
    expect(p.displayName).toBe('ACP Falso')
    const caps = await p.capabilities()
    expect(ProviderCapabilities.safeParse(caps).success).toBe(true)
    expect(caps).toEqual({
      models: [
        { id: 'fake-pro', label: 'Fake Pro' },
        { id: 'fake-flash', label: 'Fake Flash' },
      ],
      defaultModel: 'fake-pro',
      efforts: [],
      permissionModes: ['ask', 'accept-edits', 'plan', 'bypass'],
      resume: true,
      warmup: false,
      streaming: true,
    })
  })

  it('los modelos también salen de una opción de configuración de categoría «model» (con grupos)', async () => {
    const caps = await h.provider({ FAKE_ACP_MODELS: 'config' }).capabilities()
    expect(caps.models.map((m) => m.id)).toEqual(['fake-pro', 'fake-flash'])
    expect(caps.defaultModel).toBe('fake-pro')
  })

  it('sin modelos ni modos anunciados: sin selector y solo «ask»', async () => {
    const caps = await h
      .provider({ FAKE_ACP_MODELS: 'none', FAKE_ACP_MODES: 'none' })
      .capabilities()
    expect(caps.models).toEqual([])
    expect(caps.defaultModel).toBeUndefined()
    expect(caps.permissionModes).toEqual(['ask'])
  })

  it('resume solo si el agente anuncia loadSession', async () => {
    expect((await h.provider({ FAKE_ACP_NO_LOAD: '1' }).capabilities()).resume).toBe(false)
    expect((await h.provider().capabilities()).resume).toBe(true)
  })

  it('disponible y sin motivo; lanza el agente con sus argumentos (--acp)', async () => {
    const p = h.provider()
    expect(await p.isAvailable()).toBe(true)
    expect(p.unavailableReason?.()).toBeUndefined()
    expect(h.readLog().some((l) => l.argv?.includes('--acp'))).toBe(true)
  })

  it('initialize negocia la versión 1 y declara las capacidades del cliente en falso', async () => {
    await h.provider().isAvailable()
    const [init] = h.calls('initialize')
    expect(init?.jsonrpc).toBe('2.0')
    expect(init?.params).toMatchObject({
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'nexo-workspace' },
    })
    expect(ACP_PROTOCOL_VERSION).toBe(1)
  })

  it('sin el comando: no disponible con el motivo y la pista de instalación del agente', async () => {
    const p = h.provider({}, {}, { id: 'gemini', name: 'Gemini', command: '/no/existe/gemini' })
    expect(await p.isAvailable()).toBe(false)
    expect(p.unavailableReason?.()).toMatch(/No se encontró Gemini.*npm i -g @google\/gemini-cli/)
    const caps = await p.capabilities()
    expect(caps.models).toEqual([])
    expect(caps.permissionModes).toEqual(['ask'])
  })

  it('un agente sin pista propia remite a NEXO_ACP_AGENTS', async () => {
    const p = h.provider({}, {}, { command: '/no/existe/otro' })
    expect(await p.isAvailable()).toBe(false)
    expect(p.unavailableReason?.()).toMatch(/NEXO_ACP_AGENTS/)
  })

  it('pide autenticación: no disponible, con los métodos del agente, sin autenticar ni leer credenciales', async () => {
    const p = h.provider({ FAKE_ACP_AUTH: '1' })
    expect(await p.isAvailable()).toBe(false)
    expect(p.unavailableReason?.()).toMatch(/pide autenticación.*Iniciar sesión con Google/)
    expect(p.unavailableReason?.()).toMatch(/Nexo no inicia sesión/)
    // Solo initialize y la sesión de prueba: nunca `authenticate`.
    expect(h.received().map((m) => m.method)).toEqual(['initialize', 'session/new'])
    const error = await reject(p.open({ cwd: h.dir() }))
    expect(error).toBeInstanceOf(AgentProviderError)
    expect((error as AgentProviderError).code).toBe('UNAVAILABLE')
  })

  it('una versión del protocolo incompatible: no disponible, con las dos versiones', async () => {
    const p = h.provider({ FAKE_ACP_VERSION: '2' })
    expect(await p.isAvailable()).toBe(false)
    expect(p.unavailableReason?.()).toMatch(/versión 2 .*ACP.*solo habla la 1/)
  })

  it('un proceso que no es un agente ACP da un motivo legible', async () => {
    const p = h.provider({}, {}, { args: [] })
    expect(await p.isAvailable()).toBe(false)
    expect(p.unavailableReason?.()).toMatch(/versión 1 del protocolo/)
  })

  it('reutiliza la comprobación mientras está fresca; una fallida caduca en 3 s', async () => {
    const p = h.provider({}, { probeCacheMs: 60_000 })
    await p.isAvailable()
    await p.capabilities()
    await p.isAvailable()
    expect(h.calls('initialize')).toHaveLength(1)

    let now = 0
    const bad = h.provider({ FAKE_ACP_AUTH: '1' }, { probeCacheMs: 60_000, now: () => now })
    await bad.isAvailable()
    await bad.isAvailable()
    expect(h.calls('initialize')).toHaveLength(1)
    now = 3500
    await bad.isAvailable()
    expect(h.calls('initialize')).toHaveLength(2)
  })
})

describe('tabla de modos de permiso', () => {
  it('clasifica los modos conocidos de Gemini, Claude y Codex por id o por nombre', () => {
    const c = (id: string, name = id) => classifyMode({ id, name })
    expect(c('default')).toBe('ask')
    expect(c('autoEdit', 'Auto Edit')).toBe('accept-edits')
    expect(c('acceptEdits')).toBe('accept-edits')
    expect(c('plan')).toBe('plan')
    expect(c('read-only')).toBe('plan')
    expect(c('yolo')).toBe('bypass')
    expect(c('bypassPermissions')).toBe('bypass')
    expect(c('full-access')).toBe('bypass')
    expect(c('x1', 'Auto Edit')).toBe('accept-edits')
    expect(c('raro')).toBeUndefined()
    expect(Object.keys(MODE_ALIASES).sort()).toEqual(['accept-edits', 'ask', 'bypass', 'plan'])
  })

  it('mapModes toma el primer modo del agente de cada clase', () => {
    expect(
      mapModes([
        { id: 'a', name: 'raro' },
        { id: 'default', name: 'x' },
        { id: 'yolo', name: 'y' },
        { id: 'fullaccess', name: 'z' },
      ]),
    ).toEqual(
      new Map([
        ['ask', 'default'],
        ['bypass', 'yolo'],
      ]),
    )
  })
})

describe('proveedor ACP: open', () => {
  it('session/new con la carpeta y sin servidores MCP; la ficha es el sessionId del agente', async () => {
    const { session } = await h.open()
    expect(session.providerSessionId).toBe('fake-session-1')
    const log: LogLine | undefined = h
      .readLog()
      .filter((l) => l.sessionNew !== undefined)
      .at(-1)
    expect(log?.sessionNew).toEqual({ cwd: h.dir(), mcpServers: [] })
  })

  it('cada modo normalizado se traduce al modo de sesión del agente (set_mode) y «ask» no cambia nada si ya está', async () => {
    const expected = { 'accept-edits': 'autoEdit', plan: 'plan', bypass: 'yolo' } as const
    for (const [mode, agentMode] of Object.entries(expected)) {
      await h.open({}, {}, { permissionMode: mode as keyof typeof expected })
      const [set] = h.calls('session/set_mode')
      expect(set?.params, mode).toMatchObject({ modeId: agentMode })
    }
    await h.open({}, {}, { permissionMode: 'ask' })
    expect(h.calls('session/set_mode')).toHaveLength(0)
  })

  it('un modo que el agente no ofrece se rechaza', async () => {
    const p = h.provider({ FAKE_ACP_MODES: 'none' })
    const error = await reject(p.open({ cwd: h.dir(), permissionMode: 'bypass' }))
    expect(error).toBeInstanceOf(AgentProviderError)
    expect((error as AgentProviderError).code).toBe('INVALID_OPTIONS')
    // «ask» siempre vale, aunque el agente no anuncie modos.
    const ok = await p.open({ cwd: h.dir(), permissionMode: 'ask' })
    await ok.close()
  })

  it('elige el modelo con session/set_model (inestable) o con session/set_config_option', async () => {
    await h.open({}, {}, { model: 'fake-flash' })
    expect(h.calls('session/set_model')[0]?.params).toMatchObject({ modelId: 'fake-flash' })
    const { events, session } = await h.open(
      { FAKE_ACP_MODELS: 'config' },
      {},
      { model: 'fake-flash' },
    )
    expect(h.calls('session/set_config_option')[0]?.params).toMatchObject({
      configId: 'model',
      value: 'fake-flash',
    })
    await session.send('simple')
    await wait(() => h.turnEnds(events).length === 1)
    expect(events[0]).toMatchObject({ type: 'session-info', model: 'fake-flash' })
  })

  it('el modelo por omisión del agente no provoca ninguna solicitud', async () => {
    const { events, session } = await h.open({}, {}, { model: 'fake-pro' })
    expect(h.calls('session/set_model')).toHaveLength(0)
    await session.send('simple')
    await wait(() => h.turnEnds(events).length === 1)
  })

  it('rechaza opciones inválidas: modelo desconocido o sin selector, esfuerzo, carpeta, ficha', async () => {
    const p = h.provider()
    const code = async (promise: Promise<unknown>) =>
      ((await reject(promise)) as AgentProviderError).code
    expect(await code(p.open({ cwd: h.dir(), model: 'nada' }))).toBe('INVALID_OPTIONS')
    expect(await code(p.open({ cwd: h.dir(), model: 'x y' }))).toBe('INVALID_OPTIONS')
    expect(await code(p.open({ cwd: h.dir(), effort: 'high' }))).toBe('INVALID_OPTIONS')
    expect(await code(p.open({ cwd: '/no/existe/nada' }))).toBe('INVALID_OPTIONS')
    expect(await code(p.open({ cwd: h.dir(), resume: 'con espacios' }))).toBe('INVALID_OPTIONS')
    // Sin lista de modelos no hay selector: cualquier modelo se rechaza.
    const none = h.provider({ FAKE_ACP_MODELS: 'none' })
    expect(await code(none.open({ cwd: h.dir(), model: 'fake-pro' }))).toBe('INVALID_OPTIONS')
    const noLoad = h.provider({ FAKE_ACP_NO_LOAD: '1' })
    expect(await code(noLoad.open({ cwd: h.dir(), resume: 'fake-session-1' }))).toBe(
      'INVALID_OPTIONS',
    )
  })

  it('session/load reanuda con la ficha y no reproduce el historial que el agente envía', async () => {
    const { session, events } = await h.open({}, {}, { resume: 'fake-session-7' })
    expect(session.providerSessionId).toBe('fake-session-7')
    expect(h.readLog().find((l) => l.sessionLoad !== undefined)?.sessionLoad).toEqual({
      sessionId: 'fake-session-7',
      cwd: h.dir(),
      mcpServers: [],
    })
    // Solo la sesión de la comprobación de disponibilidad: la de verdad es `session/load`.
    expect(h.calls('session/new')).toHaveLength(1)
    await sleep(50)
    expect(events).toHaveLength(0)
    await session.send('simple')
    await wait(() => h.turnEnds(events).length === 1)
    expect(h.textOf(events)).toBe('Hola desde ACP.')
  })

  it('una ficha que el agente no conoce da INVALID_OPTIONS', async () => {
    const error = await reject(h.provider().open({ cwd: h.dir(), resume: 'no-existe' }))
    expect((error as AgentProviderError).code).toBe('INVALID_OPTIONS')
    expect((error as AgentProviderError).message).toMatch(/no se pudo reanudar/)
  })
})

describe('proveedor ACP: turnos', () => {
  it('texto por fragmentos, session-info primero, uso en el turn-end e ignora el eco del usuario', async () => {
    const { session, events } = await h.open()
    await session.send('simple')
    await wait(() => h.turnEnds(events).length === 1)
    expect(events[0]).toMatchObject({
      type: 'session-info',
      providerSessionId: 'fake-session-1',
      model: 'fake-pro',
      permissionMode: 'ask',
    })
    expect(h.textOf(events)).toBe('Hola desde ACP.')
    expect(blocks(events)).toEqual([{ type: 'text', text: '', complete: false }])
    const end = events.at(-1)
    expect(end).toMatchObject({
      type: 'turn-end',
      stopReason: 'end-turn',
      usage: { inputTokens: 20, outputTokens: 10, reasoningTokens: 3 },
    })
    expect(h.calls('session/prompt')[0]?.params).toEqual({
      sessionId: 'fake-session-1',
      prompt: [{ type: 'text', text: 'simple' }],
    })
  })

  it('pensamiento, plan, lectura, edición con diff y comando fallido', async () => {
    const { session, events } = await h.open()
    await session.send('rich')
    await wait(() => h.turnEnds(events).length === 1)
    const starts = blocks(events)
    expect(starts.map((b) => b.type)).toEqual([
      'reasoning',
      'plan',
      'action',
      'action',
      'action',
      'text',
    ])
    // El plan se actualiza en el mismo bloque.
    const planRef = events.find((e) => e.type === 'block-start' && e.block.type === 'plan')
    const updates = events.filter(
      (e) => e.type === 'block-update' && e.ref === (planRef as { ref: string }).ref,
    )
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      block: {
        type: 'plan',
        entries: [
          { text: 'Leer el archivo', status: 'completed' },
          { text: 'Editar el archivo', status: 'completed' },
          { text: 'Probar', status: 'in-progress' },
        ],
      },
    })
    const ends = events.flatMap((e) =>
      e.type === 'block-end' && e.block?.type === 'action' ? [e.block] : [],
    )
    expect(ends[0]).toMatchObject({
      kind: 'read',
      status: 'ok',
      path: '/proyecto/src/a.ts',
      output: 'const a = 1',
      callId: 'r1',
    })
    expect(ends[1]).toMatchObject({ kind: 'edit', status: 'ok', path: '/proyecto/src/a.ts' })
    expect(ends[1]?.diff?.patch).toContain('-const a = 1')
    expect(ends[1]?.diff?.patch).toContain('+const a = 10')
    expect(ends[1]?.diff?.patch).toContain('+const c = 3')
    expect(ends[2]).toMatchObject({ kind: 'exec', status: 'error', exitCode: 1, tool: 'execute' })
    expect(ends[2]?.input).toContain('pnpm test')
    expect(h.textOf(events)).toBe('Pienso en el plan.Listo: **editado**.')
  })

  it('un archivo nuevo sale como diff desde /dev/null', async () => {
    const { session, events } = await h.open()
    await session.send('editar')
    await wait(() => h.turnEnds(events).length === 1)
    const end = events.flatMap((e) =>
      e.type === 'block-end' && e.block?.type === 'action' ? [e.block] : [],
    )[0]
    expect(end?.kind).toBe('edit')
    expect(end?.diff?.patch).toContain('--- /dev/null')
    expect(end?.diff?.patch).toContain('+hola')
  })

  it('permiso: las opciones llevan los PermissionOptionKind del agente y la elegida se responde con su optionId', async () => {
    const { session, events } = await h.open()
    await session.send('permiso')
    await wait(() => events.some((e) => e.type === 'permission-request'))
    const request = events.find((e) => e.type === 'permission-request')
    if (request?.type !== 'permission-request') throw new Error('sin solicitud')
    expect(request.tool).toBe('execute')
    expect(request.title).toBe('Ejecutar: rm -rf build')
    expect(request.detail).toContain('rm -rf build')
    expect(request.options.map((o) => [o.label, o.kind])).toEqual([
      ['Permitir', 'allow-once'],
      ['Permitir siempre', 'allow-always'],
      ['Rechazar', 'reject-once'],
    ])
    const always = request.options[1]
    await session.respond({
      type: 'permission',
      requestId: request.requestId,
      optionId: always?.id ?? '',
    })
    await wait(() => h.turnEnds(events).length === 1)
    expect(h.readLog().find((l) => l.permissionReply !== undefined)?.permissionReply).toEqual({
      outcome: { outcome: 'selected', optionId: 'always-1' },
    })
    expect(h.textOf(events)).toBe('Hecho.')
  })

  it('rechazar un permiso responde con la opción de rechazo y la acción queda en error', async () => {
    const { session, events } = await h.open()
    await session.send('permiso')
    await wait(() => events.some((e) => e.type === 'permission-request'))
    const request = events.find((e) => e.type === 'permission-request')
    if (request?.type !== 'permission-request') throw new Error('sin solicitud')
    const reject1 = request.options.find((o) => o.kind === 'reject-once')
    await session.respond({
      type: 'permission',
      requestId: request.requestId,
      optionId: reject1?.id ?? '',
    })
    await wait(() => h.turnEnds(events).length === 1)
    expect(h.readLog().find((l) => l.permissionReply !== undefined)?.permissionReply).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject-1' },
    })
    const end = events.flatMap((e) =>
      e.type === 'block-end' && e.block?.type === 'action' ? [e.block] : [],
    )[0]
    expect(end?.status).toBe('error')
  })

  it('interrumpir con un permiso pendiente lo responde «cancelled» y envía session/cancel', async () => {
    const { session, events } = await h.open()
    await session.send('permiso')
    await wait(() => events.some((e) => e.type === 'permission-request'))
    await session.interrupt()
    await wait(() => h.turnEnds(events).length === 1)
    expect(events.some((e) => e.type === 'request-cancelled')).toBe(true)
    expect(h.readLog().find((l) => l.permissionReply !== undefined)?.permissionReply).toEqual({
      outcome: { outcome: 'cancelled' },
    })
    expect(h.calls('session/cancel')).toHaveLength(1)
    expect(h.calls('session/cancel')[0]?.id).toBeUndefined()
    expect(events.at(-1)).toMatchObject({ type: 'turn-end', stopReason: 'interrupted' })
  })

  it('los stopReason del protocolo se traducen', async () => {
    const { session, events } = await h.open()
    for (const [prompt, stop] of [
      ['tope', 'max-tokens'],
      ['rechazo', 'refusal'],
    ] as const) {
      await session.send(prompt)
      await wait(() => h.turnEnds(events).length === (prompt === 'tope' ? 1 : 2))
      expect(events.at(-1)).toMatchObject({ type: 'turn-end', stopReason: stop })
    }
  })

  it('current_mode_update y session_info_update llegan como session-info', async () => {
    const { session, events } = await h.open()
    await session.send('modo')
    await wait(() => h.turnEnds(events).length === 1)
    expect(events).toContainEqual({ type: 'session-info', permissionMode: 'bypass' })
    expect(events).toContainEqual({ type: 'session-info', title: 'Título del agente' })
  })

  it('un error JSON-RPC del turno es un bloque de error no fatal y un turn-end de error; la sesión sigue', async () => {
    const { session, events } = await h.open()
    await session.send('error')
    await wait(() => h.turnEnds(events).length === 1)
    expect(h.errors(events)).toEqual([
      expect.objectContaining({
        code: 'ACP_ERROR',
        fatal: false,
        message: expect.stringContaining('fallo interno'),
      }),
    ])
    expect(events.at(-1)).toMatchObject({ stopReason: 'error' })
    await session.send('simple')
    await wait(() => h.turnEnds(events).length === 2)
  })

  it('si el agente pide autenticación a mitad de sesión: error fatal AUTH_REQUIRED', async () => {
    const { session, events } = await h.open()
    await session.send('auth')
    await wait(() => h.turnEnds(events).length === 1)
    expect(h.errors(events)[0]).toMatchObject({ code: 'AUTH_REQUIRED', fatal: true })
  })

  it('las solicitudes de fs y terminal reciben «método no encontrado» (Nexo no las ofrece)', async () => {
    const { session, events } = await h.open()
    await session.send('fs')
    await wait(() => h.turnEnds(events).length === 1)
    const log = h.readLog().find((l) => (l as { fsReply?: unknown }).fsReply !== undefined) as
      | { fsReply: { error: { code: number } }; termReply: { error: { code: number } } }
      | undefined
    expect(log?.fsReply.error.code).toBe(-32601)
    expect(log?.termReply.error.code).toBe(-32601)
  })

  it('un texto grande se parte en deltas de a lo sumo 32 KiB', async () => {
    const { session, events } = await h.open({ FAKE_ACP_BIG: String(100 * 1024) })
    await session.send('grande')
    await wait(() => h.turnEnds(events).length === 1)
    for (const e of events) {
      if (e.type === 'block-delta') {
        expect(new TextEncoder().encode(e.text).length).toBeLessThanOrEqual(LIMITS.maxDeltaBytes)
      }
    }
    expect(h.textOf(events).length).toBeGreaterThan(100 * 1024)
  })
})
