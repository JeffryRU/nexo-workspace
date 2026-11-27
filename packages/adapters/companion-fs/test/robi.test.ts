import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LIMITS } from '@nexo/contracts'
import { describe, expect, it } from 'vitest'
import { createFsCompanionPort } from '../src/index.ts'

/** Robi, la mascota de ejemplo (`examples/companions/robi`), cargada con el cargador real. */
const EXAMPLES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../examples/companions')
const port = createFsCompanionPort({ dir: EXAMPLES })
const STATES = ['idle', 'thinking', 'busy', 'waiting', 'done', 'error'] as const

describe('Robi (ejemplo)', () => {
  it('aparece como paquete válido y su manifiesto pasa el cargador', async () => {
    const { companions, invalid } = await port.list()
    expect(invalid).toEqual([])
    expect(companions.map((c) => c.id)).toContain('robi')
    const detail = await port.get('robi')
    expect(detail.manifest.license).toBe('CC0-1.0')
    expect(detail.totalBytes).toBeLessThan(LIMITS.maxCompanionPackageBytes)
    for (const asset of detail.assets) {
      expect(asset.mime).toBe('image/svg+xml')
      expect(asset.bytes).toBeLessThanOrEqual(LIMITS.maxCompanionAssetBytes)
    }
  })

  it('declara los seis estados, cada uno con su propio dibujo', async () => {
    const { manifest } = await port.get('robi')
    expect(Object.keys(manifest.states).sort()).toEqual([...STATES].sort())
    const sources = STATES.map((s) => manifest.states[s]?.src)
    expect(new Set(sources).size).toBe(STATES.length)
    const contents = await Promise.all(
      STATES.map(async (s) => (await port.readAsset('robi', `${s}.svg`)).bytes.join(',')),
    )
    expect(new Set(contents).size).toBe(STATES.length)
  })

  it('cada recurso se entrega como SVG y coincide con el archivo del repositorio', async () => {
    for (const state of STATES) {
      const asset = await port.readAsset('robi', `${state}.svg`)
      expect(asset.mime).toBe('image/svg+xml')
      const onDisk = await readFile(join(EXAMPLES, 'robi', `${state}.svg`))
      expect(Buffer.from(asset.bytes).equals(onDisk)).toBe(true)
    }
  })

  it('lleva la licencia CC0 en una carpeta propia', async () => {
    const text = await readFile(join(EXAMPLES, 'robi', 'LICENSE'), 'utf8')
    expect(text).toContain('CC0 1.0')
  })

  it('un archivo que no declara el manifiesto no se sirve', async () => {
    await expect(port.readAsset('robi', 'LICENSE')).rejects.toThrow()
  })
})
