import { FakeAgentProvider, FakeClock, FakeHistory } from '@nexo/testkit'
import { describe, expect, it } from 'vitest'
import { DomainError } from './errors.ts'
import { HistoryService } from './history-service.ts'
import { HistoryError } from './ports/history.ts'

function rig(options: { claudeCanRead?: boolean } = {}) {
  const clock = new FakeClock(1_000_000)
  const claude = new FakeHistory('claude', { canRead: options.claudeCanRead ?? true })
  const codex = new FakeHistory('codex')
  const providers = [
    new FakeAgentProvider('claude', { displayName: 'Claude', history: claude }),
    new FakeAgentProvider('codex', { displayName: 'Codex', history: codex }),
    new FakeAgentProvider('ollama', { displayName: 'Ollama' }),
  ]
  const service = new HistoryService({ providers, clock })
  return { clock, claude, codex, service }
}

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
  } catch (e) {
    if (e instanceof DomainError) return e.code
    throw e
  }
  return 'ok'
}

describe('HistoryService.list', () => {
  it('une los proveedores, agrupa por carpeta y marca los que no tienen historial', async () => {
    const { claude, codex, service } = rig()
    claude.add({ cwd: '/w/a', updatedAt: 30, title: 'Uno' })
    codex.add({ cwd: '/w/a', updatedAt: 20 })
    codex.add({ cwd: '/w/b', updatedAt: 10 })
    const r = await service.list({})
    expect(r.projects.map((p) => p.name)).toEqual(['a', 'b'])
    expect(r.projects[0]?.sessions.map((s) => s.provider)).toEqual(['claude', 'codex'])
    expect(r.providers).toEqual(
      expect.arrayContaining([
        { provider: 'claude', status: 'ok' },
        { provider: 'codex', status: 'ok' },
        expect.objectContaining({ provider: 'ollama', status: 'unsupported' }),
      ]),
    )
  })

  it('filtra por proveedor y por carpeta', async () => {
    const { claude, codex, service } = rig()
    claude.add({ cwd: '/w/a', updatedAt: 30 })
    codex.add({ cwd: '/w/b', updatedAt: 20 })
    const onlyCodex = await service.list({ provider: 'codex' })
    expect(onlyCodex.projects.flatMap((p) => p.sessions).map((s) => s.provider)).toEqual(['codex'])
    expect(onlyCodex.providers).toHaveLength(1)
    const byCwd = await service.list({ cwd: '/w/a/' })
    expect(byCwd.projects.flatMap((p) => p.sessions).map((s) => s.provider)).toEqual(['claude'])
  })

  it('pagina con cursor', async () => {
    const { claude, service } = rig()
    for (let i = 0; i < 7; i++) claude.add({ cwd: '/w/a', updatedAt: 100 + i })
    const seen: string[] = []
    let cursor: string | undefined
    for (let n = 0; n < 10; n++) {
      const r = await service.list({ limit: 3, ...(cursor === undefined ? {} : { cursor }) })
      for (const p of r.projects) for (const s of p.sessions) seen.push(s.sessionId)
      if (r.nextCursor === null) break
      cursor = r.nextCursor
    }
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
  })

  it('reutiliza la lista unos segundos y la renueva al vencer', async () => {
    const { clock, claude, service } = rig()
    claude.add({ cwd: '/w/a', updatedAt: 1 })
    await service.list({})
    const again = await service.list({})
    expect(claude.calls.list).toBe(1)
    expect(again.providers.find((p) => p.provider === 'claude')?.cached).toBe(true)
    clock.advance(16_000)
    await service.list({})
    expect(claude.calls.list).toBe(2)
  })

  it('llamadas simultáneas comparten una sola consulta', async () => {
    const { claude, service } = rig()
    claude.add({ cwd: '/w/a', updatedAt: 1 })
    await Promise.all([service.list({}), service.list({}), service.list({})])
    expect(claude.calls.list).toBe(1)
  })

  it('un proveedor caído o colgado no rompe la respuesta de los demás', async () => {
    const { clock, claude, codex, service } = rig()
    claude.hang = true
    codex.add({ cwd: '/w/b', updatedAt: 5 })
    const pending = service.list({})
    for (let i = 0; i < 20; i++) await Promise.resolve()
    clock.advance(10_000)
    const r = await pending
    expect(r.providers.find((p) => p.provider === 'claude')?.status).toBe('timeout')
    expect(r.projects.flatMap((p) => p.sessions)).toHaveLength(1)
    claude.hang = false
    codex.failWith = new HistoryError('UNAVAILABLE', 'sin sesión iniciada')
    clock.advance(20_000)
    const r2 = await service.list({})
    expect(r2.providers.find((p) => p.provider === 'codex')).toMatchObject({
      status: 'unavailable',
      reason: 'sin sesión iniciada',
    })
  })

  it('un error inesperado se informa sin filtrar su mensaje', async () => {
    const { claude, service } = rig()
    claude.failWith = new Error('C:\\Users\\yo\\.claude\\secreto')
    const r = await service.list({ provider: 'claude' })
    expect(r.providers[0]).toMatchObject({ status: 'error' })
    expect(JSON.stringify(r)).not.toContain('secreto')
  })

  it('descarta sesiones inválidas y quita un título hostil sin esconder la sesión', async () => {
    const { claude, service } = rig()
    claude.add({ sessionId: 'ok-1', cwd: '/w/a', updatedAt: 3, title: 'bien' })
    claude.add({ sessionId: 'hostil-1', cwd: '/w/a', updatedAt: 2, title: 'a\nb\u001b[2J' })
    claude.sessions.set('mala', {
      info: { sessionId: '../../x', updatedAt: 1, resumable: true },
      blocks: [],
    })
    const r = await service.list({ provider: 'claude' })
    const all = r.projects.flatMap((p) => p.sessions)
    expect(all.map((s) => s.sessionId).sort()).toEqual(['hostil-1', 'ok-1'])
    expect(all.find((s) => s.sessionId === 'hostil-1')?.title).toBeUndefined()
  })

  it('rechaza cursores y proveedores desconocidos', async () => {
    const { service } = rig()
    expect(await code(service.list({ cursor: 'hostil' }))).toBe('INVALID_PARAMS')
    expect(await code(service.list({ provider: 'nadie' }))).toBe('PROVIDER_UNAVAILABLE')
  })

  it('tras close() rechaza y cancela lo pendiente', async () => {
    const { claude, service } = rig()
    claude.hang = true
    const pending = service.list({ provider: 'claude' })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    service.close()
    const r = await pending
    expect(r.providers[0]?.status).toBe('timeout')
    expect(await code(service.list({}))).toBe('PROVIDER_UNAVAILABLE')
  })
})

