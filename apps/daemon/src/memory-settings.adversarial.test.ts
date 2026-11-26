import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadMemorySettings, memorySettingsPath } from './memory-settings.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function load(content: string) {
  const dir = await mkdtemp(join(tmpdir(), 'nexo-msa-'))
  dirs.push(dir)
  await writeFile(memorySettingsPath(dir), content)
  const invalid: string[] = []
  const settings = await loadMemorySettings(dir, (r) => invalid.push(r))
  return { settings, invalid }
}

describe('ajustes de memoria guardados: archivos hostiles', () => {
  const hostile = [
    '',
    'no es json',
    '{"version":1,',
    '[]',
    'null',
    '{"version":2,"enabled":true}',
    '{"version":1,"enabled":"true"}',
    '{"version":1,"enabled":true,"extra":1}',
    '{"version":1,"renewAtTokens":5}',
    '{"version":1,"renewAtTokens":1e30}',
    '{"__proto__":{"enabled":true},"version":1}',
    `{"version":1,"enabled":true,"x":"${'a'.repeat(10_000)}"}`,
  ]
  for (const content of hostile) {
    it(`se ignora: ${content.slice(0, 40)}`, async () => {
      const { settings, invalid } = await load(content)
      expect(settings).toBeUndefined()
      expect(invalid).toHaveLength(1)
    })
  }

  it('un archivo válido con la renovación a null se lee tal cual', async () => {
    const { settings } = await load('{"version":1,"enabled":false,"renewAtTokens":null}')
    expect(settings).toEqual({ version: 1, enabled: false, renewAtTokens: null })
  })
})
