import { describe, expect, it, vi } from 'vitest'
import { createSdkTransport, type SdkApi } from '../src/sdk-transport.ts'
import { TransportError } from '../src/transport.ts'

type Opts = Record<string, unknown> & {
  canUseTool?: (
    name: string,
    input: Record<string, unknown>,
    o: Record<string, unknown>,
  ) => Promise<unknown>
}

function fakeQuery(prompt: AsyncIterable<unknown>, options: Opts, failModel = false) {
  const received: unknown[] = []
  let closed = false
  void (async () => {
    for await (const m of prompt) received.push(m)
  })()
  const q = {
    options,
    received,
    interrupts: 0,
    models: [] as string[],
    modes: [] as string[],
    get closed() {
      return closed
    },
    interrupt: async () => {
      q.interrupts++
    },
    setModel: async (m: string) => {
      if (failModel) throw new Error('modelo no aplicable')
      q.models.push(m)
    },
    setPermissionMode: async (m: string) => {
      q.modes.push(m)
    },
    supportedModels: async () => [
      { value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: ['low', 'high'] },
      { value: 'haiku', displayName: 'Haiku' },
    ],
    close: () => {
      closed = true
    },
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init' }
    },
  }
  return q
}
type FakeQuery = ReturnType<typeof fakeQuery>

function fakeSdk(known: string[] = [], failModel = false) {
  const queries: FakeQuery[] = []
  const warms: { options: Opts; closed: boolean }[] = []
  const sdk = {
    query: vi.fn(({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Opts }) => {
      const q = fakeQuery(prompt, options)
      queries.push(q)
      return q
    }),
    startup: vi.fn(async ({ options }: { options: Opts }) => {
      const warm = { options, closed: false }
      warms.push(warm)
      return {
        query: (prompt: AsyncIterable<unknown>) => {
          const q = fakeQuery(prompt, options, failModel)
          queries.push(q)
          return q
        },
        close: () => {
          warm.closed = true
        },
      }
    }),
    getSessionInfo: vi.fn(async (id: string) =>
      known.includes(id) ? { sessionId: id } : undefined,
    ),
  }
  return { sdk, api: sdk as unknown as SdkApi, queries, warms }
}

const noop = () => Promise.resolve({ behavior: 'deny' as const, message: 'no' })
const start = (cwd = '/work') => ({
  cwd,
  permissionMode: 'default' as const,
  canUseTool: noop,
})

const make = (api: SdkApi, extra: Record<string, unknown> = {}) =>
  createSdkTransport({
    env: { ANTHROPIC_API_KEY: 'k', EMPTY: undefined },
    loadSdk: async () => api,
    fileExists: async () => true,
    ...extra,
  })

