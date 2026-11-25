import { fireEvent } from '@solidjs/testing-library'
import { describe, expect, it } from 'vitest'
import { mountApp } from './test-app.tsx'
import { FakeClient, mkPane, mkTab, mkWorkspace, pid, snapshotOf, xid } from './test-helpers.ts'

const tick = () => new Promise((r) => setTimeout(r, 0))
const EVIL = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>'

describe('interfaz: datos hostiles del daemon', () => {
  it('títulos con HTML o scripts se muestran como texto y nunca se inyectan', async () => {
    const tab = mkTab('t1', ['p1'])
    const ws = mkWorkspace(
      'w1',
      [{ ...tab, title: EVIL, panes: [mkPane('p1', { title: EVIL })] }],
      { name: EVIL },
    )
    const { container, client } = await mountApp(snapshotOf([ws]))
    client.emit('pane.title', { paneId: pid('p1'), title: `${EVIL}2` }, 5)
    await tick()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.innerHTML).not.toContain('<img')
    expect(container.querySelector('.pane-title')?.textContent).toBe(`${EVIL}2`)
    expect(container.querySelector('.ws-name')?.textContent).toContain(EVIL)
    expect((globalThis as { __pwned?: number }).__pwned).toBeUndefined()
  })

  it('el aviso de error con HTML del mensaje tampoco se interpreta', async () => {
    const { client, getByLabelText, findByRole, container } = await mountApp(
      snapshotOf([mkWorkspace('w1')]),
    )
    client.handlers.set('tab.create', () => {
      throw new Error(EVIL)
    })
    fireEvent.click(getByLabelText('Nueva pestaña'))
    await findByRole('alert')
    expect(container.querySelector('.toast img')).toBeNull()
  })

  it('nombres de 256 caracteres no rompen el diseño ni el estado', async () => {
    const name = 'W'.repeat(256)
    const { container } = await mountApp(snapshotOf([mkWorkspace('w1', [mkTab('t1')], { name })]))
    expect(container.querySelector('.ws-name')?.textContent).toBe(name)
    expect(container.querySelector('.ws-name .ellipsis')).not.toBeNull()
  })

  it('renombrar con caracteres de control o más de 256 los limpia antes de enviar', async () => {
    const { getByText, container, client } = await mountApp(
      snapshotOf([mkWorkspace('w1', [mkTab('t1')], { name: 'viejo' })]),
    )
    fireEvent.dblClick(getByText('viejo'))
    const input = container.querySelector('.sidebar input.inline-edit') as HTMLInputElement
    input.value = `a\u0000b\u001b[31m${'x'.repeat(400)}`
    fireEvent.keyDown(input, { key: 'Enter' })
    await tick()
    const params = client.callsOf('workspace.rename')[0]?.params as { name: string }
    const sent = params.name
    expect(sent.length).toBeLessThanOrEqual(256)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: se comprueba justo que no queden
    expect(sent).not.toMatch(/[\u0000-\u001f]/)
  })

  it('200 paneles en una pestaña: se pintan y solo se crean terminales de la visible', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `p${i}`)
    const { container, xterms, client } = await mountApp(
      snapshotOf([mkWorkspace('w1', [mkTab('t1', ids), mkTab('t2', ['z'])])]),
    )
    expect(container.querySelectorAll('#tabpanel-t1 [data-pane-id]')).toHaveLength(200)
    expect(xterms.size).toBe(200)
    expect([...xterms.values()].filter((x) => x.webglActive)).toHaveLength(200)
    expect(client.callsOf('terminal.spawn')).toHaveLength(200)
  })

  it('salida para paneles o terminales inexistentes se ignora sin romper', async () => {
    const tab = mkTab('t1', ['p1'])
    const ws = mkWorkspace('w1', [{ ...tab, panes: [mkPane('p1', { terminalId: xid('x1') })] }])
    const { client, frames, xterms } = await mountApp(snapshotOf([ws]))
    client.emit('terminal.output', { terminalId: xid('fantasma'), offset: 3, data: 'abc' }, 5)
    client.emit('pane.title', { paneId: pid('fantasma'), title: 'x' }, 6)
    client.emit('terminal.exit', { terminalId: xid('fantasma'), exitCode: 0, signal: null }, 7)
    expect(frames.flush()).toBeGreaterThanOrEqual(0)
    expect(xterms.get(0)?.written.join('')).toBe('')
  })

  it('eventos con seq repetido o desordenado no duplican paneles ni salidas', async () => {
    const tab = mkTab('t1', ['p1'])
    const ws = mkWorkspace('w1', [{ ...tab, panes: [mkPane('p1', { terminalId: xid('x1') })] }])
    const { client, frames, xterms, container } = await mountApp(snapshotOf([ws], 1))
    await tick()
    client.emit('terminal.output', { terminalId: xid('x1'), offset: 2, data: 'ab' }, 2)
    client.emit('terminal.output', { terminalId: xid('x1'), offset: 2, data: 'ab' }, 2) // repetido
    client.emit('terminal.output', { terminalId: xid('x1'), offset: 4, data: 'cd' }, 3)
    client.emit('terminal.output', { terminalId: xid('x1'), offset: 2, data: 'ab' }, 1) // desordenado
    frames.flush()
    expect(xterms.get(0)?.written.join('')).toBe('abcd')
    expect(container.querySelectorAll('[data-pane-id]')).toHaveLength(1)
  })

  it('ráfaga de 10 MB a un panel oculto: no bloquea y la memoria pendiente queda acotada', async () => {
    const ws = mkWorkspace('w1', [
      { ...mkTab('t1', ['p1']), panes: [mkPane('p1', { terminalId: xid('x1') })] },
      { ...mkTab('t2', ['p2']), panes: [mkPane('p2', { terminalId: xid('x2') })] },
    ])
    const { client, model, frames, xterms } = await mountApp(snapshotOf([ws]))
    await tick()
    // x2 pertenece a la pestaña oculta: aún no tiene xterm.
    expect(xterms.size).toBe(1)
    const chunk = 'y'.repeat(1024 * 1024 - 1024)
    let offset = 0
    const start = performance.now()
    for (let i = 0; i < 10; i++) {
      offset += chunk.length
      client.emit('terminal.output', { terminalId: xid('x2'), offset, data: chunk }, 10 + i)
      expect(model.hub.pendingCharsOf('x2')).toBeLessThanOrEqual(4 * 1024 * 1024)
    }
    expect(performance.now() - start).toBeLessThan(2000)
    // Sin xterm todavía: nada se escribió y los fotogramas no hacen trabajo desmedido.
    frames.flush()
    expect(model.hub.pendingCharsOf('x2')).toBeLessThanOrEqual(4 * 1024 * 1024)
  })

  it('token ausente o inválido: la interfaz no intenta conectar (pantalla informativa)', async () => {
    const { render } = await import('@solidjs/testing-library')
    const { App } = await import('./App.tsx')
    for (const reason of ['missing-token', 'invalid-token', 'invalid-port'] as const) {
      const { container, unmount } = render(() => (
        <App state={{ kind: 'no-daemon', reason, onRetry: () => {} }} />
      ))
      expect(container.querySelector('[role="alert"]')).not.toBeNull()
      unmount()
    }
  })

  it('un daemon que cierra la sesión deja la pantalla de reintento, sin lanzar', async () => {
    const client = new FakeClient()
    client.connectError = new Error('401')
    const { findByText } = await mountApp(snapshotOf([]), client)
    expect(await findByText('Reintentar')).toBeTruthy()
  })
})
