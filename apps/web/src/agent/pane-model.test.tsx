import { describe, expect, it } from 'vitest'
import { AgentPaneModel } from './pane-model.ts'
import { bid, blocks, mountAgent, SID, settle } from './test-helpers.ts'

describe('AgentPaneModel con el daemon falso', () => {
  it('se abre sobre la sesión del panel y refleja su estado', async () => {
    const h = await mountAgent({
      blocks: [blocks.user(0), blocks.text(1, 'x')],
      session: { status: 'working' },
    })
    expect(h.model.docState()).toBe('live')
    expect(h.model.ids()).toEqual([bid(0), bid(1)])
    expect(h.model.status()).toBe('working')
    expect(h.model.session()?.id).toBe(SID)
    expect(h.model.canSend).toBe(false)
    h.emitStatus('done')
    expect(h.model.status()).toBe('done')
    expect(h.model.canSend).toBe(true)
  })

  it('agent.session actualiza la sesión; agent.session removed la marca cerrada', async () => {
    const h = await mountAgent({ blocks: [] })
    h.client.emit('agent.session', { session: { ...h.state.session, status: 'error' } })
    expect(h.model.status()).toBe('error')
    h.client.emit('agent.session', { sessionId: SID, removed: true })
    expect(h.model.removed()).toBe(true)
    expect(h.model.canSend).toBe(false)
  })

  it('los eventos de un bloque se agrupan en un solo fotograma', async () => {
    const h = await mountAgent({ blocks: [blocks.text(0, '', { complete: false })] })
    h.frames.flush()
    const before = h.frames.pending
    for (let i = 1; i <= 100; i++) h.emitDelta(bid(0), i, 'x')
    expect(h.frames.pending - before).toBe(1)
    const sig = h.model.block(bid(0))
    expect(sig()).toMatchObject({ text: '' })
    h.frames.flush()
    expect(sig()).toMatchObject({ text: 'x'.repeat(100), seq: 100 })
  })

  it('pendingIds lista permisos y preguntas sin resolver, en orden', async () => {
    const h = await mountAgent({
      blocks: [
        blocks.permission(0),
        blocks.permission(1, { state: 'accepted', selectedOptionId: 'once' }),
        blocks.question(2),
        blocks.text(3),
      ],
    })
    expect(h.model.pendingIds()).toEqual([bid(0), bid(2)])
  })

  it('un hueco de índices fuerza una resincronización desde el daemon', async () => {
    const h = await mountAgent({ blocks: [blocks.user(0)] })
    // El daemon ya tiene el bloque 1, pero el evento se perdió; llega el 2.
    h.state.blocks = [blocks.user(0), blocks.text(1, 'perdido'), blocks.text(2, 'nuevo')]
    h.emitBlock(h.state.blocks[2] as never)
    await h.flush()
    expect(h.model.ids()).toEqual([bid(0), bid(1), bid(2)])
    expect(h.model.block(bid(1))()).toMatchObject({ text: 'perdido' })
  })

  it('el resync del cliente (reconexión) recompone el documento', async () => {
    const h = await mountAgent({ blocks: [blocks.user(0)] })
    h.state.blocks = [blocks.user(0), blocks.text(1, 'mientras estabas fuera')]
    h.client.emit('resync', { reason: 'reconnect' })
    await h.flush()
    await h.flush()
    expect(h.model.ids()).toEqual([bid(0), bid(1)])
  })

  it('si la sesión no existe, queda en failed con el motivo y se puede reintentar', async () => {
    const h = await mountAgent({ blocks: [] })
    h.client.handlers.set('agent.snapshot', () => {
      throw new Error('NOT_FOUND')
    })
    // Otro panel nuevo contra la misma conexión.
    const other = h.appModel.agents.ensure('otro')
    other.bind(SID, h.appModel.agentClient())
    await settle()
    expect(other.docState()).toBe('failed')
    expect(other.docError()).toContain('NOT_FOUND')
    h.client.handlers.set('agent.snapshot', () => ({
      session: h.state.session,
      blocks: [],
      nextIndex: null,
    }))
    other.retry()
    await settle()
    expect(other.docState()).toBe('live')
  })

  it('bind sin sesión o sin conexión no hace nada; bind repetido no reabre', async () => {
    const h = await mountAgent({ blocks: [] })
    const calls = h.client.callsOf('agent.snapshot').length
    h.model.bind(undefined, h.appModel.agentClient())
    h.model.bind(SID, h.appModel.agentClient())
    h.model.bind(SID, undefined)
    await settle()
    expect(h.client.callsOf('agent.snapshot')).toHaveLength(calls)
    expect(h.model.docState()).toBe('live')
  })

  it('send respeta el estado y no envía vacío; los fallos del daemon van a la barra de errores', async () => {
    const h = await mountAgent({ blocks: [], session: { status: 'done' } })
    expect(await h.model.send('   ')).toBe(false)
    h.client.handlers.set('agent.send', () => {
      throw new Error('CONFLICT: turno en curso')
    })
    expect(await h.model.send('hola')).toBe(false)
    expect(h.appModel.ui.error()).toContain('CONFLICT')
    h.client.handlers.set('agent.send', () => ({ blockId: bid(5), index: 5, turn: 2 }))
    expect(await h.model.send('  hola  ')).toBe(true)
    expect(h.client.callsOf('agent.send').at(-1)?.params).toEqual({ sessionId: SID, text: 'hola' })
  })

  it('dispose libera el documento y deja de reaccionar', async () => {
    const h = await mountAgent({ blocks: [blocks.user(0)] })
    h.model.dispose()
    h.emitBlock(blocks.text(1))
    h.frames.flush()
    expect(h.model.ids()).toEqual([])
    h.model.bind(SID, h.appModel.agentClient())
    await settle()
    expect(h.model.docState()).not.toBe('live')
  })

  it('el registro libera los modelos de paneles que ya no existen', async () => {
    const h = await mountAgent({ blocks: [] })
    const extra = h.appModel.agents.ensure('fantasma')
    expect(h.appModel.agents.get('fantasma')).toBe(extra)
    h.appModel.agents.prune(new Set(['p1']))
    expect(h.appModel.agents.get('fantasma')).toBeUndefined()
    expect(h.appModel.agents.get('p1')).toBe(h.model)
    h.appModel.agents.disposeAll()
    expect(h.appModel.agents.get('p1')).toBeUndefined()
  })

  it('create rechaza una segunda creación y propaga el fallo', async () => {
    const h = await mountAgent({ withSession: false })
    h.client.handlers.set('agent.create', () => {
      throw new Error('PROVIDER_UNAVAILABLE')
    })
    expect(await h.model.create({ provider: 'fake' }, 'hola')).toBe(false)
    expect(h.appModel.ui.error()).toContain('PROVIDER_UNAVAILABLE')
    expect(h.model.busy()).toBe(false)
    expect(h.model.sessionId).toBeUndefined()
  })

  it('se puede construir sin conexión y las órdenes no hacen nada', async () => {
    const m = new AgentPaneModel({
      paneId: 'x',
      getClient: () => undefined,
      frame: (cb) => cb(),
      onError: () => {},
    })
    expect(await m.create({ provider: 'fake' })).toBe(false)
    expect(await m.respondPermission(bid(0), 'a')).toBe(false)
    expect(await m.respondQuestion(bid(0), [])).toBe(false)
    await m.interrupt()
    expect(m.canSend).toBe(false)
    m.toggle('b1')
    expect(m.expanded('b1')()).toBe(true)
    m.toggle('b1')
    expect(m.expanded('b1')()).toBe(false)
  })
})