describe('HistoryService.read', () => {
  const messages = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    text: `mensaje ${i}`,
  }))

  it('lee por páginas con cursor y guarda la transcripción', async () => {
    const { claude, service } = rig()
    const id = claude.add({ cwd: '/w/a', messages })
    const first = await service.read({ provider: 'claude', sessionId: id, limit: 12 })
    expect(first.blocks).toHaveLength(12)
    expect(first.total).toBe(30)
    expect(first.nextCursor).not.toBeNull()
    const all = [...first.blocks]
    let cursor = first.nextCursor
    while (cursor !== null) {
      const page = await service.read({ provider: 'claude', sessionId: id, limit: 12, cursor })
      all.push(...page.blocks)
      cursor = page.nextCursor
    }
    expect(all.map((b) => b.index)).toEqual(Array.from({ length: 30 }, (_, i) => i))
    expect(claude.calls.read).toBe(1)
  })

  it('corta la página por bytes', async () => {
    const { claude, service } = rig()
    const big = 'x'.repeat(60 * 1024)
    const id = claude.add({
      messages: [
        { role: 'user', text: big },
        { role: 'assistant', text: big },
        { role: 'user', text: big },
      ],
    })
    const page = await service.read({ provider: 'claude', sessionId: id, limit: 100 })
    expect(page.blocks.length).toBeLessThan(3)
    expect(page.blocks.length).toBeGreaterThan(0)
    expect(page.nextCursor).not.toBeNull()
  })

  it('un bloque enorme se sustituye por un aviso', async () => {
    const { claude, service } = rig()
    const id = claude.add({
      blocks: [
        {
          turn: 1,
          block: {
            type: 'action',
            kind: 'exec',
            status: 'ok',
            tool: 'Bash',
            title: 'x',
            exitCode: 0,
            output: '\u0001'.repeat(110 * 1024),
            input: '\u0001'.repeat(10 * 1024),
          },
        },
      ],
    })
    const page = await service.read({ provider: 'claude', sessionId: id })
    expect(page.blocks[0]?.block.type).toBe('text')
    expect(page.truncated).toBe(true)
  })

  it('descarta bloques inválidos del proveedor y marca truncated', async () => {
    const { claude, service } = rig()
    const id = claude.add({
      blocks: [
        { turn: 1, block: { type: 'user', text: 'ok' } },
        { turn: 1, block: { type: 'nada' } as never },
        { turn: 1, block: { type: 'user', text: '' } },
      ],
    })
    const page = await service.read({ provider: 'claude', sessionId: id })
    expect(page.blocks).toHaveLength(1)
    expect(page.truncated).toBe(true)
  })

  it('traduce los errores del puerto a códigos del protocolo', async () => {
    const { clock, claude, service } = rig()
    expect(await code(service.read({ provider: 'claude', sessionId: 'no-existe-1' }))).toBe(
      'NOT_FOUND',
    )
    expect(await code(service.read({ provider: 'claude', sessionId: 'a;b' }))).toBe(
      'INVALID_PARAMS',
    )
    expect(await code(service.read({ provider: 'ollama', sessionId: 'x1' }))).toBe(
      'PROVIDER_UNAVAILABLE',
    )
    expect(await code(service.read({ provider: 'nadie', sessionId: 'x1' }))).toBe(
      'PROVIDER_UNAVAILABLE',
    )
    const id = claude.add({ messages })
    expect(await code(service.read({ provider: 'claude', sessionId: id, cursor: 'zzz' }))).toBe(
      'INVALID_PARAMS',
    )
    expect(await code(service.read({ provider: 'claude', sessionId: id, cursor: 'o999' }))).toBe(
      'INVALID_PARAMS',
    )
    clock.advance(31_000)
    claude.failWith = new Error('boom con /ruta/secreta')
    const e = await service.read({ provider: 'claude', sessionId: id }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(DomainError)
    expect((e as DomainError).message).not.toContain('secreta')
  })

  it('un proveedor que solo lista no permite leer', async () => {
    const { claude, service } = rig({ claudeCanRead: false })
    const id = claude.add({ messages })
    expect(await code(service.read({ provider: 'claude', sessionId: id }))).toBe(
      'PROVIDER_UNAVAILABLE',
    )
    const list = await service.list({ provider: 'claude' })
    expect(list.projects[0]?.sessions[0]?.readable).toBe(false)
  })
})
