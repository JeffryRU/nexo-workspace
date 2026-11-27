import { describe, expect, it } from 'vitest'
import { CompanionAssetCache } from './cache.ts'
import { fakeSource, mkPackage, stubObjectUrls } from './test-helpers.ts'

function setup(packages: Parameters<typeof fakeSource>[0], max?: number) {
  const urls = stubObjectUrls()
  const fake = fakeSource(packages)
  const cache = new CompanionAssetCache(fake.source, {
    ...(max === undefined ? {} : { maxPackages: max }),
  })
  return { urls, cache, ...fake }
}

describe('CompanionAssetCache', () => {
  it('carga el manifiesto una vez y una URL por imagen distinta', async () => {
    const { cache, calls, urls } = setup({ tiny: mkPackage('tiny') })
    const l = await cache.load('tiny')
    expect(calls.filter((c) => c.method === 'get')).toHaveLength(1)
    expect(calls.filter((c) => c.method === 'asset')).toHaveLength(4)
    expect(Object.keys(l.assets).sort()).toEqual(['error', 'idle', 'thinking', 'waiting'])
    expect(l.assets.waiting?.sheet?.frames).toBe(4)
    expect(urls.live()).toHaveLength(4)
    cache.disposeAll()
    expect(urls.live()).toHaveLength(0)
    urls.restore()
  })

  it('una segunda carga del mismo id sale de la caché y las simultáneas se comparten', async () => {
    const { cache, calls, urls } = setup({ tiny: mkPackage('tiny') })
    const [a, b] = await Promise.all([cache.load('tiny'), cache.load('tiny')])
    expect(a).toBe(b)
    await cache.load('tiny')
    expect(calls.filter((c) => c.method === 'get')).toHaveLength(1)
    expect(cache.peek('tiny')).toBe(a)
    cache.disposeAll()
    urls.restore()
  })

  it('el manifiesto de otro id se rechaza', async () => {
    const { cache, urls } = setup({ tiny: mkPackage('otra') })
    await expect(cache.load('tiny')).rejects.toThrow(/no es del compañero/)
    expect(urls.created).toHaveLength(0)
    urls.restore()
  })

  it('un fallo no se guarda: la próxima vez se vuelve a pedir', async () => {
    const pkg = mkPackage('tiny', { getFails: 'caído' })
    const { cache, calls, urls } = setup({ tiny: pkg })
    await expect(cache.load('tiny')).rejects.toThrow('caído')
    delete pkg.getFails
    await cache.load('tiny')
    expect(calls.filter((c) => c.method === 'get')).toHaveLength(2)
    cache.disposeAll()
    urls.restore()
  })

  it('un recurso que falla se omite y se anota; si fallan todos, la carga falla sin URL', async () => {
    const pkg = mkPackage('tiny')
    pkg.assets['think.png'] = { fail: 'x' }
    const { cache, urls } = setup({ tiny: pkg })
    const l = await cache.load('tiny')
    expect(l.failed).toEqual(['think.png'])
    expect(l.assets.thinking).toBeUndefined()
    expect(urls.live()).toHaveLength(3)
    cache.disposeAll()

    const all = mkPackage('tiny')
    for (const k of Object.keys(all.assets)) all.assets[k] = { fail: 'x' }
    const b = setup({ tiny: all })
    await expect(b.cache.load('tiny')).rejects.toThrow(/ninguna imagen/)
    expect(b.urls.created).toHaveLength(0)
    urls.restore()
  })

  it('mime raro, base64 corrupto y tamaño que no cuadra cuentan como recurso fallido', async () => {
    const pkg = mkPackage('tiny')
    pkg.assets['idle.png'] = { mime: 'text/html' }
    pkg.assets['think.png'] = { data: '@@@@' }
    pkg.assets['sheet.png'] = { declaredBytes: 99 }
    pkg.assets['error.svg'] = { mime: 'image/svg+xml', bytes: [60, 115] }
    const { cache, urls } = setup({ tiny: pkg })
    const l = await cache.load('tiny')
    expect(l.failed.sort()).toEqual(['idle.png', 'sheet.png', 'think.png'])
    expect(Object.keys(l.assets)).toEqual(['error'])
    cache.disposeAll()
    urls.restore()
  })

  it('un recurso vacío no cuenta', async () => {
    const pkg = mkPackage('tiny')
    pkg.assets['idle.png'] = { bytes: [], data: '' }
    const { cache, urls } = setup({ tiny: pkg })
    expect((await cache.load('tiny')).failed).toContain('idle.png')
    cache.disposeAll()
    urls.restore()
  })

  it('expulsa lo más antiguo por encima del tope pero nunca el actual', async () => {
    const { cache, urls } = setup({ a: mkPackage('a'), b: mkPackage('b'), c: mkPackage('c') }, 2)
    cache.setCurrent('a')
    await cache.load('a')
    await cache.load('b')
    await cache.load('c')
    expect(cache.peek('a')).toBeDefined()
    expect(cache.peek('b')).toBeUndefined()
    expect(cache.peek('c')).toBeDefined()
    expect(cache.size).toBe(2)
    expect(urls.live()).toHaveLength(8)
    cache.disposeAll()
    expect(urls.live()).toHaveLength(0)
    urls.restore()
  })

  it('invalidateStale olvida el que cambió de versión', async () => {
    const { cache, urls } = setup({ tiny: mkPackage('tiny') })
    await cache.load('tiny')
    expect(cache.invalidateStale([{ id: 'tiny', version: '1.0.0' }])).toEqual([])
    expect(cache.invalidateStale([{ id: 'tiny', version: '2.0.0' }])).toEqual(['tiny'])
    expect(cache.peek('tiny')).toBeUndefined()
    expect(urls.live()).toHaveLength(0)
    urls.restore()
  })
})
