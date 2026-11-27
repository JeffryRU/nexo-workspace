import { LIMITS } from '@nexo/contracts'
import { CompanionError, type CompanionPort } from '@nexo/core'
import { afterEach, describe, expect, it } from 'vitest'
import { encodeUtf8 } from '../bytes.ts'
import { type CompanionFiles, tinyCompanion, tinyPng } from '../companion-package.ts'

export type CompanionConformanceSubject = {
  port: CompanionPort
  /** Crea o reemplaza el paquete `id` con estos archivos (ruta relativa con `/` -> bytes). */
  put(id: string, files: CompanionFiles): Promise<void>
  cleanup?: () => Promise<void> | void
}

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof CompanionError) return error.code
    throw error
  }
  return 'OK'
}

const withManifest = (id: string, patch: Record<string, unknown>): CompanionFiles =>
  tinyCompanion({ id, manifest: patch })

/**
 * Suite de conformidad de `CompanionPort`: la ejecutan el falso (testkit) y `companion-fs`. Cubre el contrato común
 * (listado, validación del paquete, recursos declarados, imágenes de verdad, SVG seguro, topes); lo propio del disco
 * (enlaces simbólicos, carreras, nombres de Windows) va en las pruebas adversariales del adaptador.
 */
export function runCompanionConformance(
  name: string,
  create: () => Promise<CompanionConformanceSubject> | CompanionConformanceSubject,
): void {
  describe(`CompanionPort conformance: ${name}`, () => {
    let subject: CompanionConformanceSubject
    afterEach(async () => {
      await subject?.cleanup?.()
    })
    const setup = async () => {
      subject = await create()
      return subject
    }

    it('sin paquetes: lista vacía', async () => {
      const s = await setup()
      expect(await s.port.list()).toEqual({ companions: [], invalid: [] })
    })

    it('lista un paquete válido con su resumen', async () => {
      const s = await setup()
      await s.put('tiny', tinyCompanion())
      const { companions, invalid } = await s.port.list()
      expect(invalid).toEqual([])
      expect(companions).toEqual([
        {
          id: 'tiny',
          name: 'Tiny',
          version: '1.0.0',
          license: 'CC0-1.0',
          author: 'Nexo',
          description: 'Paquete de prueba',
        },
      ])
    })

    it('get describe manifiesto y recursos con su tipo y tamaño', async () => {
      const s = await setup()
      const files = tinyCompanion()
      await s.put('tiny', files)
      const detail = await s.port.get('tiny')
      expect(detail.manifest.id).toBe('tiny')
      expect(detail.assets.map((a) => [a.path, a.mime]).sort()).toEqual(
        [
          ['done.webp', 'image/webp'],
          ['error.svg', 'image/svg+xml'],
          ['idle.png', 'image/png'],
          ['img/think.gif', 'image/gif'],
          ['sheet.png', 'image/png'],
        ].sort(),
      )
      const total = detail.assets.reduce((n, a) => n + a.bytes, 0)
      expect(detail.totalBytes).toBe(total)
      expect(detail.assets.find((a) => a.path === 'idle.png')?.bytes).toBe(
        files['idle.png']?.length,
      )
    })

    it('readAsset devuelve los bytes exactos y el tipo', async () => {
      const s = await setup()
      const files = tinyCompanion()
      await s.put('tiny', files)
      const asset = await s.port.readAsset('tiny', 'img/think.gif')
      expect(asset.mime).toBe('image/gif')
      expect([...asset.bytes]).toEqual([...(files['img/think.gif'] as Uint8Array)])
    })

    it('un paquete inexistente es NOT_FOUND', async () => {
      const s = await setup()
      expect(await failure(s.port.get('nada'))).toBe('NOT_FOUND')
      expect(await failure(s.port.readAsset('nada', 'idle.png'))).toBe('NOT_FOUND')
      expect(await failure(s.port.get('../fuera'))).toBe('NOT_FOUND')
    })

    it('un recurso que el manifiesto no declara no se sirve', async () => {
      const s = await setup()
      await s.put('tiny', { ...tinyCompanion(), 'extra.png': tinyPng() })
      expect(await failure(s.port.readAsset('tiny', 'extra.png'))).toBe('NOT_FOUND')
      expect(await failure(s.port.readAsset('tiny', 'companion.json'))).toBe('INVALID')
    })

    it('rutas hostiles de recurso se rechazan', async () => {
      const s = await setup()
      await s.put('tiny', tinyCompanion())
      for (const path of [
        '../x.png',
        '/etc/passwd.png',
        'C:/a.png',
        '\\\\srv\\s\\a.png',
        'a\\b.png',
        'a/../idle.png',
        'idle.png:stream',
        'nul.png',
        'idle.png\u0000',
      ]) {
        expect(['INVALID', 'NOT_FOUND'], path).toContain(
          await failure(s.port.readAsset('tiny', path)),
        )
      }
    })

    it('manifiesto malformado: el paquete sale en invalid y get es INVALID', async () => {
      const s = await setup()
      await s.put('roto', { 'companion.json': encodeUtf8('{no es json') })
      await s.put('vacio', { 'companion.json': encodeUtf8('{}') })
      await s.put('sin-manifiesto', { 'idle.png': tinyPng() })
      const { companions, invalid } = await s.port.list()
      expect(companions).toEqual([])
      expect(invalid.map((i) => i.id).sort()).toEqual(['roto', 'sin-manifiesto', 'vacio'])
      for (const i of invalid) expect(i.reason.length).toBeGreaterThan(0)
      expect(await failure(s.port.get('roto'))).toBe('INVALID')
    })

    it('el id del manifiesto debe coincidir con la carpeta', async () => {
      const s = await setup()
      await s.put('uno', withManifest('otro', {}))
      expect(await failure(s.port.get('uno'))).toBe('INVALID')
    })

    it('un recurso que no es una imagen, aunque se llame .png, no vale', async () => {
      const s = await setup()
      await s.put('tiny', {
        ...tinyCompanion(),
        'idle.png': encodeUtf8('<html>no soy un png</html>'),
      })
      expect(await failure(s.port.get('tiny'))).toBe('INVALID')
      expect(await failure(s.port.readAsset('tiny', 'idle.png'))).toBe('INVALID')
    })

    it('la extensión debe coincidir con el tipo real de la imagen', async () => {
      const s = await setup()
      await s.put('tiny', {
        ...tinyCompanion(),
        'idle.png': tinyCompanion()['img/think.gif'] as Uint8Array,
      })
      expect(await failure(s.port.readAsset('tiny', 'idle.png'))).toBe('INVALID')
    })

    it('un SVG con script o referencias externas se rechaza', async () => {
      const s = await setup()
      const bad = [
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>',
        '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>',
      ]
      for (const svg of bad) {
        await s.put('tiny', { ...tinyCompanion(), 'error.svg': encodeUtf8(svg) })
        expect(await failure(s.port.readAsset('tiny', 'error.svg')), svg).toBe('INVALID')
      }
    })

    it('un recurso enorme se rechaza (TOO_LARGE)', async () => {
      const s = await setup()
      const huge = new Uint8Array(LIMITS.maxCompanionAssetBytes + 1)
      huge.set(tinyPng())
      await s.put('tiny', { ...tinyCompanion(), 'idle.png': huge })
      expect(await failure(s.port.get('tiny'))).toBe('TOO_LARGE')
      expect(await failure(s.port.readAsset('tiny', 'idle.png'))).toBe('TOO_LARGE')
      const { companions, invalid } = await s.port.list()
      expect(companions).toEqual([])
      expect(invalid.map((i) => i.id)).toEqual(['tiny'])
    })

    it('una hoja de sprites que no cabe en la imagen se rechaza', async () => {
      const s = await setup()
      await s.put(
        'tiny',
        withManifest('tiny', {
          states: {
            idle: { src: 'sheet.png', sheet: { frameWidth: 8, frameHeight: 8, frames: 4, fps: 4 } },
          },
        }),
      )
      expect(await failure(s.port.get('tiny'))).toBe('INVALID')
    })

    it('un paquete roto no impide listar los demás', async () => {
      const s = await setup()
      await s.put('bueno', tinyCompanion({ id: 'bueno' }))
      await s.put('malo', { 'companion.json': encodeUtf8('[]') })
      const { companions, invalid } = await s.port.list()
      expect(companions.map((c) => c.id)).toEqual(['bueno'])
      expect(invalid.map((i) => i.id)).toEqual(['malo'])
    })

    it('un id de carpeta que no es un id válido sale como no válido', async () => {
      const s = await setup()
      await s.put('Mayusculas', tinyCompanion({ id: 'x' }))
      const { companions, invalid } = await s.port.list()
      expect(companions).toEqual([])
      expect(invalid.map((i) => i.id)).toEqual(['Mayusculas'])
    })
  })
}
