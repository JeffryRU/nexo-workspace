import { ProviderCapabilities } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { createClaudeProvider, STATIC_MODELS } from '../src/provider.ts'
import { FakeTransport, tempDir } from './helpers.ts'
import { setup, useCleanup, wait } from './setup.ts'

useCleanup()

describe('capacidades', () => {
  it('sin lista del SDK devuelve la lista estática y es válida', async () => {
    const t = new FakeTransport()
    const caps = await createClaudeProvider({ transport: t, env: {} }).capabilities()
    expect(ProviderCapabilities.safeParse(caps).success).toBe(true)
    expect(caps.models.map((m) => m.id)).toEqual(STATIC_MODELS.map((m) => m.id))
    expect(caps).toMatchObject({ resume: true, warmup: true, streaming: true })
    expect(caps.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(caps.permissionModes).toEqual(['ask', 'accept-edits', 'plan', 'bypass'])
  })

  it('usa los modelos del SDK, descarta los inválidos y los cachea', async () => {
    const t = new FakeTransport()
    t.models = [
      { id: 'opus', label: 'Opus\n4', efforts: ['low', 'high'] },
      { id: 'mal modelo' },
      { id: 'haiku' },
    ]
    const p = createClaudeProvider({ transport: t, env: {} })
    const caps = await p.capabilities()
    expect(caps.models).toEqual([
      { id: 'opus', label: 'Opus 4', efforts: ['low', 'high'] },
      { id: 'haiku' },
    ])
    await p.capabilities()
    expect(t.modelCalls).toBe(1)
  })

  it('si consultar falla, usa la estática y no reintenta de inmediato', async () => {
    const t = new FakeTransport()
    const p = createClaudeProvider({ transport: t, env: {} })
    expect((await p.capabilities()).models).toHaveLength(STATIC_MODELS.length)
    await p.capabilities()
    expect(t.modelCalls).toBe(1)
  })

  it('un transporte sin listModels ni warmUp declara warmup falso', async () => {
    const t = new FakeTransport()
    const bare = {
      isAvailable: () => t.isAvailable(),
      start: (o: Parameters<FakeTransport['start']>[0]) => t.start(o),
    }
    const p = createClaudeProvider({ transport: bare, env: {} })
    expect((await p.capabilities()).warmup).toBe(false)
    expect(p.warmUp).toBeUndefined()
  })
})

describe('open', () => {
  it('traduce modelo, esfuerzo, modo de permisos y carpeta al SDK', async () => {
    const { provider, transport, dir } = await setup()
    await provider.open({
      cwd: dir.path,
      model: 'opus',
      effort: 'high',
      permissionMode: 'accept-edits',
    })
    await provider.open({ cwd: dir.path, permissionMode: 'plan' })
    await provider.open({ cwd: dir.path, permissionMode: 'bypass' })
    const [first, a, b, c] = transport.sessions.map((s) => s.options)
    expect(first?.permissionMode).toBe('default')
    expect(a).toMatchObject({
      cwd: dir.path,
      model: 'opus',
      effort: 'high',
      permissionMode: 'acceptEdits',
    })
    expect(b).toMatchObject({ permissionMode: 'plan' })
    expect(c).toMatchObject({ permissionMode: 'bypassPermissions' })
  })

  it('rechaza opciones inválidas con INVALID_OPTIONS', async () => {
    const { provider, dir } = await setup()
    const bad = [
      { cwd: '' },
      { cwd: `${dir.path}/no-existe` },
      { cwd: dir.path, model: 'dos palabras' },
      { cwd: dir.path, effort: 'enorme' },
      { cwd: dir.path, permissionMode: 'todo' as 'ask' },
      { cwd: dir.path, resume: 'no-existe-xyz' },
      { cwd: dir.path, resume: '7c9e6679-7425-40de-944b-e07fc1f90ae7' },
    ]
    for (const options of bad) {
      await expect(provider.open(options), JSON.stringify(options)).rejects.toMatchObject({
        code: 'INVALID_OPTIONS',
      })
    }
  })

  it('reanuda con el id del SDK y lo expone como providerSessionId', async () => {
    const { provider, session, dir } = await setup()
    const again = await provider.open({ cwd: dir.path, resume: session.providerSessionId })
    expect(again.providerSessionId).toBe(session.providerSessionId)
    await again.close()
  })

  it('sin SDK o ejecutable rechaza con UNAVAILABLE y isAvailable da false', async () => {
    const t = new FakeTransport()
    t.available = false
    const dir = tempDir()
    const p = createClaudeProvider({ transport: t, env: {} })
    expect(await p.isAvailable()).toBe(false)
    await expect(p.open({ cwd: dir.path })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    t.available = true
    t.startError = new Error('spawn ENOENT')
    await expect(p.open({ cwd: dir.path })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    dir.remove()
  })

  it('isAvailable es false si el transporte lanza', async () => {
    const p = createClaudeProvider({
      transport: {
        isAvailable: () => Promise.reject(new Error('x')),
        start: () => Promise.reject(new Error('x')),
      },
      env: {},
    })
    expect(await p.isAvailable()).toBe(false)
  })
})

describe('warmUp', () => {
  it('delega en el transporte y valida la carpeta', async () => {
    const t = new FakeTransport()
    const dir = tempDir()
    const p = createClaudeProvider({ transport: t, env: {} })
    await p.warmUp?.({ cwd: dir.path })
    expect(t.warmed).toEqual([dir.path])
    await expect(p.warmUp?.({ cwd: '' })).rejects.toMatchObject({ code: 'INVALID_OPTIONS' })
    await expect(p.warmUp?.({ cwd: `${dir.path}/nada` })).rejects.toMatchObject({
      code: 'INVALID_OPTIONS',
    })
    const broken = new FakeTransport()
    broken.warmUp = () => Promise.reject(new Error('sin ejecutable'))
    await expect(
      createClaudeProvider({ transport: broken, env: {} }).warmUp?.({ cwd: dir.path }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    dir.remove()
  })
})

describe('secretos', () => {
  const KEY = 'sk-ant-api03-SECRETO-SECRETO-1234567890'
  const TOKEN = 'sk-ant-oat01-OTRO-SECRETO-ABCDEFGHIJ'

  it('el log y el stderr pasan por el redactor: no queda ni la clave ni el token', async () => {
    const logs: string[] = []
    const { session, events, fake } = await setup({
      env: { ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_OAUTH_TOKEN: TOKEN, HOME: '/home/x' },
      log: (e) => logs.push(e.message),
    })
    fake.options.onStderr?.(`fallo con ${KEY} y ${TOKEN} y Authorization: Bearer abcdefghijklmnop`)
    await session.send('long')
    fake.fail(new Error(`el proceso murió con ${KEY}`))
    await wait(() => events.some((e) => e.type === 'exit'))
    const all = JSON.stringify([logs, events])
    expect(all).not.toContain('SECRETO')
    expect(all).not.toContain('ABCDEFGHIJ')
    expect(all).not.toContain('abcdefghijklmnop')
    expect(logs.join('')).toContain('[REDACTED]')
  })

  it('el texto del agente que repite una credencial del entorno sale tachado', async () => {
    const { session, events, fake } = await setup({ env: { ANTHROPIC_API_KEY: KEY } })
    await session.send('long')
    fake.emit(
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      },
      {
        type: 'stream_event',
        parent_tool_use_id: null,
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: `tu clave es ${KEY}` },
        },
      },
    )
    await wait(() => events.some((e) => e.type === 'block-delta'))
    expect(JSON.stringify(events)).not.toContain('SECRETO')
  })
})
