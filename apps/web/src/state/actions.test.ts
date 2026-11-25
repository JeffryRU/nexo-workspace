import * as fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import { measureTabSwitch, resetTabSwitchSamples, tabSwitchSamples } from '../perf.ts'
import { FakeClient, mkTab, mkWorkspace, pid, snapshotOf, tid, wid, xid } from '../test-helpers.ts'
import { chunkText, cleanName, createActions } from './actions.ts'
import { createAppStore } from './store.ts'
import { createUiState } from './ui.ts'

function setup(open = true) {
  const client = new FakeClient()
  if (open) client.state = 'open'
  const store = createAppStore()
  store.applySnapshot(snapshotOf([mkWorkspace('w1', [mkTab('t1')]), mkWorkspace('w2')], 1))
  const ui = createUiState()
  const actions = createActions({ client: () => client, store, ui })
  return { client, store, ui, actions }
}

describe('cleanName', () => {
  it('recorta, colapsa espacios y quita controles', () => {
    expect(cleanName('  hola   mundo ')).toBe('hola mundo')
    expect(cleanName('a\u0000b\u001b[31m')).toBe('a b [31m')
    expect(cleanName('   ')).toBeUndefined()
    expect(cleanName('x'.repeat(1000))).toHaveLength(256)
  })

  it('propiedad: el resultado cumple siempre las reglas de DisplayText', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 600 }), (s) => {
        const out = cleanName(s)
        if (out === undefined) return
        expect(out.length).toBeGreaterThan(0)
        expect(out.length).toBeLessThanOrEqual(256)
        expect([...out].some((c) => (c.codePointAt(0) as number) < 0x20)).toBe(false)
      }),
    )
  })
})

describe('chunkText', () => {
  it('no parte pares sustitutos y reconstruye el texto', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', maxLength: 300 }),
        fc.integer({ min: 2, max: 20 }),
        (s, n) => {
          const parts = chunkText(s, n)
          expect(parts.join('')).toBe(s)
          for (const p of parts.slice(0, -1)) expect(/[�-�]$/.test(p)).toBe(false)
          for (const p of parts) expect(p.length).toBeLessThanOrEqual(n)
        },
      ),
    )
    expect(chunkText('', 5)).toEqual([])
  })
})

