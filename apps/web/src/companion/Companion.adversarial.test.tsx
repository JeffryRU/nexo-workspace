import { fireEvent } from '@solidjs/testing-library'
import * as fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { settle } from '../agent/test-helpers.ts'
import { CompanionAssetCache } from './cache.ts'
import { fakeSource, mkPackage, mountCompanion, stubObjectUrls } from './test-helpers.ts'

let urls: ReturnType<typeof stubObjectUrls>
beforeEach(() => {
  urls = stubObjectUrls()
})
afterEach(() => urls.restore())

const SINCE = 1_700_000_000_000

function gate() {
  let open!: () => void
  const promise = new Promise<void>((r) => {
    open = r
  })
  return { promise, open }
}

describe('mascota (adversarial): carreras', () => {
  it('cambiar de mascota rápido: gana la última y nunca se dibuja la imagen de la anterior', async () => {
    const slow = gate()
    const a = mkPackage('a', { gate: slow.promise })
    const b = mkPackage('b')
    const h = await mountCompanion({ packages: { a, b }, selected: null })
    await h.open()
    const radios = () => [
      ...h.container.querySelectorAll<HTMLInputElement>('.companion-dialog input[type="radio"]'),
    ]
    const seen: string[] = []
    const watch = new MutationObserver(() => {
      const d = h.dock()
      if (d !== null) seen.push(d.dataset.companion ?? '')
    })
    watch.observe(h.container, { subtree: true, childList: true, attributes: true })

    fireEvent.click(radios()[1] as HTMLInputElement) // a (se queda esperando)
    await settle(10)
    h.view.selected = 'b'
    h.emit({ selected: 'b' }) // el daemon ya dice b
    await settle(15)
    expect(h.dock()?.dataset.companion).toBe('b')
    slow.open() // la carga vieja termina tarde
    await settle(20)
    watch.disconnect()
    expect(h.dock()?.dataset.companion).toBe('b')
    expect(seen).not.toContain('a')
  })

  it('eventos fuera de orden o repetidos no cambian lo dibujado ni repintan', async () => {
    const h = await mountCompanion()
    h.emit({ state: 'thinking', since: SINCE + 20 })
    await settle()
    const img = h.img()
    h.emit({ state: 'thinking', since: SINCE + 20 }) // repetido
    h.emit({ state: 'error', since: SINCE + 10 }) // más viejo
    await settle()
    expect(h.dock()?.dataset.state).toBe('thinking')
    expect(h.img()).toBe(img)
  })

  it('eventos basura no rompen nada', async () => {
    const h = await mountCompanion()
    for (const junk of [
      null,
      undefined,
      5,
      'x',
      {},
      { state: 'dormido', since: 1, selected: null },
      [],
    ]) {
      h.client.emit('companion.state', junk)
    }
    await settle()
    expect(h.dock()?.dataset.state).toBe('idle')
  })

  it('una avalancha de 500 cambios de estado deja la mascota coherente y sin fugas', async () => {
    const h = await mountCompanion()
    const states = ['thinking', 'waiting', 'busy', 'done', 'error', 'idle'] as const
    for (let i = 1; i <= 500; i++)
      h.emit({ state: states[i % states.length] as 'idle', since: SINCE + i })
    await settle(20)
    expect(h.dock()?.dataset.requestedState).toBe(states[500 % states.length])
    expect(urls.created).toHaveLength(4)
    h.unmount()
    expect(urls.live()).toEqual([])
  })

  it('elegir mientras otra elección está en curso se ignora (no hay dos select a la vez)', async () => {
    const h = await mountCompanion({
      packages: { a: mkPackage('a'), b: mkPackage('b') },
      selected: null,
    })
    const g = gate()
    h.client.handlers.set('companion.select', async (p) => {
      await g.promise
      return { selected: (p as { id: string | null }).id }
    })
    await h.open()
    const radios = [
      ...h.container.querySelectorAll<HTMLInputElement>('.companion-dialog input[type="radio"]'),
    ]
    fireEvent.click(radios[1] as HTMLInputElement)
    await settle()
    fireEvent.click(radios[2] as HTMLInputElement)
    await settle()
    expect(h.client.callsOf('companion.select')).toHaveLength(1)
    g.open()
    await settle(15)
  })

  it('el estado que llega antes que la respuesta de la consulta inicial gana', async () => {
    const g = gate()
    const h = await mountCompanion({ selected: null })
    h.client.handlers.set('companion.state', async () => {
      await g.promise
      return { state: 'idle', since: SINCE, selected: null }
    })
    h.client.setState('closed')
    await settle()
    h.client.setState('open')
    await settle()
    h.emit({ state: 'thinking', since: SINCE + 5, selected: 'tiny' })
    await settle(15)
    g.open() // la consulta vieja ("sin mascota") llega tarde
    await settle(15)
    expect(h.dock()?.dataset.companion).toBe('tiny')
  })
})

