import { appendFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  extractZipEntry,
  provisionNode,
  sha256Hex,
  verifyArchive,
  // @ts-expect-error módulo .mjs sin tipos; tools/ no entra en ningún tsconfig
} from '../package/node-runtime.mjs'
// @ts-expect-error módulo .mjs sin tipos
import { verifyBundle, writeManifest } from '../package/verify-bundle.mjs'
import { makeZip, miniBundle } from './package-helpers.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('Node con hash distinto', () => {
  const name = 'node-v9.9.9-win-x64.zip'
  const real = makeZip([{ name: 'node-v9.9.9-win-x64/node.exe', data: Buffer.from('bueno') }])
  const pinned = { version: '9.9.9', files: { [name]: sha256Hex(real) } }

  async function run(download: Buffer, shasums: string) {
    const root = await mkdtemp(join(tmpdir(), 'Nexo adv ñ '))
    dirs.push(root)
    const fetchImpl = async (url: string) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => (url.endsWith('SHASUMS256.txt') ? Buffer.from(shasums) : download),
    })
    return {
      root,
      promise: provisionNode({
        platform: 'win32',
        arch: 'x64',
        destDir: join(root, 'node'),
        cacheDir: join(root, 'cache'),
        pinned,
        fetchImpl,
        baseUrl: 'https://ejemplo.invalid/dist',
      }),
    }
  }

  it('un archivo manipulado se rechaza y no deja nada instalado ni en caché', async () => {
    const tampered = Buffer.from(real)
    tampered[40] = (tampered[40] ?? 0) ^ 0xff
    const { root, promise } = await run(tampered, `${sha256Hex(tampered)}  ${name}\n`)
    await expect(promise).rejects.toThrow(/no coincide/)
    await expect(readFile(join(root, 'node', 'node.exe'))).rejects.toThrow()
    await expect(readFile(join(root, 'cache', name))).rejects.toThrow()
  })

  it('aunque el archivo coincida con lo fijado, un SHASUMS256.txt que lo contradice aborta', async () => {
    const { promise } = await run(real, `${'0'.repeat(64)}  ${name}\n`)
    await expect(promise).rejects.toThrow(/SHASUMS256/)
  })

  it('un SHASUMS256.txt sin la entrada aborta', async () => {
    const { promise } = await run(real, 'basura\n')
    await expect(promise).rejects.toThrow(/SHASUMS256/)
  })

  it('una caché envenenada se descarta y se vuelve a bajar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'Nexo adv ñ '))
    dirs.push(root)
    await mkdir(join(root, 'cache'))
    await writeFile(join(root, 'cache', name), 'envenenado')
    const fetchImpl = async (url: string) => ({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        url.endsWith('SHASUMS256.txt') ? Buffer.from(`${sha256Hex(real)}  ${name}\n`) : real,
    })
    const result = await provisionNode({
      platform: 'win32',
      arch: 'x64',
      destDir: join(root, 'node'),
      cacheDir: join(root, 'cache'),
      pinned,
      fetchImpl,
      baseUrl: 'https://ejemplo.invalid/dist',
    })
    expect((await readFile(result.path)).toString()).toBe('bueno')
  })

  it('un fallo de red (404) aborta con un mensaje claro', async () => {
    const root = await mkdtemp(join(tmpdir(), 'Nexo adv ñ '))
    dirs.push(root)
    await expect(
      provisionNode({
        platform: 'win32',
        arch: 'x64',
        destDir: join(root, 'node'),
        cacheDir: join(root, 'cache'),
        pinned,
        fetchImpl: async () => ({
          ok: false,
          status: 404,
          arrayBuffer: async () => Buffer.alloc(0),
        }),
      }),
    ).rejects.toThrow(/descarga fallida \(404\)/)
  })

  it('un hash vacío o de otra longitud nunca coincide', () => {
    for (const bad of ['', 'abc', 'A'.repeat(64)]) {
      expect(() => verifyArchive(Buffer.from('x'), 'a', { files: { a: bad } })).toThrow()
    }
  })
})

describe('zip hostil', () => {
  const entry = { name: 'node.exe', data: Buffer.from('datos'.repeat(50)), deflate: true }

  it('sin directorio central, vacío o truncado', () => {
    const any = () => true
    expect(() => extractZipEntry(Buffer.alloc(0), any)).toThrow(/corrupto/)
    expect(() => extractZipEntry(Buffer.from('PK nada'), any)).toThrow(/corrupto/)
    const zip = makeZip([entry])
    expect(() => extractZipEntry(zip.subarray(0, zip.length - 30), any)).toThrow()
  })

  it('CRC alterado', () => {
    const zip = makeZip([{ name: 'node.exe', data: Buffer.from('abc') }])
    const bad = Buffer.from(zip)
    bad.writeUInt32LE(0xdeadbeef, 14) // CRC de la cabecera local sigue valiendo; se rompe el central
    const centralOffset = bad.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    bad.writeUInt32LE(0xdeadbeef, centralOffset + 16)
    expect(() => extractZipEntry(bad, (n: string) => n === 'node.exe')).toThrow(/CRC/)
  })

  it('datos comprimidos corruptos no se aceptan', () => {
    const zip = makeZip([entry])
    const bad = Buffer.from(zip)
    for (let i = 40; i < 60; i++) bad[i] = 0xff
    expect(() => extractZipEntry(bad, (n: string) => n === 'node.exe')).toThrow()
  })

  it('método de compresión desconocido y zip64', () => {
    const zip = makeZip([{ name: 'node.exe', data: Buffer.from('abc') }])
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    const method = Buffer.from(zip)
    method.writeUInt16LE(99, central + 10)
    expect(() => extractZipEntry(method, () => true)).toThrow(/método/)
    const big = Buffer.from(zip)
    big.writeUInt32LE(0xffffffff, central + 20)
    expect(() => extractZipEntry(big, () => true)).toThrow(/zip64/)
  })

  it('un zip sin el ejecutable', () => {
    const zip = makeZip([{ name: 'otra-cosa.txt', data: Buffer.from('x') }])
    expect(() => extractZipEntry(zip, (n: string) => n.endsWith('node.exe'))).toThrow(/no contiene/)
  })

  it('una bomba de descompresión mal declarada falla por tamaño', () => {
    const data = Buffer.alloc(100_000)
    const body = deflateRawSync(data)
    const zip = makeZip([{ name: 'node.exe', data, deflate: true }])
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    const lie = Buffer.from(zip)
    lie.writeUInt32LE(10, central + 24)
    expect(body.length).toBeLessThan(1000)
    expect(() => extractZipEntry(lie, () => true)).toThrow()
  })
})

