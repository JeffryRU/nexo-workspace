import { fireEvent } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settle } from '../agent/test-helpers.ts'
import { SETTINGS_KEY } from '../state/settings.ts'
import { type CompanionHarness, mkPackage, mountCompanion, stubObjectUrls } from './test-helpers.ts'

let urls: ReturnType<typeof stubObjectUrls>
beforeEach(() => {
  urls = stubObjectUrls()
})
afterEach(() => {
  urls.restore()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const dialog = (h: CompanionHarness) =>
  h.container.querySelector<HTMLElement>('.companion-dialog') as HTMLElement
const radios = (h: CompanionHarness) => [
  ...dialog(h).querySelectorAll<HTMLInputElement>('input[type="radio"]'),
]

describe('mascota: sin mascota', () => {
  it('por omisión no hay nada dibujado y no se piden recursos', async () => {
    const h = await mountCompanion({ selected: null })
    expect(h.dock()).toBeNull()
    expect(h.client.callsOf('companion.get')).toHaveLength(0)
    expect(urls.created).toHaveLength(0)
  })

  it('el selector tiene «Sin mascota» primero y marcada', async () => {
    const h = await mountCompanion({ selected: null })
    await h.open()
    const d = dialog(h)
    expect(d.getAttribute('role')).toBe('dialog')
    expect(document.activeElement).toBe(d)
    const [none, tiny] = radios(h)
    expect(none?.checked).toBe(true)
    expect(tiny?.checked).toBe(false)
    expect(d.querySelector('.companion-choice')?.textContent).toContain('Sin mascota')
    fireEvent.keyDown(d, { key: 'Escape' })
    expect(h.container.querySelector('.companion-dialog')).toBeNull()
  })
})

describe('mascota: dibujo', () => {
  it('dibuja la imagen del estado como <img> con una URL de objeto y un nombre accesible', async () => {
    const h = await mountCompanion()
    const img = h.img() as HTMLImageElement
    expect(img.tagName).toBe('IMG')
    expect(img.getAttribute('src')).toMatch(/^blob:/)
    expect(img.alt).toBe('Tiny: en reposo')
    expect(h.dock()?.getAttribute('aria-label')).toBe('Mascota')
    expect(h.dock()?.querySelector('[aria-live="polite"]')?.textContent).toBe(
      'La mascota Tiny está: en reposo',
    )
    // Nunca se incrusta: ni <svg>, ni <object>, ni <iframe>, ni <embed>.
    expect(h.dock()?.querySelector('svg, object, iframe, embed')).toBeNull()
  })

  it('pide el manifiesto una vez y un recurso por cada imagen distinta', async () => {
    const h = await mountCompanion()
    expect(h.client.callsOf('companion.get')).toHaveLength(1)
    const paths = h.client
      .callsOf('companion.asset')
      .map((c) => (c.params as { path: string }).path)
    expect(paths.sort()).toEqual(['error.svg', 'idle.png', 'sheet.png', 'think.png'])
  })

  it('reacciona a companion.state y cada estado dibuja su imagen', async () => {
    const h = await mountCompanion()
    const idle = h.img()?.getAttribute('src')
    h.emit({ state: 'thinking', since: 2 * 1_700_000_000_000 })
    await settle()
    expect(h.dock()?.dataset.state).toBe('thinking')
    expect(h.img()?.getAttribute('src')).not.toBe(idle)
    expect(h.img()?.alt).toBe('Tiny: pensando')
    h.emit({ state: 'error', since: 3 * 1_700_000_000_000 })
    await settle()
    expect(h.dock()?.dataset.state).toBe('error')
    expect(h.img()?.alt).toBe('Tiny: hubo un error')
    // No hace falta volver a pedir nada al cambiar de estado.
    expect(h.client.callsOf('companion.asset')).toHaveLength(4)
  })

  it('un estado sin imagen en el manifiesto usa idle', async () => {
    const h = await mountCompanion()
    const idle = h.img()?.getAttribute('src')
    h.emit({ state: 'done', since: 2 * 1_700_000_000_000 })
    await settle()
    expect(h.dock()?.dataset.requestedState).toBe('done')
    expect(h.dock()?.dataset.state).toBe('idle')
    expect(h.img()?.getAttribute('src')).toBe(idle)
    expect(h.img()?.alt).toBe('Tiny: terminó')
  })

  it('si falla el recurso de un estado usa idle', async () => {
    const pkg = mkPackage('tiny')
    pkg.assets['think.png'] = { fail: 'se perdió' }
    const h = await mountCompanion({ packages: { tiny: pkg }, state: 'thinking' })
    expect(h.dock()?.dataset.requestedState).toBe('thinking')
    expect(h.dock()?.dataset.state).toBe('idle')
    expect(h.img()).not.toBeNull()
  })

  it('si el navegador no puede decodificar la imagen de un estado, cae a idle', async () => {
    const h = await mountCompanion({ state: 'thinking' })
    expect(h.dock()?.dataset.state).toBe('thinking')
    fireEvent.error(h.img() as HTMLImageElement)
    await settle()
    expect(h.dock()?.dataset.state).toBe('idle')
    // Si tampoco idle se decodifica, no se muestra nada roto.
    fireEvent.error(h.img() as HTMLImageElement)
    await settle()
    expect(h.dock()).toBeNull()
  })

  it('si falla todo no se muestra nada y el selector lo dice', async () => {
    const pkg = mkPackage('tiny')
    for (const k of Object.keys(pkg.assets)) pkg.assets[k] = { fail: 'x' }
    const h = await mountCompanion({ packages: { tiny: pkg } })
    expect(h.dock()).toBeNull()
    expect(urls.created).toHaveLength(0)
    await h.open()
    expect(dialog(h).textContent).toContain('No se pudieron leer las imágenes')
  })

  it('una mascota borrada en disco (companion.get falla) no rompe la interfaz', async () => {
    const h = await mountCompanion({ packages: {}, selected: 'tiny' })
    expect(h.dock()).toBeNull()
    expect(h.container.querySelector('.statusbar')).not.toBeNull()
    await h.open()
    expect(radios(h)).toHaveLength(1)
  })

  it('sin idle válido pero con otro estado: se dibuja ese y no otros', async () => {
    const pkg = mkPackage('tiny')
    pkg.assets['idle.png'] = { fail: 'x' }
    const h = await mountCompanion({ packages: { tiny: pkg }, state: 'idle' })
    expect(h.dock()).toBeNull()
    h.emit({ state: 'thinking', since: 2 * 1_700_000_000_000 })
    await settle()
    expect(h.dock()?.dataset.state).toBe('thinking')
  })
})

describe('mascota: hoja de sprites y reduced-motion', () => {
  it('anima la hoja y se detiene con prefers-reduced-motion', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const h = await mountCompanion({ state: 'waiting' })
    const sheet = () => h.dock()?.querySelector<HTMLElement>('.companion-sheet') as HTMLElement
    expect(sheet().dataset.frame).toBe('0')
    expect(sheet().querySelector('img')?.style.transform).toContain('scale(12)')
    vi.advanceTimersByTime(110)
    expect(sheet().dataset.frame).toBe('1')
    expect(sheet().querySelector('img')?.style.transform).toContain('translate(-8px')
    vi.advanceTimersByTime(1000)
    expect(Number(sheet().dataset.frame)).toBeLessThan(4)
  })

  it('con prefers-reduced-motion el primer cuadro queda fijo', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('reduce'),
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    const h = await mountCompanion({ state: 'waiting' })
    vi.advanceTimersByTime(5000)
    expect(h.dock()?.querySelector<HTMLElement>('.companion-sheet')?.dataset.frame).toBe('0')
  })

  it('el SVG también va en un <img>', async () => {
    const h = await mountCompanion({ state: 'error' })
    expect(h.img()?.getAttribute('src')).toMatch(/^blob:/)
    expect(h.dock()?.querySelector('svg')).toBeNull()
  })
})