describe('mascota (adversarial): recursos hostiles', () => {
  it('un paquete cuyo manifiesto es de otro id no se dibuja', async () => {
    const h = await mountCompanion({ packages: { tiny: mkPackage('otra') } })
    expect(h.dock()).toBeNull()
    expect(urls.created).toHaveLength(0)
  })

  it('base64 corrupto, mime raro y tamaños que no cuadran en todos los recursos: nada roto', async () => {
    const pkg = mkPackage('tiny')
    pkg.assets['idle.png'] = { data: 'no es base64!' }
    pkg.assets['think.png'] = { mime: 'text/html' }
    pkg.assets['sheet.png'] = { declaredBytes: 1 }
    pkg.assets['error.svg'] = { mime: 'application/javascript' }
    const h = await mountCompanion({ packages: { tiny: pkg } })
    expect(h.dock()).toBeNull()
    expect(urls.created).toHaveLength(0)
  })

  it('texto hostil del paquete (nombre, autor) se pinta como texto, no como HTML', async () => {
    const pkg = mkPackage('tiny')
    pkg.manifest = { ...pkg.manifest, name: '<img src=x onerror=alert(1)>' }
    const h = await mountCompanion({ packages: { tiny: pkg } })
    await h.open()
    expect(h.container.querySelector('.companion-dialog img')).toBeNull()
    expect(h.container.querySelector('.companion-dialog')?.textContent).toContain('<img src=x')
    expect(h.img()?.alt).toContain('<img src=x')
    expect(h.container.querySelectorAll('.companion-dock img')).toHaveLength(1)
  })
})

describe('mascota (adversarial): fugas de URL de objeto', () => {
  it('cargas descartadas a mitad no llegan a crear ninguna URL', async () => {
    const g = gate()
    const pkg = mkPackage('tiny')
    pkg.assets['idle.png'] = { gate: g.promise }
    const { source } = fakeSource({ tiny: pkg })
    const cache = new CompanionAssetCache(source)
    const p = cache.load('tiny')
    p.catch(() => {})
    await settle(3)
    cache.forget('tiny')
    g.open()
    await expect(p).rejects.toThrow(/descartado/)
    expect(urls.created).toHaveLength(0)
    const q = cache.load('tiny')
    cache.disposeAll()
    await expect(q).rejects.toThrow(/descartado/)
    expect(urls.live()).toEqual([])
  })

  it('propiedad: tras cualquier secuencia de cargas, olvidos y expulsiones no queda ninguna URL viva', async () => {
    const ids = ['a', 'b', 'c', 'd'] as const
    const op = fc.oneof(
      fc.record({ k: fc.constant('load' as const), id: fc.constantFrom(...ids) }),
      fc.record({ k: fc.constant('forget' as const), id: fc.constantFrom(...ids) }),
      fc.record({ k: fc.constant('current' as const), id: fc.constantFrom(...ids) }),
      fc.record({ k: fc.constant('stale' as const), id: fc.constantFrom(...ids) }),
    )
    await fc.assert(
      fc.asyncProperty(
        fc.array(op, { maxLength: 25 }),
        fc.integer({ min: 1, max: 3 }),
        async (ops, max) => {
          const local = stubObjectUrls()
          try {
            const { source } = fakeSource(Object.fromEntries(ids.map((i) => [i, mkPackage(i)])))
            const cache = new CompanionAssetCache(source, { maxPackages: max })
            const pending: Promise<unknown>[] = []
            for (const o of ops) {
              if (o.k === 'load') pending.push(cache.load(o.id).catch(() => {}))
              else if (o.k === 'forget') cache.forget(o.id)
              else if (o.k === 'current') cache.setCurrent(o.id)
              else cache.invalidateStale([{ id: o.id, version: '9.9.9' }])
              await Promise.resolve()
            }
            await Promise.all(pending)
            if (cache.liveUrls !== local.live().length) return false
            cache.disposeAll()
            return local.live().length === 0 && cache.liveUrls === 0 && cache.size === 0
          } finally {
            local.restore()
          }
        },
      ),
      { numRuns: 60 },
    )
  })
})