describe('paquete corrupto o ausente', () => {
  it('carpeta sin manifiesto', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'Nexo adv ñ '))
    dirs.push(dir)
    await expect(verifyBundle(dir, { pinned: { version: '1', files: {} } })).rejects.toThrow(
      /manifest\.json/,
    )
  })

  it('manifiesto que no es JSON o de otro esquema', async () => {
    const { dir, pinned } = await miniBundle(dirs)
    dirs.push(dir)
    await writeFile(join(dir, 'manifest.json'), '{corrupto')
    await expect(verifyBundle(dir, { pinned })).rejects.toThrow(/manifest\.json/)
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({ schema: 99, files: {} }))
    await expect(verifyBundle(dir, { pinned })).rejects.toThrow(/no es válido/)
  })

  it('un byte de más en el daemon', async () => {
    const { dir, pinned } = await miniBundle(dirs)
    await appendFile(join(dir, 'daemon', 'daemon.mjs'), '\n')
    await expect(verifyBundle(dir, { pinned })).rejects.toThrow(/daemon\.mjs.*corrupto/)
  })

  it('un archivo borrado (el Node, el daemon o el pty host)', async () => {
    for (const file of ['node/node', 'daemon/daemon.mjs', 'daemon/pty-host.mjs']) {
      const { dir, pinned } = await miniBundle(dirs)
      await unlink(join(dir, file))
      await expect(verifyBundle(dir, { pinned })).rejects.toThrow(/falta/)
    }
  })

  it('un archivo sobrante que el manifiesto no lista', async () => {
    const { dir, pinned } = await miniBundle(dirs)
    await writeFile(join(dir, 'daemon', 'extra.mjs'), 'malicioso')
    await expect(verifyBundle(dir, { pinned })).rejects.toThrow(/no lista/)
  })

  it('el Node sustituido por otro cuyo hash de archivo oficial no es el fijado', async () => {
    const { dir } = await miniBundle(dirs)
    const other = { version: '1.0.0', files: { 'node-v1.0.0-linux-x64.tar.xz': 'c'.repeat(64) } }
    await expect(verifyBundle(dir, { pinned: other })).rejects.toThrow(/node-hashes/)
    const otherVersion = {
      version: '2.0.0',
      files: { 'node-v1.0.0-linux-x64.tar.xz': 'b'.repeat(64) },
    }
    await expect(verifyBundle(dir, { pinned: otherVersion })).rejects.toThrow(/node-hashes/)
  })

  it('rutas hostiles en el manifiesto (..​, absolutas, con \\)', async () => {
    for (const bad of ['../fuera.txt', '/etc/passwd', 'a\\b', 'a//b', './a', '']) {
      const { dir, pinned } = await miniBundle(dirs)
      const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
      manifest.files[bad] = 'a'.repeat(64)
      await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest))
      await expect(verifyBundle(dir, { pinned })).rejects.toThrow(/ruta no permitida/)
    }
  })

  it('hashes mal formados en el manifiesto', async () => {
    const { dir, pinned } = await miniBundle(dirs)
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    manifest.files['daemon/daemon.mjs'] = 'zz'
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest))
    await expect(verifyBundle(dir, { pinned })).rejects.toThrow(/hash no válido/)
  })

  it('un manifiesto que olvida lo imprescindible', async () => {
    const { dir, pinned } = await miniBundle(dirs)
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    manifest.files['daemon/pty-host.mjs'] = undefined
    await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest))
    await expect(verifyBundle(dir, { pinned })).rejects.toThrow(/no lista daemon\/pty-host\.mjs/)
  })

  it('writeManifest ignora su propio archivo y es estable entre ejecuciones', async () => {
    const { dir } = await miniBundle(dirs)
    const info = { nodeVersion: '1.0.0', nodeArchive: 'x', nodeArchiveSha256: 'b'.repeat(64) }
    const a = await writeManifest(dir, info)
    const b = await writeManifest(dir, info)
    expect(a.files).toEqual(b.files)
    expect(Object.keys(a.files)).not.toContain('manifest.json')
  })
})
