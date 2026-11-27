import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
// @ts-expect-error módulo .mjs sin tipos; tools/ no entra en ningún tsconfig
import { writeManifest } from '../package/verify-bundle.mjs'

/** Zip mínimo (entradas almacenadas o deflate) para las pruebas. */
export function makeZip(entries: { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name)
    const body = e.deflate ? deflateRawSync(e.data) : e.data
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(e.deflate ? 8 : 0, 8)
    local.writeUInt32LE(crc32(e.data), 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(e.deflate ? 8 : 0, 10)
    central.writeUInt32LE(crc32(e.data), 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

/** Paquete mínimo válido con su manifiesto; `dirs` recoge la carpeta para que la prueba la borre. */
export async function miniBundle(dirs: string[]): Promise<{ dir: string; pinned: unknown }> {
  const dir = await mkdtemp(join(tmpdir(), 'Nexo pkg ñ '))
  dirs.push(dir)
  const files = [
    'node/node',
    'daemon/daemon.mjs',
    'daemon/pty-host.mjs',
    'cli/nexo.mjs',
    'mcp/nexo-mcp.mjs',
  ]
  for (const f of files) {
    await mkdir(join(dir, f, '..'), { recursive: true })
    await writeFile(join(dir, f), `contenido de ${f}`)
  }
  const archive = 'node-v1.0.0-linux-x64.tar.xz'
  const pinned = { version: '1.0.0', files: { [archive]: 'b'.repeat(64) } }
  await writeManifest(dir, {
    nodeVersion: '1.0.0',
    nodeArchive: archive,
    nodeArchiveSha256: 'b'.repeat(64),
    platform: 'linux',
    arch: 'x64',
  })
  return { dir, pinned }
}