describe('start', () => {
  it('abre una consulta con entrada en streaming y parciales, con el entorno y las opciones', async () => {
    const { api, queries } = fakeSdk()
    const t = make(api, { pathToClaudeCodeExecutable: '/bin/claude' })
    const s = await t.start({
      ...start('/work'),
      model: 'opus',
      effort: 'high',
      permissionMode: 'acceptEdits',
    })
    const q = queries[0]
    expect(q?.options).toMatchObject({
      cwd: '/work',
      model: 'opus',
      effort: 'high',
      permissionMode: 'acceptEdits',
      includePartialMessages: true,
      sessionId: s.sessionId,
      pathToClaudeCodeExecutable: '/bin/claude',
      env: { ANTHROPIC_API_KEY: 'k' },
    })
    expect(q?.options.allowDangerouslySkipPermissions).toBeUndefined()
    expect(s.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    s.send('hola')
    s.send('otra')
    await new Promise((r) => setTimeout(r, 5))
    expect(q?.received).toEqual([
      { type: 'user', message: { role: 'user', content: 'hola' }, parent_tool_use_id: null },
      { type: 'user', message: { role: 'user', content: 'otra' }, parent_tool_use_id: null },
    ])
    const seen: unknown[] = []
    for await (const m of s.messages) seen.push(m)
    expect(seen).toHaveLength(1)
    await s.interrupt()
    expect(q?.interrupts).toBe(1)
    s.close()
    s.close()
    expect(q?.closed).toBe(true)
    expect(() => s.send('tarde')).toThrow()
  })

  it('bypass activa allowDangerouslySkipPermissions', async () => {
    const { api, queries } = fakeSdk()
    await make(api).start({ ...start(), permissionMode: 'bypassPermissions' })
    expect(queries[0]?.options).toMatchObject({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    })
  })

  it('canUseTool traduce la decisión al formato del SDK', async () => {
    const { api, queries } = fakeSdk()
    const asks: unknown[] = []
    const decisions = [
      { behavior: 'allow' as const, updatedInput: { a: 1 }, updatedPermissions: [{ type: 'x' }] },
      { behavior: 'allow' as const },
      { behavior: 'deny' as const, message: 'no', interrupt: true },
      { behavior: 'deny' as const, message: 'no' },
    ]
    await make(api).start({
      ...start(),
      canUseTool: async (ask) => {
        asks.push(ask)
        return decisions.shift() ?? { behavior: 'deny', message: '' }
      },
    })
    const can = queries[0]?.options.canUseTool
    const signal = new AbortController().signal
    const o = {
      signal,
      toolUseID: 't1',
      title: 'T',
      displayName: 'D',
      description: 'S',
      blockedPath: '/x',
      suggestions: [1],
    }
    expect(await can?.('Bash', { c: 1 }, o)).toEqual({
      behavior: 'allow',
      updatedInput: { a: 1 },
      updatedPermissions: [{ type: 'x' }],
    })
    expect(await can?.('Bash', {}, { signal, toolUseID: 't2' })).toEqual({ behavior: 'allow' })
    expect(await can?.('Bash', {}, { signal, toolUseID: 't3' })).toEqual({
      behavior: 'deny',
      message: 'no',
      interrupt: true,
    })
    expect(await can?.('Bash', {}, { signal, toolUseID: 't4' })).toEqual({
      behavior: 'deny',
      message: 'no',
    })
    expect(asks[0]).toMatchObject({
      toolName: 'Bash',
      toolUseId: 't1',
      title: 'T',
      displayName: 'D',
      description: 'S',
      blockedPath: '/x',
      suggestions: [1],
    })
  })

  it('reanudar: una sesión desconocida da UNKNOWN_SESSION; una conocida usa resume sin sessionId', async () => {
    const id = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
    const { api, queries } = fakeSdk([id])
    const t = make(api)
    await expect(
      t.start({ ...start(), resume: 'aaaaaaaa-0000-0000-0000-000000000000' }),
    ).rejects.toBeInstanceOf(TransportError)
    const s = await t.start({ ...start(), resume: id })
    expect(s.sessionId).toBe(id)
    expect(queries[0]?.options.resume).toBe(id)
    expect(queries[0]?.options.sessionId).toBeUndefined()
  })

  it('si getSessionInfo falla no bloquea la reanudación (lo decide el proceso)', async () => {
    const { api, sdk } = fakeSdk()
    sdk.getSessionInfo.mockRejectedValue(new Error('disco'))
    await expect(make(api).start({ ...start(), resume: 'x' })).resolves.toBeDefined()
  })
})

describe('warmUp', () => {
  it('start reclama el proceso precalentado: no abre otro y aplica modelo y modo', async () => {
    const { api, sdk, queries, warms } = fakeSdk()
    const t = make(api)
    await Promise.all([t.warmUp?.({ cwd: '/work' }), t.warmUp?.({ cwd: '/work' })])
    await t.warmUp?.({ cwd: '/work' })
    expect(sdk.startup).toHaveBeenCalledTimes(1)
    const warmSession = warms[0]?.options.sessionId
    const asked: string[] = []
    const s = await t.start({
      ...start('/work'),
      model: 'haiku',
      permissionMode: 'plan',
      canUseTool: async (ask) => {
        asked.push(ask.toolName)
        return { behavior: 'allow' }
      },
    })
    expect(sdk.query).not.toHaveBeenCalled()
    expect(s.sessionId).toBe(warmSession)
    expect(queries[0]?.models).toEqual(['haiku'])
    expect(queries[0]?.modes).toEqual(['plan'])
    // el canUseTool del proceso precalentado ya apunta a la sesión que lo reclamó
    await (warms[0]?.options.canUseTool as unknown as NonNullable<Opts['canUseTool']>)?.(
      'Bash',
      {},
      {
        signal: new AbortController().signal,
        toolUseID: 'x',
      },
    )
    expect(asked).toEqual(['Bash'])
    // se consume: el siguiente start abre una consulta normal
    await t.start(start('/work'))
    expect(sdk.query).toHaveBeenCalledTimes(1)
  })

  it('no reclama si hay esfuerzo, bypass, resume u otra carpeta', async () => {
    const id = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
    const { api, sdk } = fakeSdk([id])
    const t = make(api)
    await t.warmUp?.({ cwd: '/work' })
    await t.start({ ...start('/work'), effort: 'low' })
    await t.start({ ...start('/work'), permissionMode: 'bypassPermissions' })
    await t.start({ ...start('/work'), resume: id })
    await t.start(start('/otra'))
    expect(sdk.query).toHaveBeenCalledTimes(4)
  })

  it('si aplicar el modelo falla, cierra esa consulta y cae al arranque normal', async () => {
    const { api, sdk, queries } = fakeSdk([], true)
    const t = make(api)
    await t.warmUp?.({ cwd: '/work' })
    const s = await t.start({ ...start('/work'), model: 'haiku' })
    expect(queries[0]?.closed).toBe(true)
    expect(sdk.query).toHaveBeenCalledTimes(1)
    expect(s.sessionId).not.toBe(queries[0]?.options.sessionId)
  })

  it('el precalentado expira y se cierra; el cupo descarta el más viejo', async () => {
    const { api, warms } = fakeSdk()
    const t = make(api, { warmTtlMs: 10 })
    await t.warmUp?.({ cwd: '/a' })
    await new Promise((r) => setTimeout(r, 40))
    expect(warms[0]?.closed).toBe(true)
    const t2 = make(api)
    for (const c of ['/1', '/2', '/3', '/4', '/5']) await t2.warmUp?.({ cwd: c })
    expect(warms.slice(1).map((w) => w.closed)).toEqual([true, false, false, false, false])
  })
})

describe('listModels', () => {
  it('lista los modelos del SDK y cierra la consulta', async () => {
    const { api, queries } = fakeSdk()
    const models = await make(api).listModels?.({ cwd: '/work' })
    expect(models).toEqual([
      { id: 'sonnet', label: 'Sonnet', efforts: ['low', 'high'] },
      { id: 'haiku', label: 'Haiku' },
    ])
    expect(queries[0]?.closed).toBe(true)
  })
})

describe('isAvailable', () => {
  it('false si el SDK no carga o falta el ejecutable; true si todo está', async () => {
    const { api } = fakeSdk()
    const noSdk = createSdkTransport({
      env: {},
      loadSdk: async () => {
        throw new Error('no está')
      },
    })
    expect(await noSdk.isAvailable()).toBe(false)
    const noExe = make(api, {
      fileExists: async () => false,
      resolveBundledExecutable: () => ['/a', '/b'],
    })
    expect(await noExe.isAvailable()).toBe(false)
    const bundled = make(api, {
      fileExists: async (p: string) => p === '/b',
      resolveBundledExecutable: () => ['/a', '/b'],
    })
    expect(await bundled.isAvailable()).toBe(true)
    const explicit = make(api, {
      pathToClaudeCodeExecutable: '/mio',
      fileExists: async (p: string) => p === '/mio',
    })
    expect(await explicit.isAvailable()).toBe(true)
  })

  it('con el SDK real instalado no lanza y responde un booleano (sin red)', async () => {
    const t = createSdkTransport({ env: {} })
    expect(typeof (await t.isAvailable())).toBe('boolean')
    const missing = createSdkTransport({ env: {}, pathToClaudeCodeExecutable: '/no/existe/claude' })
    expect(await missing.isAvailable()).toBe(false)
  })
})
