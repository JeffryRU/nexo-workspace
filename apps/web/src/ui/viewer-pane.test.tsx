import { describe, expect, it } from 'vitest'
import { mountApp } from '../test-app.tsx'
import { mkPane, mkTab, mkWorkspace, snapshotOf } from '../test-helpers.ts'

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('panel viewer en la web', () => {
  it('muestra un marcador con la ruta y no abre una terminal', async () => {
    const tab = mkTab('t1', ['p1'])
    tab.panes = [mkPane('p1', { kind: 'viewer', title: 'LEEME.md', viewerPath: '/work/LEEME.md' })]
    const app = await mountApp(snapshotOf([mkWorkspace('w1', [tab])]))
    await tick()
    const holder = app.container.querySelector('[data-testid="viewer-placeholder"]')
    expect(holder?.textContent).toContain('/work/LEEME.md')
    expect(app.container.querySelector('.terminal-host, .xterm')).toBeNull()
    expect(app.xterms.size).toBe(0)
  })

  it('un visor sin archivo ni título usa los textos por omisión', async () => {
    const tab = mkTab('t1', ['p1'])
    tab.panes = [mkPane('p1', { kind: 'viewer', title: 'Visor' })]
    const app = await mountApp(snapshotOf([mkWorkspace('w1', [tab])]))
    await tick()
    expect(
      app.container.querySelector('[data-testid="viewer-placeholder"]')?.textContent,
    ).toContain('Sin archivo')
  })

  it('una ruta hostil se pinta como texto, no como HTML', async () => {
    const tab = mkTab('t1', ['p1'])
    const evil = '/work/<img src=x onerror=alert(1)>.md'
    tab.panes = [mkPane('p1', { kind: 'viewer', title: 'x', viewerPath: evil })]
    const app = await mountApp(snapshotOf([mkWorkspace('w1', [tab])]))
    await tick()
    expect(app.container.querySelector('[data-testid="viewer-placeholder"] img')).toBeNull()
    expect(app.container.querySelector('.viewer-path')?.textContent).toBe(evil)
  })
})
