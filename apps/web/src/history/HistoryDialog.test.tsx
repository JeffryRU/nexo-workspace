import { fireEvent } from '@solidjs/testing-library'
import { describe, expect, it } from 'vitest'
import { settle } from '../agent/test-helpers.ts'
import {
  hblock,
  historyDialog,
  hs,
  mountHistory,
  openHistory,
  textBlock,
  userBlock,
} from './test-helpers.ts'

const q = <T extends HTMLElement>(root: HTMLElement, sel: string) => root.querySelector<T>(sel)
const all = (root: HTMLElement, sel: string) => [...root.querySelectorAll<HTMLElement>(sel)]
const button = (root: HTMLElement, name: string | RegExp) =>
  all(root, 'button').find((b) =>
    typeof name === 'string' ? b.textContent?.trim() === name : name.test(b.textContent ?? ''),
  ) as HTMLButtonElement

describe('historial: lista', () => {
  it('no existe hasta abrirlo; el botón de la barra lo abre y Escape lo cierra', async () => {
    const h = await mountHistory()
    expect(historyDialog(h)).toBeNull()
    await openHistory(h)
    const d = historyDialog(h)
    expect(d.getAttribute('role')).toBe('dialog')
    expect(d.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(d)
    fireEvent.keyDown(d, { key: 'Escape' })
    expect(historyDialog(h)).toBeNull()
  })

  it('agrupa por carpeta con el nombre del proyecto y las sesiones en orden', async () => {
    const h = await mountHistory()
    await openHistory(h)
    const groups = all(historyDialog(h), '.history-project')
    expect(groups.map((g) => g.querySelector('h3')?.textContent)).toEqual([
      expect.stringContaining('app'),
      expect.stringContaining('otra'),
    ])
    expect(
      all(groups[0] as HTMLElement, '.history-session-title').map((e) => e.textContent),
    ).toEqual(['Sesión 1', 'Sesión 2'])
    expect(groups[0]?.textContent).toContain('Proveedor falso')
    expect(groups[0]?.textContent).toContain('1 mensaje(s)')
  })

  it('el filtro de proveedor lo pide al daemon', async () => {
    const h = await mountHistory({
      sessions: [hs(1), hs(2, { provider: 'codex' })],
    })
    await openHistory(h)
    const select = q<HTMLSelectElement>(historyDialog(h), 'select') as HTMLSelectElement
    expect(all(select, 'option').map((o) => o.textContent)).toEqual([
      'Todos los proveedores',
      'Proveedor falso',
      'Codex falso',
    ])
    fireEvent.change(select, { target: { value: 'codex' } })
    await settle(10)
    expect(h.client.callsOf('history.list').at(-1)?.params).toMatchObject({ provider: 'codex' })
    expect(all(historyDialog(h), '.history-session')).toHaveLength(1)
    expect(historyDialog(h).textContent).toContain('Sesión 2')
  })

  it('la búsqueda filtra lo cargado por título o carpeta, sin acentos ni mayúsculas', async () => {
    const h = await mountHistory({
      sessions: [
        hs(1, { title: 'Corregir ÁRBOL' }),
        hs(2, { title: 'Otra cosa' }),
        hs(3, { cwd: '/x/arbol-lab', title: 'Z' }),
      ],
    })
    await openHistory(h)
    const input = q<HTMLInputElement>(historyDialog(h), 'input[type="search"]') as HTMLInputElement
    fireEvent.input(input, { target: { value: 'arbol' } })
    await settle(2)
    expect(all(historyDialog(h), '.history-session-title').map((e) => e.textContent)).toEqual([
      'Corregir ÁRBOL',
      'Z',
    ])
    fireEvent.input(input, { target: { value: 'no existe' } })
    await settle(2)
    expect(historyDialog(h).textContent).toContain('Ninguna sesión coincide con la búsqueda.')
  })

  it('pagina de forma incremental con «Cargar más» y junta la carpeta partida', async () => {
    const sessions = [1, 2, 3, 4, 5].map((n) => hs(n))
    const h = await mountHistory({ sessions, pageSize: 2 })
    await openHistory(h)
    expect(all(historyDialog(h), '.history-session')).toHaveLength(2)
    for (const expected of [4, 5]) {
      fireEvent.click(button(historyDialog(h), 'Cargar más'))
      await settle(10)
      expect(all(historyDialog(h), '.history-session')).toHaveLength(expected)
    }
    expect(button(historyDialog(h), 'Cargar más')).toBeUndefined()
    expect(all(historyDialog(h), '.history-project')).toHaveLength(1)
    expect(
      h.client.callsOf('history.list').map((c) => (c.params as { cursor?: string }).cursor),
    ).toEqual([undefined, 'c2', 'c4'])
  })

  it('avisa del estado de cada proveedor que no listó bien', async () => {
    const h = await mountHistory({
      sessions: [hs(1)],
      statuses: [
        { provider: 'fake', status: 'ok' },
        { provider: 'codex', status: 'unsupported' },
        { provider: 'gemini', status: 'unavailable', reason: 'no instalado' },
        { provider: 'claude', status: 'timeout' },
        { provider: 'ollama', status: 'error', reason: 'falló' },
      ],
    })
    await openHistory(h)
    const notices = all(historyDialog(h), '.history-notice').map((n) => n.textContent)
    expect(notices).toEqual([
      'Codex falso no tiene historial.',
      'gemini no está disponible: no instalado.',
      'claude no respondió a tiempo.',
      'ollama falló al listar: falló.',
    ])
  })

  it('sin sesiones: mensaje de vacío; con error del daemon: aviso y reintentar', async () => {
    const empty = await mountHistory({ sessions: [] })
    await openHistory(empty)
    expect(historyDialog(empty).textContent).toContain('No hay sesiones anteriores.')
    empty.unmount()

    const failing = await mountHistory({ listFails: 'sin red' })
    await openHistory(failing)
    expect(q(historyDialog(failing), '[role="alert"]')?.textContent).toContain('sin red')
    failing.history.listFails = undefined
    fireEvent.click(button(historyDialog(failing), 'Reintentar'))
    await settle(10)
    expect(all(historyDialog(failing), '.history-session').length).toBeGreaterThan(0)
  })

  it('deshabilita ver y reanudar si el proveedor no lo permite', async () => {
    const h = await mountHistory({
      sessions: [hs(1, { readable: false, resumable: false }), hs(2)],
    })
    await openHistory(h)
    const [first, second] = all(historyDialog(h), '.history-session')
    expect(button(first as HTMLElement, 'Ver').disabled).toBe(true)
    expect(button(first as HTMLElement, 'Reanudar en una pestaña').disabled).toBe(true)
    expect(button(second as HTMLElement, 'Ver').disabled).toBe(false)
  })
})

describe('historial: reanudar', () => {
  it('abre una pestaña con un panel de agente y crea la sesión con resume y la carpeta', async () => {
    const h = await mountHistory({ sessions: [hs(1, { sessionId: 'abc-123', cwd: '/work/app' })] })
    await openHistory(h)
    fireEvent.click(button(historyDialog(h), 'Reanudar en una pestaña'))
    await settle(10)
    expect(h.client.callsOf('tab.create')).toHaveLength(1)
    expect(h.client.callsOf('pane.split').at(-1)?.params).toMatchObject({ kind: 'agent' })
    expect(h.client.callsOf('agent.create').at(-1)?.params).toEqual({
      paneId: 'p-agent',
      provider: 'fake',
      resume: 'abc-123',
      cwd: '/work/app',
    })
    // Fue bien: la ventana se cierra.
    expect(historyDialog(h)).toBeNull()
  })

  it('si el daemon rechaza reanudar, la ventana sigue abierta y se avisa', async () => {
    const h = await mountHistory({
      sessions: [hs(1)],
      setup: (c) =>
        c.handlers.set('agent.create', () => {
          throw new Error('ya no existe')
        }),
    })
    await openHistory(h)
    fireEvent.click(button(historyDialog(h), 'Reanudar en una pestaña'))
    await settle(10)
    expect(historyDialog(h)).not.toBeNull()
    expect(h.container.textContent).toContain('ya no existe')
  })
})

describe('historial: sesión antigua de solo lectura', () => {
  const transcript = {
    'sesion-000001': [
      userBlock(0, 'hola **mundo**'),
      textBlock(1, 'Respuesta con `código` y [archivo](src/a.ts)'),
      hblock(2, {
        type: 'action',
        kind: 'edit',
        status: 'ok',
        tool: 'Edit',
        title: 'Editar',
        path: '/work/app/src/a.ts',
      }),
      hblock(3, {
        type: 'permission',
        tool: 'Bash',
        title: 'Ejecutar rm',
        state: 'pending',
        options: [{ id: 'o1', label: 'Permitir', kind: 'allow-once' }],
      }),
    ],
  }

  it('pinta los bloques con el render del panel, sin redactor ni acciones que muten', async () => {
    const h = await mountHistory({ sessions: [hs(1)], transcripts: transcript })
    await openHistory(h)
    fireEvent.click(button(historyDialog(h), 'Ver'))
    await settle(10)
    const d = historyDialog(h)
    expect(d.textContent).toContain('Solo lectura')
    expect(h.client.callsOf('history.read').at(-1)?.params).toMatchObject({
      provider: 'fake',
      sessionId: 'sesion-000001',
      cwd: '/work/app',
    })
    expect(all(d, '.blk').map((b) => b.dataset.blockType)).toEqual([
      'user',
      'text',
      'action',
      'permission',
    ])
    expect(q(d, '.blk-text strong, .blk-text code')).not.toBeNull()
    // No hay redactor y el permiso pendiente no se puede responder.
    expect(q(d, 'textarea')).toBeNull()
    const options = all(d, '.perm-option') as HTMLButtonElement[]
    expect(options.length).toBeGreaterThan(0)
    expect(options.every((o) => o.disabled)).toBe(true)
    fireEvent.click(options[0] as HTMLButtonElement)
    await settle(3)
    expect(h.client.callsOf('agent.respond')).toHaveLength(0)
    expect(h.client.callsOf('agent.send')).toHaveLength(0)
  })

  it('un enlace de archivo cierra la ventana y abre el visor', async () => {
    const h = await mountHistory({ sessions: [hs(1)], transcripts: transcript })
    await openHistory(h)
    fireEvent.click(button(historyDialog(h), 'Ver'))
    await settle(10)
    const link = all(historyDialog(h), 'button.md-file-link')[0] as HTMLElement
    expect(link).toBeDefined()
    fireEvent.click(link)
    await settle(10)
    expect(historyDialog(h)).toBeNull()
    const call = h.client.callsOf('viewer.open').at(-1) ?? h.client.callsOf('pane.split').at(-1)
    expect(JSON.stringify(call?.params)).toContain('/work/app/src/a.ts')
  })

  it('reanudar desde la sesión y volver con el botón o con Escape', async () => {
    const h = await mountHistory({ sessions: [hs(1)], transcripts: transcript })
    await openHistory(h)
    fireEvent.click(button(historyDialog(h), 'Ver'))
    await settle(10)
    fireEvent.keyDown(historyDialog(h), { key: 'Escape' })
    expect(historyDialog(h)).not.toBeNull()
    expect(all(historyDialog(h), '.history-session').length).toBeGreaterThan(0)
    fireEvent.click(button(historyDialog(h), 'Ver'))
    await settle(10)
    fireEvent.click(button(historyDialog(h), /Volver a la lista/))
    expect(all(historyDialog(h), '.history-session').length).toBeGreaterThan(0)
    fireEvent.click(button(historyDialog(h), 'Ver'))
    await settle(10)
    fireEvent.click(button(historyDialog(h), 'Reanudar en una pestaña'))
    await settle(10)
    expect(h.client.callsOf('agent.create').at(-1)?.params).toMatchObject({
      resume: 'sesion-000001',
    })
  })

  it('pagina los bloques y avisa del total', async () => {
    const many = Array.from({ length: 5 }, (_, i) => userBlock(i, `mensaje ${i}`))
    const h = await mountHistory({
      sessions: [hs(1)],
      transcripts: { 'sesion-000001': many },
      blocksPage: 2,
    })
    await openHistory(h)
    fireEvent.click(button(historyDialog(h), 'Ver'))
    await settle(10)
    expect(all(historyDialog(h), '.blk')).toHaveLength(2)
    expect(historyDialog(h).textContent).toContain('2 de 5 bloques')
    fireEvent.click(button(historyDialog(h), 'Cargar más bloques'))
    await settle(10)
    expect(all(historyDialog(h), '.blk')).toHaveLength(4)
    fireEvent.click(button(historyDialog(h), 'Cargar más bloques'))
    await settle(10)
    expect(all(historyDialog(h), '.blk')).toHaveLength(5)
    expect(button(historyDialog(h), 'Cargar más bloques')).toBeUndefined()
  })

  it('error de lectura y sesión vacía se explican', async () => {
    const h = await mountHistory({ sessions: [hs(1)], readFails: 'sesión corrupta' })
    await openHistory(h)
    fireEvent.click(button(historyDialog(h), 'Ver'))
    await settle(10)
    expect(q(historyDialog(h), '[role="alert"]')?.textContent).toContain('sesión corrupta')
    h.history.readFails = undefined
    fireEvent.click(button(historyDialog(h), 'Reintentar'))
    await settle(10)
    expect(historyDialog(h).textContent).toContain('La sesión no tiene contenido.')
  })
})
