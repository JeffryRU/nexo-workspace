import { ERROR_CODES, METHOD_NAMES, type MethodName, methods, type PaneId } from '@nexo/contracts'
import { bootHarness, createHarness } from '@nexo/testkit'
import { describe, expect, it } from 'vitest'
import { createDispatcher, createHandlers } from './dispatcher.ts'
import { DomainError } from './errors.ts'

describe('createDispatcher', () => {
  it('la tabla de manejadores cubre exactamente los métodos del registro', () => {
    const h = createHarness()
    const handlers = createHandlers({
      workspaces: h.workspaces,
      terminals: h.terminals,
      snapshot: h.snapshot,
      subscribe: () => ({ seq: 0 }),
      shutdown: () => {},
    })
    expect(Object.keys(handlers).sort()).toEqual([...METHOD_NAMES].sort())
  })

  it('despacha un flujo completo y cada resultado valida con su esquema', async () => {
    const h = createHarness()
    const run = async <M extends MethodName>(
      method: M,
      params: Parameters<typeof h.dispatch<M>>[0]['params'],
    ) => {
      const out = await h.dispatch({ method, params } as Parameters<typeof h.dispatch<M>>[0])
      expect(out.ok).toBe(true)
      if (!out.ok) throw new Error(out.error.message)
      expect(methods[method].result.safeParse(out.result).success).toBe(true)
      return out.result
    }
    const { workspace } = await run('workspace.create', { name: 'p', cwd: '/w' })
    const { tab } = await run('tab.create', { workspaceId: workspace.id })
    const paneId = tab.panes[0]?.id as PaneId
    const { terminalId } = await run('terminal.spawn', { paneId, cols: 80, rows: 24 })
    await run('terminal.write', { terminalId, data: 'ls\r' })
    await run('terminal.resize', { terminalId, cols: 90, rows: 30 })
    h.pty.processes[0]?.emitData('hola')
    expect(await run('terminal.read', { terminalId })).toEqual({ data: 'hola', offset: 4 })
    const { pane } = await run('pane.split', { paneId, direction: 'row' })
    await run('pane.resize', { paneId, delta: 0.1 })
    await run('pane.resize', { tabId: tab.id, path: [], index: 0, delta: -0.1 })
    const missing = await h.dispatch({
      method: 'pane.resize',
      params: { tabId: tab.id, path: [9], index: 0, delta: 0.1 },
    })
    expect(missing).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    await run('pane.swap', { paneId, otherPaneId: pane.id })
    await run('pane.focus', { paneId })
    await run('tab.rename', { tabId: tab.id, title: 'x' })
    await run('tab.focus', { tabId: tab.id })
    await run('tab.move', { tabId: tab.id, index: 0 })
    await run('workspace.rename', { workspaceId: workspace.id, name: 'q' })
    expect((await run('workspace.list', {})).workspaces).toHaveLength(1)
    expect((await run('snapshot', {})).workspaces[0]?.name).toBe('q')
    expect(await run('daemon.info', {})).toMatchObject({ protocol: 1, version: '0.0.0-test' })
    expect(await run('daemon.shutdown', {})).toEqual({})
    expect(h.shutdowns.count).toBe(1)
    expect(await run('events.subscribe', {})).toEqual({ seq: h.bus.events.length })
    await run('terminal.kill', { terminalId })
    await run('pane.close', { paneId: pane.id })
    await run('tab.close', { tabId: tab.id })
    await run('workspace.close', { workspaceId: workspace.id })
    expect((await run('workspace.list', {})).workspaces).toEqual([])
  })

  it('los errores de dominio salen con su código y nunca lanzan', async () => {
    const h = createHarness()
    const out = await h.dispatch({
      method: 'tab.close',
      params: { tabId: 'no' as never },
    })
    expect(out).toEqual({ ok: false, error: { code: 'NOT_FOUND', message: expect.any(String) } })
    const t = await bootHarness({ config: { writeRate: { maxWrites: 1, windowMs: 1000 } } })
    const { terminalId } = await t.spawn()
    await t.dispatch({ method: 'terminal.write', params: { terminalId, data: 'a' } })
    const limited = await t.dispatch({
      method: 'terminal.write',
      params: { terminalId, data: 'a' },
    })
    expect(limited).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } })
  })

  it('un error inesperado es INTERNAL y no filtra su mensaje', async () => {
    const h = createHarness()
    const dispatch = createDispatcher({
      workspaces: h.workspaces,
      terminals: h.terminals,
      snapshot: h.snapshot,
      subscribe: () => {
        throw new Error('clave secreta en el mensaje')
      },
      shutdown: () => {},
    })
    const out = await dispatch({ method: 'events.subscribe', params: {} })
    expect(out).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'error interno' } })
  })

  it('un error de dominio de un manejador conserva código y datos', async () => {
    const h = createHarness()
    const dispatch = createDispatcher({
      workspaces: h.workspaces,
      terminals: h.terminals,
      snapshot: h.snapshot,
      subscribe: () => {
        throw new DomainError('UNAUTHORIZED', 'no', { x: 1 })
      },
      shutdown: () => {},
    })
    expect(await dispatch({ method: 'events.subscribe', params: {} })).toEqual({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: 'no', data: { x: 1 } },
    })
  })

  it('un método fuera del registro es NOT_FOUND (incluidos nombres de Object.prototype)', async () => {
    const h = createHarness()
    for (const method of ['nada', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '']) {
      const out = await h.dispatch({ method, params: {} } as never)
      expect(out).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    }
  })

  it('todos los códigos de error posibles son códigos del protocolo', async () => {
    const h = createHarness()
    for (const method of METHOD_NAMES) {
      const out = await h.dispatch({ method, params: {} } as never)
      if (!out.ok) expect(ERROR_CODES).toContain(out.error.code)
    }
  })

  it('sin servicio de agentes, cada agent.* responde PROVIDER_UNAVAILABLE', async () => {
    const h = createHarness()
    for (const method of METHOD_NAMES.filter((m) => m.startsWith('agent.'))) {
      const out = await h.dispatch({ method, params: {} } as never)
      expect(out, method).toMatchObject({ ok: false, error: { code: 'PROVIDER_UNAVAILABLE' } })
    }
  })

  it('sin servicio de memoria, cada memory.* responde PROVIDER_UNAVAILABLE; con él, delega', async () => {
    const h = createHarness()
    for (const method of METHOD_NAMES.filter((m) => m.startsWith('memory.'))) {
      const out = await h.dispatch({ method, params: {} } as never)
      expect(out, method).toMatchObject({ ok: false, error: { code: 'PROVIDER_UNAVAILABLE' } })
    }
    const dispatch = createDispatcher({
      workspaces: h.workspaces,
      terminals: h.terminals,
      snapshot: h.snapshot,
      subscribe: () => ({ seq: 0 }),
      shutdown: () => {},
      memory: {
        'memory.status': () => ({
          enabled: false,
          thresholds: { observerBatchTokens: 6000, reflectorTokens: 40000 },
          usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
        }),
        'memory.list': () => ({ reflection: null, observations: [], nextSeq: null }),
        'memory.search': () => ({ observations: [], truncated: false }),
        'memory.recall': () => {
          throw new DomainError('NOT_FOUND', 'sesión inexistente')
        },
        'memory.configure': (p) => ({ enabled: p.enabled ?? false }),
      },
    })
    expect(await dispatch({ method: 'memory.status', params: {} })).toMatchObject({ ok: true })
    expect(await dispatch({ method: 'memory.configure', params: { enabled: true } })).toEqual({
      ok: true,
      result: { enabled: true },
    })
    expect(
      await dispatch({
        method: 'memory.recall',
        params: { sessionId: 's1' as never, range: { from: 0, to: 1 } },
      }),
    ).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it('con servicio de agentes, delega con los params y devuelve el resultado', async () => {
    const h = createHarness()
    const calls: unknown[] = []
    const noop = () => ({})
    const dispatch = createDispatcher({
      workspaces: h.workspaces,
      terminals: h.terminals,
      snapshot: h.snapshot,
      subscribe: () => ({ seq: 0 }),
      shutdown: () => {},
      agents: {
        'agent.providers': () => ({ providers: [] }),
        'agent.create': (p) => {
          calls.push(p)
          throw new DomainError('CONFLICT', 'demasiadas sesiones')
        },
        'agent.send': () => ({ blockId: 'b' as never, index: 0, turn: 1 }),
        'agent.interrupt': noop,
        'agent.respond': noop,
        'agent.list': () => ({ sessions: [] }),
        'agent.snapshot': () => {
          throw new Error('secreto interno')
        },
        'agent.close': noop,
        'agent.renew': () => {
          throw new DomainError('CONFLICT', 'hay un turno en curso')
        },
      },
    })
    expect(await dispatch({ method: 'agent.list', params: {} })).toEqual({
      ok: true,
      result: { sessions: [] },
    })
    const created = await dispatch({
      method: 'agent.create',
      params: { paneId: 'p1' as never, provider: 'claude' },
    })
    expect(created).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(calls).toEqual([{ paneId: 'p1', provider: 'claude' }])
    const snap = await dispatch({ method: 'agent.snapshot', params: { sessionId: 's' as never } })
    expect(snap).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'error interno' } })
  })
})
