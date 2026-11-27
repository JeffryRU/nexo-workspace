// Manifiesto del paquete (F6.1): `manifest.json` lista cada archivo con su SHA-256. Sirve para detectar un
// paquete corrupto, manipulado o incompleto (el smoke test y, en F6.2, el CI de instaladores lo comprueban).
// Uso: node tools/package/verify-bundle.mjs <carpeta-del-paquete>

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPinned } from './node-runtime.mjs'

export const MANIFEST = 'manifest.json'
const SCHEMA = 1

export class BundleError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BundleError'
  }
}

export function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/** Rutas relativas (con `/`) de todos los archivos bajo `dir`, ordenadas, sin el manifiesto. */
export async function listFiles(dir) {
  const out = []
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) out.push(relative(dir, full).split(sep).join('/'))
    }
  }
  await walk(dir)
  return out.filter((p) => p !== MANIFEST).sort()
}

/** Escribe `manifest.json` con los hashes de todos los archivos actuales de `dir`. */
export async function writeManifest(dir, info) {
  const files = {}
  for (const path of await listFiles(dir)) files[path] = await hashFile(join(dir, path))
  const manifest = { schema: SCHEMA, ...info, files }
  await writeFile(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

function unsafe(path) {
  return (
    typeof path !== 'string' ||
    path === '' ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.split('/').some((part) => part === '..' || part === '' || part === '.')
  )
}

/**
 * Comprueba el paquete: manifiesto válido, ningún archivo ausente, cambiado o sobrante, y que el Node
 * empaquetado procede del archivo oficial con el hash fijado en el repositorio. Lanza `BundleError`.
 */
export async function verifyBundle(dir, { pinned } = {}) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(dir, MANIFEST), 'utf8'))
  } catch (error) {
    throw new BundleError(`falta o no se puede leer ${MANIFEST} en ${dir}: ${error.message}`)
  }
  if (
    manifest?.schema !== SCHEMA ||
    typeof manifest.files !== 'object' ||
    manifest.files === null
  ) {
    throw new BundleError(`${MANIFEST} no es válido`)
  }
  const nodeExe = manifest.platform === 'win32' ? 'node/node.exe' : 'node/node'
  for (const required of [
    nodeExe,
    'daemon/daemon.mjs',
    'daemon/pty-host.mjs',
    'cli/nexo.mjs',
    'mcp/nexo-mcp.mjs',
  ]) {
    if (manifest.files[required] === undefined)
      throw new BundleError(`el manifiesto no lista ${required}`)
  }
  for (const [path, hash] of Object.entries(manifest.files)) {
    if (unsafe(path))
      throw new BundleError(`ruta no permitida en el manifiesto: ${JSON.stringify(path)}`)
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new BundleError(`hash no válido en el manifiesto para ${path}`)
    }
    let info
    try {
      info = await stat(join(dir, path))
    } catch {
      throw new BundleError(`falta ${path}`)
    }
    if (!info.isFile()) throw new BundleError(`${path} no es un archivo`)
    if ((await hashFile(join(dir, path))) !== hash)
      throw new BundleError(`${path} está corrupto o modificado`)
  }
  const extra = (await listFiles(dir)).filter((p) => manifest.files[p] === undefined)
  if (extra.length > 0)
    throw new BundleError(`archivos que el manifiesto no lista: ${extra.slice(0, 5).join(', ')}`)

  const expectedPin = (pinned ?? (await loadPinned())).files[manifest.nodeArchive]
  if (
    expectedPin === undefined ||
    manifest.nodeArchiveSha256 !== expectedPin ||
    manifest.nodeVersion !== (pinned ?? (await loadPinned())).version
  ) {
    throw new BundleError(
      'el Node empaquetado no corresponde al archivo oficial fijado en node-hashes.json',
    )
  }
  return manifest
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2]
  if (dir === undefined) {
    console.error('uso: node tools/package/verify-bundle.mjs <carpeta-del-paquete>')
    process.exit(1)
  }
  try {
    const manifest = await verifyBundle(dir)
    console.log(
      `paquete correcto: ${Object.keys(manifest.files).length} archivos, node ${manifest.nodeVersion}`,
    )
  } catch (error) {
    console.error(`paquete no válido: ${error.message}`)
    process.exit(1)
  }
}
