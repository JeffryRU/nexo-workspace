import { resolve } from 'node:path'
import type { MethodParams, MethodResult } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { runCli } from './cli.ts'
import { HistoryListOutput, HistoryReadOutput } from './schemas.ts'
import { makeEnv, type TestEnv, WORK } from './test-helpers.ts'

const run = (env: TestEnv, ...args: string[]) => runCli(args, env.deps)

const session = (id: string, over: Record<string, unknown> = {}) => ({
  provider: 'claude',
  sessionId: id,
  cwd: '/work/app',
  title: `Sesión ${id}`,
  updatedAt: 1_700_000_000_000,
  resumable: true,
  readable: true,
  ...over,
})

const page = (over: Partial<MethodResult<'history.list'>> = {}): MethodResult<'history.list'> => ({
  projects: [{ cwd: '/work/app', name: 'app', sessions: [session('s1'), session('s2')] }],
  nextCursor: null,
  providers: [
    { provider: 'claude', status: 'ok' },
    { provider: 'ollama', status: 'unsupported', reason: 'Ollama no ofrece historial' },
  ],
  ...over,
})

describe('nexo history ls', () => {
  it('agrupa por carpeta, muestra el estado de los proveedores y avisa si hay más', async () => {
    const env = makeEnv()
    env.client.handlers.set('history.list', () => page({ nextCursor: 'h1-1-2-3-a-b' }))
    expect(await run(env, 'history', 'ls')).toBe(0)
    expect(env.cap.out).toContain('/work/app')
    expect(env.cap.out).toContain('Sesión s1')
    expect(env.cap.out).toContain('! ollama: unsupported')
    expect(env.cap.out).toContain('--cursor h1-1-2-3-a-b')
    expect(env.client.callsTo('history.list')[0]).toEqual({ limit: 50 })
  })

  it('pasa proveedor, carpeta (resuelta), límite y cursor', async () => {
    const env = makeEnv()
    env.client.handlers.set('history.list', () => page())
    await run(
      env,
      'history',
      'ls',
      '--provider',
      'codex',
      '--cwd',
      'sub',
      '--limit',
      '7',
      '--cursor',
      'abc',
    )
    expect(env.client.callsTo('history.list')[0]).toEqual({
      provider: 'codex',
      cwd: resolve(WORK, 'sub'),
      limit: 7,
      cursor: 'abc',
    })
  })

  it('--all sigue los cursores y junta una carpeta partida', async () => {
    const env = makeEnv()
    const pages = [
      page({ nextCursor: 'c1' }),
      page({
        projects: [{ cwd: '/work/app', name: 'app', sessions: [session('s3')] }],
        nextCursor: null,
      }),
    ]
    env.client.handlers.set('history.list', () => pages.shift() as MethodResult<'history.list'>)
    expect(await run(env, 'history', '--json', 'ls', '--all')).toBe(0)
    const out = HistoryListOutput.parse(JSON.parse(env.cap.out))
    expect(out.projects).toHaveLength(1)
    expect(out.projects[0]?.sessions.map((s) => s.sessionId)).toEqual(['s1', 's2', 's3'])
    expect(env.client.callsTo('history.list')[1]).toMatchObject({ cursor: 'c1' })
  })

  it('sin sesiones lo dice', async () => {
    const env = makeEnv()
    env.client.handlers.set('history.list', () => page({ projects: [], providers: [] }))
    await run(env, 'history', 'ls')
    expect(env.cap.out).toContain('no hay sesiones')
  })

  it('opciones inválidas son errores de uso y no llaman al daemon', async () => {
    for (const args of [
      ['ls', '--limit', '0'],
      ['ls', '--limit', '101'],
      ['ls', '--cwd', ''],
      ['ls', '--all', '--cursor', 'x'],
      ['ls', 'sobra'],
      ['ls', '--nada'],
      [],
      ['borrar'],
    ]) {
      const env = makeEnv()
      expect(await run(env, 'history', ...args), args.join(' ')).toBe(1)
      expect(env.client.callsTo('history.list')).toHaveLength(0)
    }
  })
})

const read = (over: Partial<MethodResult<'history.read'>> = {}): MethodResult<'history.read'> => ({
  provider: 'claude',
  sessionId: 'abc',
  blocks: [
    { index: 0, turn: 1, block: { type: 'user', text: 'hola' } },
    { index: 1, turn: 1, block: { type: 'text', text: 'buenas', complete: true } },
  ],
  nextCursor: null,
  total: 2,
  truncated: false,
  ...over,
})

describe('nexo history show', () => {
  it('pinta la transcripción como un documento de agente', async () => {
    const env = makeEnv()
    env.client.handlers.set('history.read', () => read())
    expect(await run(env, 'history', 'show', 'claude', 'abc')).toBe(0)
    expect(env.cap.out).toContain('> hola')
    expect(env.cap.out).toContain('buenas')
    expect(env.client.callsTo('history.read')[0]).toEqual({
      provider: 'claude',
      sessionId: 'abc',
      limit: 50,
    })
  })

  it('avisa del recorte y de la página siguiente', async () => {
    const env = makeEnv()
    env.client.handlers.set('history.read', () =>
      read({ nextCursor: 'o2', total: 9, truncated: true }),
    )
    await run(env, 'history', 'show', 'claude', 'abc')
    expect(env.cap.out).toContain('se recortó')
    expect(env.cap.out).toContain('--cursor o2')
  })

  it('--all junta las páginas y --json emite history.read', async () => {
    const env = makeEnv()
    const pages = [
      read({ nextCursor: 'o2', total: 3 }),
      read({
        blocks: [{ index: 2, turn: 2, block: { type: 'user', text: 'otra' } }],
        nextCursor: null,
        total: 3,
      }),
    ]
    env.client.handlers.set('history.read', () => pages.shift() as MethodResult<'history.read'>)
    expect(await run(env, 'history', '--json', 'show', 'claude', 'abc', '--all')).toBe(0)
    const out = HistoryReadOutput.parse(JSON.parse(env.cap.out))
    expect(out.blocks).toHaveLength(3)
  })

  it('exige proveedor y sesión', async () => {
    const env = makeEnv()
    expect(await run(env, 'history', 'show', 'claude')).toBe(1)
    expect(env.client.callsTo('history.read')).toHaveLength(0)
  })
})

describe('nexo agent new --resume', () => {
  it('pasa la ficha a agent.create', async () => {
    const env = makeEnv()
    const calls: MethodParams<'agent.create'>[] = []
    env.client.handlers.set('workspace.list', () => ({ workspaces: [] }))
    env.client.handlers.set('workspace.create', () => ({
      workspace: { id: 'ws-1', name: 'w', cwd: WORK, tabs: [], activeTabId: undefined },
    }))
    env.client.handlers.set('tab.create', () => ({
      tab: { id: 'tab-1', title: 't', panes: [{ id: 'pane-1' }] },
    }))
    env.client.handlers.set('pane.split', () => ({ pane: { id: 'pane-2' } }))
    env.client.handlers.set('pane.close', () => ({}))
    env.client.handlers.set('agent.create', (p) => {
      calls.push(p as MethodParams<'agent.create'>)
      return { session: { id: 's-1', provider: 'claude' } }
    })
    await run(env, 'agent', 'new', '--resume', 'abc-123')
    expect(calls[0]).toMatchObject({ resume: 'abc-123' })
    const bad = makeEnv()
    expect(await run(bad, 'agent', 'new', '--resume', '')).toBe(1)
  })
})
