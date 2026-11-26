import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { loadMemorySettings, memorySettingsPath, saveMemorySettings } from './memory-settings.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'nexo-ms-'))
  dirs.push(d)
  return d
}

describe('ajustes de memoria guardados', () => {
  it('sin archivo no hay ajustes', async () => {
    expect(await loadMemorySettings(await tmp())).toBeUndefined()
  })

  it('guardar y leer devuelve lo mismo; sin renovación se guarda null', async () => {
    const dir = await tmp()
    await saveMemorySettings(dir, { enabled: true, renewAtTokens: 50_000 })
    expect(await loadMemorySettings(dir)).toEqual({
      version: 1,
      enabled: true,
      renewAtTokens: 50_000,
    })
    await saveMemorySettings(dir, { enabled: false, renewAtTokens: undefined })
    expect(JSON.parse(await readFile(memorySettingsPath(dir), 'utf8'))).toEqual({
      version: 1,
      enabled: false,
      renewAtTokens: null,
    })
  })

  it('propiedad: cualquier ajuste válido sobrevive al viaje de ida y vuelta', async () => {
    const dir = await tmp()
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.option(fc.integer({ min: 10_000, max: 5_000_000 }), { nil: undefined }),
        async (enabled, renewAtTokens) => {
          await saveMemorySettings(dir, { enabled, renewAtTokens })
          const read = await loadMemorySettings(dir)
          expect(read?.enabled).toBe(enabled)
          expect(read?.renewAtTokens ?? undefined).toBe(renewAtTokens)
        },
      ),
      { numRuns: 25 },
    )
  })

  it('un directorio inexistente al guardar falla', async () => {
    const dir = await tmp()
    await expect(
      saveMemorySettings(join(dir, 'no-existe'), { enabled: true, renewAtTokens: undefined }),
    ).rejects.toBeDefined()
  })
})
