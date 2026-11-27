import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isValidVersion,
  listTargets,
  readRootVersion,
  syncVersions,
  // @ts-expect-error módulo .mjs sin tipos; tools/ no entra en ningún tsconfig
} from '../version/sync-version.mjs'

const REPO = join(import.meta.dirname, '..', '..')
const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

/** Un árbol mínimo con todos los archivos que llevan versión. */
async function miniTree(version = '1.2.3'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'Nexo ver ñ '))
  dirs.push(root)
  const put = async (rel: string, text: string) => {
    await mkdir(join(root, rel, '..'), { recursive: true })
    await writeFile(join(root, rel), text)
  }
  const pkg = (name: string) =>
    `{\n  "name": "${name}",\n  "version": "${version}",\n  "private": true\n}\n`
  await put('package.json', pkg('nexo'))
  await put('apps/desktop/package.json', pkg('@nexo/desktop'))
  await put('apps/daemon/package.json', pkg('@nexo/daemon'))
  await put('packages/core/package.json', pkg('@nexo/core'))
  await put('packages/adapters/pty/package.json', pkg('@nexo/pty'))
  await put('e2e/package.json', pkg('@nexo/e2e'))
  await put(
    'apps/desktop/src-tauri/Cargo.toml',
    `[package]\nname = "nexo-desktop"\nversion = "${version}"\nedition = "2021"\n\n[dependencies]\nserde = { version = "1" }\n`,
  )
  await put(
    'apps/desktop/src-tauri/Cargo.lock',
    `[[package]]\nname = "libc"\nversion = "0.2.1"\n\n[[package]]\nname = "nexo-desktop"\nversion = "${version}"\n`,
  )
  await put(
    'apps/desktop/src-tauri/tauri.conf.json',
    `{\n  "productName": "N",\n  "version": "${version}"\n}\n`,
  )
  await put('apps/daemon/src/version.ts', `export const DAEMON_VERSION = '${version}'\n`)
  await put('apps/cli/src/version.ts', `export const CLI_VERSION = '${version}'\n`)
  return root
}

describe('versión única', () => {
  it('todo el repositorio lleva la versión de package.json (arreglar con `node tools/version/sync-version.mjs --write`)', async () => {
    expect(await syncVersions({ root: REPO })).toEqual([])
  })

  it('cubre todos los package.json del espacio de trabajo y los archivos de Tauri', async () => {
    const files = (await listTargets(REPO)).map(([rel]: [string]) => rel)
    for (const f of [
      'apps/desktop/package.json',
      'apps/desktop/src-tauri/Cargo.toml',
      'apps/desktop/src-tauri/Cargo.lock',
      'apps/desktop/src-tauri/tauri.conf.json',
      'apps/daemon/src/version.ts',
      'apps/cli/src/version.ts',
      'e2e/package.json',
    ]) {
      expect(files).toContain(f)
    }
    expect(files.some((f: string) => f.startsWith('packages/core/'))).toBe(true)
  })

  it('un árbol coherente no tiene desajustes', async () => {
    expect(await syncVersions({ root: await miniTree() })).toEqual([])
  })

  it('detecta cada archivo desalineado y --write los corrige sin tocar lo demás', async () => {
    const root = await miniTree('1.2.3')
    await writeFile(
      join(root, 'apps/desktop/src-tauri/tauri.conf.json'),
      '{\n  "productName": "N",\n  "version": "9.9.9"\n}\n',
    )
    await writeFile(join(root, 'apps/cli/src/version.ts'), "export const CLI_VERSION = '0.0.1'\n")
    const found = await syncVersions({ root })
    expect(found.map((p: { file: string }) => p.file).sort()).toEqual([
      'apps/cli/src/version.ts',
      'apps/desktop/src-tauri/tauri.conf.json',
    ])
    await syncVersions({ root, write: true })
    expect(await syncVersions({ root })).toEqual([])
    const cargo = await readFile(join(root, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8')
    expect(cargo).toContain('serde = { version = "1" }')
  })

  it('--set cambia la raíz y todo lo demás; Cargo.lock solo cambia nexo-desktop', async () => {
    const root = await miniTree('1.2.3')
    await syncVersions({ root, write: true, version: '2.0.0-rc.1' })
    expect(await readRootVersion(root)).toBe('2.0.0-rc.1')
    expect(await syncVersions({ root })).toEqual([])
    const lock = await readFile(join(root, 'apps/desktop/src-tauri/Cargo.lock'), 'utf8')
    expect(lock).toContain('name = "libc"\nversion = "0.2.1"')
    expect(lock).toContain('name = "nexo-desktop"\nversion = "2.0.0-rc.1"')
  })

  it('un archivo sin versión se reporta, no revienta', async () => {
    const root = await miniTree()
    await writeFile(join(root, 'apps/daemon/src/version.ts'), 'export {}\n')
    const found = await syncVersions({ root })
    expect(found).toEqual([
      { file: 'apps/daemon/src/version.ts', found: undefined, wanted: '1.2.3' },
    ])
    await expect(syncVersions({ root, write: true })).rejects.toThrow(/no se pudo escribir/)
  })

  it('rechaza versiones que no son semver (hostiles incluidas)', async () => {
    for (const bad of [
      '',
      '1',
      '1.2',
      '01.2.3',
      'v1.2.3',
      '1.2.3\n',
      '1.2.3"; rm -rf /',
      '1.2.3-',
      'x'.repeat(5000),
      'a.b.c',
    ]) {
      expect(isValidVersion(bad)).toBe(false)
    }
    for (const ok of ['0.0.0', '1.2.3', '10.20.30-beta.1', '1.0.0-rc.1'])
      expect(isValidVersion(ok)).toBe(true)
    const root = await miniTree()
    await expect(syncVersions({ root, write: true, version: '1.2' })).rejects.toThrow(/no válida/)
    expect(await syncVersions({ root })).toEqual([])
  })

  it('una raíz con versión inválida falla con un mensaje claro', async () => {
    const root = await miniTree('abc')
    await expect(readRootVersion(root)).rejects.toThrow(/semver/)
  })

  it('un package.json de la raíz copiado de verdad se puede usar como árbol (rutas con espacios y no ASCII)', async () => {
    const root = await miniTree()
    const copy = await mkdtemp(join(tmpdir(), 'Nexo copia ñ '))
    dirs.push(copy)
    await cp(root, copy, { recursive: true })
    expect(await syncVersions({ root: copy })).toEqual([])
  })
})