describe('acciones', () => {
  it('cada acción llama al método correcto con parámetros válidos', async () => {
    const { actions, client } = setup()
    client.handlers.set('workspace.create', () => ({ workspace: mkWorkspace('w9') }))
    await actions.newWorkspace()
    await actions.renameWorkspace(wid('w1'), 'otro')
    await actions.closeWorkspace(wid('w2'))
    await actions.newTab(wid('w1'))
    await actions.renameTab(tid('t1'), 'x')
    await actions.closeTab(tid('t1'))
    await actions.splitPane(pid('p'), 'row')
    await actions.closePane(pid('p'))
    await actions.resizeDivider(tid('t1'), [0], 1, 5)
    await actions.resizeDivider(tid('t1'), [], 0, Number.NaN)
    await actions.resizeDivider(tid('t1'), [], 0, 0)
    await actions.swapPanes(pid('a'), pid('a'))
    await actions.swapPanes(pid('a'), pid('b'))
    await actions.resizeTerminal(xid('x'), 80, 24)
    await actions.write(xid('x'), 'a'.repeat(40_000))
    expect(client.calls.map((c) => c.method)).toEqual([
      'workspace.create',
      'tab.create',
      'workspace.rename',
      'workspace.close',
      'tab.create',
      'tab.rename',
      'tab.close',
      'pane.split',
      'pane.close',
      'pane.resize',
      'pane.swap',
      'terminal.resize',
      'terminal.write',
      'terminal.write',
      'terminal.write',
    ])
    expect(client.callsOf('pane.resize')[0]?.params).toEqual({
      tabId: 't1',
      path: [0],
      index: 1,
      delta: 1,
    })
  })

  it('newTab sin espacios no hace nada y spawn no se repite mientras está en curso', async () => {
    const { client, store } = setup()
    store.reset()
    const ui = createUiState()
    const actions = createActions({ client: () => client, store, ui })
    await actions.newTab()
    expect(client.calls).toHaveLength(0)
    let release!: () => void
    client.handlers.set(
      'terminal.spawn',
      () => new Promise((r) => (release = () => r({ terminalId: 'x' }))),
    )
    const a = actions.spawn(pid('p1'), 80, 24)
    const b = actions.spawn(pid('p1'), 80, 24)
    release()
    await Promise.all([a, b])
    expect(client.callsOf('terminal.spawn')).toHaveLength(1)
  })

  it('selectTab y focusPane son optimistas', async () => {
    const { actions, store, client } = setup()
    store.applySnapshot(snapshotOf([mkWorkspace('w1', [mkTab('t1', ['a', 'b']), mkTab('t2')])], 2))
    const p = actions.selectTab(wid('w1'), tid('t2'))
    expect(store.state.workspaces[0]?.activeTabId).toBe('t2')
    await p
    const f = actions.focusPane(pid('b'))
    expect(store.state.workspaces[0]?.tabs[0]?.focusedPaneId).toBe('b')
    await f
    await actions.focusPane(pid('b')) // ya enfocado: no repite la llamada
    await actions.focusPane(pid('no-existe'))
    expect(client.callsOf('pane.focus')).toHaveLength(1)
    actions.selectWorkspace(wid('w1'))
  })

  it('un error del daemon se muestra y no se propaga', async () => {
    const { actions, client, ui } = setup()
    client.handlers.set('tab.close', () => {
      throw new Error('no existe')
    })
    await expect(actions.closeTab(tid('t1'))).resolves.toBeUndefined()
    expect(ui.error()).toContain('no existe')
    ui.dismissError()
    expect(ui.error()).toBeUndefined()
  })

  it('sin cliente (reconectando) las acciones no hacen nada ni fallan', async () => {
    const store = createAppStore()
    const actions = createActions({ client: () => undefined, store, ui: createUiState() })
    await expect(actions.closeTab(tid('t1'))).resolves.toBeUndefined()
  })
})

describe('measureTabSwitch', () => {
  it('registra la marca y la medida (al terminar el fotograma) y acota las muestras', async () => {
    await new Promise((r) => setTimeout(r, 100)) // muestras pendientes de pruebas anteriores
    resetTabSwitchSamples()
    const ms = measureTabSwitch(() => {})
    expect(typeof ms).toBe('number')
    await vi.waitFor(() => expect(tabSwitchSamples()).toHaveLength(1))
    for (let i = 0; i < 250; i++) measureTabSwitch(() => {})
    await vi.waitFor(() => expect(globalThis.__NEXO_PERF__?.tabSwitchRaw.length).toBe(200))
    expect(tabSwitchSamples().length).toBeLessThanOrEqual(200)
    await new Promise((r) => setTimeout(r, 100))
  })

  it('con requestAnimationFrame, la muestra llega tras el fotograma y suma el trabajo de pintado', async () => {
    resetTabSwitchSamples()
    const original = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      setTimeout(() => cb(0), 5)
      return 1
    }
    try {
      const sync = measureTabSwitch(() => {})
      expect(typeof sync).toBe('number')
      expect(tabSwitchSamples()).toHaveLength(0)
      await vi.waitFor(() => expect(tabSwitchSamples()).toHaveLength(1))
      const raw = globalThis.__NEXO_PERF__?.tabSwitchRaw[0] ?? 0
      // `raw` incluye la espera hasta el fotograma (5 ms simulados); `tabSwitch` no.
      expect(raw).toBeGreaterThanOrEqual(4)
      expect(tabSwitchSamples()[0] ?? Number.POSITIVE_INFINITY).toBeLessThan(raw)
    } finally {
      globalThis.requestAnimationFrame = original
    }
  })

  it('ejecuta fn aunque no exista performance', () => {
    const original = globalThis.performance
    Object.defineProperty(globalThis, 'performance', { value: undefined, configurable: true })
    let ran = false
    expect(measureTabSwitch(() => (ran = true))).toBeUndefined()
    Object.defineProperty(globalThis, 'performance', { value: original, configurable: true })
    expect(ran).toBe(true)
  })
})