describe('mascota: elegir y ocultar', () => {
  it('elegir otra llama a companion.select y la dibuja; «sin mascota» la quita', async () => {
    const other = mkPackage('otra')
    const h = await mountCompanion({
      packages: { tiny: mkPackage('tiny'), otra: other },
      selected: null,
    })
    await h.open()
    expect(radios(h)[0]?.checked).toBe(true)
    fireEvent.click(radios(h)[2] as HTMLInputElement)
    await settle(15)
    expect(h.client.callsOf('companion.select').at(-1)?.params).toEqual({ id: 'otra' })
    expect(h.dock()?.dataset.companion).toBe('otra')
    expect(radios(h)[2]?.checked).toBe(true)
    fireEvent.click(radios(h)[1] as HTMLInputElement)
    await settle(15)
    expect(h.dock()?.dataset.companion).toBe('tiny')
    fireEvent.click(radios(h)[0] as HTMLInputElement)
    await settle(15)
    expect(h.client.callsOf('companion.select').at(-1)?.params).toEqual({ id: null })
    expect(h.dock()).toBeNull()
  })

  it('si el daemon rechaza la elección lo dice y no cambia nada', async () => {
    const h = await mountCompanion({ selected: null })
    h.client.handlers.set('companion.select', () => {
      throw new Error('NOT_FOUND: ya no existe')
    })
    await h.open()
    fireEvent.click(radios(h)[1] as HTMLInputElement)
    await settle(15)
    expect(dialog(h).querySelector('[role="alert"]')?.textContent).toContain('ya no existe')
    expect(h.dock()).toBeNull()
  })

  it('lista los paquetes no válidos como texto plano', async () => {
    const h = await mountCompanion({
      selected: null,
      invalid: [{ id: 'roto', reason: '<img src=x onerror="globalThis.__p=1">' }],
    })
    await h.open()
    expect(dialog(h).querySelector('.companion-invalid')?.textContent).toContain('<img src=x')
    expect(dialog(h).querySelector('.companion-invalid img')).toBeNull()
  })

  it('ocultar (botón de la mascota o interruptor) la quita, se persiste y no pierde la elegida', async () => {
    const data = new Map<string, string>()
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    }
    const h = await mountCompanion({ storage })
    const hide = h.dock()?.querySelector<HTMLButtonElement>('.companion-hide')
    expect(hide?.getAttribute('aria-label')).toBe('Ocultar la mascota')
    hide?.click()
    await settle()
    expect(h.dock()).toBeNull()
    expect(JSON.parse(data.get(SETTINGS_KEY) as string).companionHidden).toBe(true)
    await h.open()
    const show = dialog(h).querySelector<HTMLInputElement>('.companion-show input')
    expect(show?.checked).toBe(false)
    expect(radios(h)[1]?.checked).toBe(true)
    fireEvent.click(show as HTMLInputElement)
    await settle()
    expect(h.dock()).not.toBeNull()
    expect(JSON.parse(data.get(SETTINGS_KEY) as string).companionHidden).toBe(false)
  })

  it('un ajuste guardado como oculto arranca oculto', async () => {
    const storage = {
      getItem: () => '{"notifications":false,"companionHidden":true}',
      setItem: () => {},
    }
    const h = await mountCompanion({ storage })
    expect(h.dock()).toBeNull()
  })
})

describe('mascota: no tapa nada', () => {
  it('vive en su propia columna junto a la barra lateral, no sobre pestañas, paneles ni barra de estado', async () => {
    const h = await mountCompanion()
    const dock = h.dock() as HTMLElement
    expect(dock.parentElement?.classList.contains('side-column')).toBe(true)
    expect(dock.parentElement?.querySelector('.sidebar')).not.toBeNull()
    expect(dock.closest('.main')).toBeNull()
    expect(dock.querySelector('.companion-art')).not.toBeNull()
  })
})

describe('mascota: limpieza', () => {
  it('al desmontar se revocan todas las URL de objeto', async () => {
    const h = await mountCompanion()
    expect(urls.live().length).toBeGreaterThan(0)
    h.unmount()
    expect(urls.live()).toEqual([])
  })

  it('al reconectar se vuelven a cargar los recursos sin dejar las viejas', async () => {
    const h = await mountCompanion()
    const before = urls.created.length
    h.client.setState('closed')
    await settle()
    h.client.setState('open')
    await settle(20)
    expect(urls.created.length).toBeGreaterThan(before)
    expect(h.dock()).not.toBeNull()
    h.unmount()
    expect(urls.live()).toEqual([])
  })
})
