import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collect,
  installerName,
  mergeSums,
  sumsLine,
  // @ts-expect-error módulo .mjs sin tipos; tools/ no entra en ningún tsconfig
} from '../package/collect-installers.mjs'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'Nexo inst ñ '))
  dirs.push(d)
  return d
}
const H = (c: string) => c.repeat(64)
const opts = (root: string) => ({
  bundleDir: root,
  outDir: join(root, 'o'),
  platform: 'linux',
  version: '1.2.3',
})

describe('nombres de los instaladores', () => {
  it('quita los espacios y fija sistema y arquitectura', () => {
    expect(installerName('Nexo Workspace_1.2.3_amd64.deb', '1.2.3', 'linux')).toBe(
      'nexo-workspace_1.2.3_linux_x64.deb',
    )
    expect(installerName('Nexo Workspace_1.2.3_amd64.AppImage', '1.2.3', 'linux')).toBe(
      'nexo-workspace_1.2.3_linux_x64.AppImage',
    )
    expect(installerName('Nexo Workspace_1.2.3_x64-setup.exe', '1.2.3', 'windows')).toBe(
      'nexo-workspace_1.2.3_windows_x64-setup.exe',
    )
    expect(installerName('Nexo Workspace_1.2.3_x64_en-US.msi', '1.2.3', 'windows')).toBe(
      'nexo-workspace_1.2.3_windows_x64.msi',
    )
  })

  it('ignora lo que no es un instalador de esa plataforma', () => {
    expect(installerName('Nexo.exe', '1.2.3', 'windows')).toBeUndefined()
    expect(installerName('x.deb', '1.2.3', 'windows')).toBeUndefined()
    expect(installerName('x.msi', '1.2.3', 'linux')).toBeUndefined()
    expect(installerName('x.rpm', '1.2.3', 'linux')).toBeUndefined()
  })

  it('rechaza versiones hostiles (no llegan a un nombre de archivo)', () => {
    for (const bad of ['', '../1.0.0', '1.0', '1.0.0 evil', '1.0.0/..', '1.0.0\n']) {
      expect(() => installerName('x.deb', bad, 'linux')).toThrow()
    }
  })
})

describe('sumas SHA-256', () => {
  it('formato de sha256sum y nombres sin separadores', () => {
    expect(sumsLine(H('a'), 'x.deb')).toBe(`${H('a')}  x.deb`)
    expect(() => sumsLine('zz', 'x')).toThrow()
    expect(() => sumsLine(H('a'), '../x')).toThrow()
    expect(() => sumsLine(H('a'), 'x y')).toThrow()
    expect(() => sumsLine(H('a'), 'a\\b')).toThrow()
  })

  it('une varios archivos, ordenados y sin duplicados', () => {
    const merged = mergeSums([`${H('b')}  b.deb\n`, `${H('a')}  a.msi\r\n${H('b')}  b.deb\n\n`])
    expect(merged).toBe(`${H('a')}  a.msi\n${H('b')}  b.deb\n`)
  })

  it('falla con líneas mal formadas o sumas contradictorias', () => {
    expect(() => mergeSums(['no es una suma'])).toThrow(/mal formada/)
    expect(() => mergeSums([`${H('a')} x.deb`])).toThrow(/mal formada/)
    expect(() => mergeSums([`${H('a')}  ../x`])).toThrow(/mal formada/)
    expect(() => mergeSums([`${H('a')}  x.deb`, `${H('b')}  x.deb`])).toThrow(/distintas/)
  })
})

describe('collect', () => {
  it('copia con nombre estable y escribe las sumas que coinciden con los bytes', async () => {
    const root = await tmp()
    const bundle = join(root, 'bundle')
    await mkdir(join(bundle, 'deb'), { recursive: true })
    await mkdir(join(bundle, 'appimage'), { recursive: true })
    await writeFile(join(bundle, 'deb', 'Nexo Workspace_1.2.3_amd64.deb'), 'deb!')
    await writeFile(join(bundle, 'appimage', 'Nexo Workspace_1.2.3_amd64.AppImage'), 'appimage!')
    await writeFile(join(bundle, 'appimage', 'notas.txt'), 'no')
    const out = join(root, 'out ñ')
    const names = await collect({
      bundleDir: bundle,
      outDir: out,
      platform: 'linux',
      version: '1.2.3',
    })
    expect(names).toEqual([
      'nexo-workspace_1.2.3_linux_x64.AppImage',
      'nexo-workspace_1.2.3_linux_x64.deb',
    ])
    const sums = await readFile(join(out, 'SHA256SUMS-linux.txt'), 'utf8')
    const deb = createHash('sha256').update('deb!').digest('hex')
    expect(sums).toContain(`${deb}  nexo-workspace_1.2.3_linux_x64.deb`)
    expect(sums).not.toContain('notas')
  })

  it('sin instaladores o con uno vacío falla (no publica un release hueco)', async () => {
    const root = await tmp()
    await expect(collect(opts(root))).rejects.toThrow(/no hay instaladores/)
    await writeFile(join(root, 'x_amd64.deb'), '')
    await expect(collect(opts(root))).rejects.toThrow(/vacío/)
  })

  it('dos instaladores que acaban con el mismo nombre se rechazan', async () => {
    const root = await tmp()
    await mkdir(join(root, 'a'))
    await mkdir(join(root, 'b'))
    await writeFile(join(root, 'a', 'one.deb'), 'x')
    await writeFile(join(root, 'b', 'two.deb'), 'y')
    await expect(collect(opts(root))).rejects.toThrow(/dos instaladores/)
  })
})
