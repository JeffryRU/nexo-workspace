import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error módulo .mjs sin tipos; tools/ no entra en ningún tsconfig
import { writeLaunchers } from '../package/build-bundle.mjs'
import {
  archiveName,
  extractZipEntry,
  loadPinned,
  parseShasums,
  provisionNode,
  sha256Hex,
  verifyArchive,
  // @ts-expect-error módulo .mjs sin tipos
} from '../package/node-runtime.mjs'
// @ts-expect-error módulo .mjs sin tipos
import { verifyBundle } from '../package/verify-bundle.mjs'
import { makeZip, miniBundle } from './package-helpers.ts'

const dirs: string[] = []
async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'Nexo pkg ñ '))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('node-runtime', () => {
  it('los hashes fijados del repositorio son válidos y cubren Linux y Windows', async () => {
    const pinned = await loadPinned()
    for (const [platform, arch] of [
      ['linux', 'x64'],
      ['linux', 'arm64'],
      ['win32', 'x64'],
      ['win32', 'arm64'],
    ]) {
      expect(pinned.files[archiveName(pinned.version, platform, arch)]).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(pinned.version.split('.')[0]).toBe('24')
  })

  it('archiveName elige el archivo oficial', () => {
    expect(archiveName('24.1.0', 'linux', 'x64')).toBe('node-v24.1.0-linux-x64.tar.xz')
    expect(archiveName('24.1.0', 'win32', 'arm64')).toBe('node-v24.1.0-win-arm64.zip')
    expect(() => archiveName('24.1.0', 'darwin', 'x64')).toThrow(/plataforma/)
    expect(() => archiveName('24.1.0', 'linux', 'ia32')).toThrow(/arquitectura/)
  })

  it('parseShasums lee SHASUMS256.txt', () => {
    const h = 'a'.repeat(64)
    const map = parseShasums(`${h}  node-v1-win-x64.zip\r\n${h} *otro.tar.xz\nbasura\n`)
    expect(map.get('node-v1-win-x64.zip')).toBe(h)
    expect(map.get('otro.tar.xz')).toBe(h)
    expect(map.size).toBe(2)
  })

  it('verifyArchive acepta el hash fijado y rechaza el resto', () => {
    const data = Buffer.from('contenido')
    const pinned = { version: '1.0.0', files: { 'a.zip': sha256Hex(data) } }
    expect(() => verifyArchive(data, 'a.zip', pinned)).not.toThrow()
    expect(() => verifyArchive(Buffer.from('otro'), 'a.zip', pinned)).toThrow(/no coincide/)
    expect(() => verifyArchive(data, 'b.zip', pinned)).toThrow(/no hay hash fijado/)
  })

  it('extractZipEntry lee entradas almacenadas y comprimidas', () => {
    const exe = Buffer.from('MZ-falso-node'.repeat(100))
    const zip = makeZip([
      { name: 'node-v1-win-x64/README.md', data: Buffer.from('hola') },
      { name: 'node-v1-win-x64/node.exe', data: exe, deflate: true },
    ])
    expect(extractZipEntry(zip, (n: string) => n.endsWith('node.exe')).equals(exe)).toBe(true)
    const stored = makeZip([{ name: 'node.exe', data: exe }])
    expect(extractZipEntry(stored, (n: string) => n === 'node.exe').equals(exe)).toBe(true)
  })

  it('provisionNode (Windows) verifica, cruza con SHASUMS256.txt y deja node.exe', async () => {
    const exe = Buffer.from('node-falso')
    const zip = makeZip([{ name: 'node-v9.9.9-win-x64/node.exe', data: exe, deflate: true }])
    const name = 'node-v9.9.9-win-x64.zip'
    const pinned = { version: '9.9.9', files: { [name]: sha256Hex(zip) } }
    const served: string[] = []
    const fetchImpl = async (url: string) => {
      served.push(url)
      const body = url.endsWith('SHASUMS256.txt')
        ? Buffer.from(`${sha256Hex(zip)}  ${name}\n`)
        : zip
      return { ok: true, status: 200, arrayBuffer: async () => body }
    }
    const root = await tmp()
    const result = await provisionNode({
      platform: 'win32',
      arch: 'x64',
      destDir: join(root, 'destino ñ'),
      cacheDir: join(root, 'cache'),
      pinned,
      fetchImpl,
      baseUrl: 'https://ejemplo.invalid/dist',
    })
    expect((await readFile(result.path)).equals(exe)).toBe(true)
    expect(result.archiveSha256).toBe(sha256Hex(zip))
    expect(served[0]).toBe(`https://ejemplo.invalid/dist/v9.9.9/${name}`)
    // Segunda vez: el archivo sale de la caché (solo se baja SHASUMS256.txt).
    served.length = 0
    await provisionNode({
      platform: 'win32',
      arch: 'x64',
      destDir: join(root, 'destino ñ'),
      cacheDir: join(root, 'cache'),
      pinned,
      fetchImpl,
      baseUrl: 'https://ejemplo.invalid/dist',
    })
    expect(served).toEqual(['https://ejemplo.invalid/dist/v9.9.9/SHASUMS256.txt'])
  })
})

describe('paquete: lanzadores', () => {
  it('nexo sigue enlaces simbólicos y usa el Node empaquetado; nexo.cmd es CRLF y usa %~dp0', async () => {
    const out = await tmp()
    await writeLaunchers(out)
    const sh = await readFile(join(out, 'bin', 'nexo'), 'utf8')
    expect(sh.startsWith('#!/bin/sh\n')).toBe(true)
    expect(sh).toContain('readlink')
    expect(sh).toContain('exec "$root/node/node" "$root/cli/nexo.mjs" "$@"')
    const cmd = await readFile(join(out, 'bin', 'nexo.cmd'), 'utf8')
    expect(cmd).toContain('"%~dp0..\\node\\node.exe" "%~dp0..\\cli\\nexo.mjs" %*')
    expect(cmd.split('\n').every((l) => l === '' || l.endsWith('\r'))).toBe(true)
    expect(await readFile(join(out, 'bin', 'nexo-mcp'), 'utf8')).toContain('mcp/nexo-mcp.mjs')
    if (process.platform !== 'win32') {
      expect((await stat(join(out, 'bin', 'nexo'))).mode & 0o111).not.toBe(0)
    }
  })
})

describe('verifyBundle', () => {
  it('acepta un paquete íntegro', async () => {
    const { dir, pinned } = await miniBundle(dirs)
    const manifest = await verifyBundle(dir, { pinned })
    expect(Object.keys(manifest.files)).toContain('daemon/daemon.mjs')
  })
})
