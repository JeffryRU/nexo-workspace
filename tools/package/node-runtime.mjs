// Node oficial como sidecar (F6.1): se descarga SOLO al construir el paquete, nunca en ejecución.
// La integridad se comprueba contra los SHA-256 fijados en `node-hashes.json` y, además, contra el
// `SHASUMS256.txt` publicado por nodejs.org (si no coinciden, se aborta).
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, inflateRawSync } from 'node:zlib'

export const PINNED_PATH = fileURLToPath(new URL('./node-hashes.json', import.meta.url))

export class NodeRuntimeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NodeRuntimeError'
  }
}

export async function loadPinned(path = PINNED_PATH) {
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  if (
    typeof parsed?.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(parsed.version) ||
    typeof parsed.files !== 'object' ||
    parsed.files === null
  ) {
    throw new NodeRuntimeError(`node-hashes.json no es válido (${path})`)
  }
  for (const [name, hash] of Object.entries(parsed.files)) {
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new NodeRuntimeError(`hash fijado no válido para ${name}`)
    }
  }
  return parsed
}

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Nombre del archivo oficial de Node para una plataforma (`linux`/`win32`) y arquitectura (`x64`/`arm64`). */
export function archiveName(version, platform, arch) {
  if (!['x64', 'arm64'].includes(arch))
    throw new NodeRuntimeError(`arquitectura no admitida: ${arch}`)
  if (platform === 'linux') return `node-v${version}-linux-${arch}.tar.xz`
  if (platform === 'win32') return `node-v${version}-win-${arch}.zip`
  throw new NodeRuntimeError(`plataforma no admitida: ${platform}`)
}

/** `SHASUMS256.txt` -> Map(nombre -> hash). Ignora líneas mal formadas. */
export function parseShasums(text) {
  const map = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) [ *]?([^\s/\\]+)$/.exec(line.trim())
    if (match) map.set(match[2], match[1])
  }
  return map
}

/** Comprueba los bytes de un archivo contra el hash fijado; lanza si falta o no coincide. */
export function verifyArchive(bytes, name, pinned) {
  const expected = pinned.files[name]
  if (expected === undefined) throw new NodeRuntimeError(`no hay hash fijado para ${name}`)
  const actual = sha256Hex(bytes)
  if (actual !== expected) {
    throw new NodeRuntimeError(
      `SHA-256 de ${name} no coincide: esperado ${expected}, obtenido ${actual}`,
    )
  }
}

/** Lee un único archivo de un zip (método 0 o 8, sin zip64) y comprueba su CRC. */
export function extractZipEntry(zip, matches) {
  const eocdMin = 22
  let eocd = -1
  for (let i = zip.length - eocdMin; i >= Math.max(0, zip.length - eocdMin - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new NodeRuntimeError('zip corrupto: no hay directorio central')
  const count = zip.readUInt16LE(eocd + 10)
  let offset = zip.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n++) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== 0x02014b50) {
      throw new NodeRuntimeError('zip corrupto: entrada del directorio central no válida')
    }
    const method = zip.readUInt16LE(offset + 10)
    const crc = zip.readUInt32LE(offset + 16)
    const compressed = zip.readUInt32LE(offset + 20)
    const size = zip.readUInt32LE(offset + 24)
    const nameLen = zip.readUInt16LE(offset + 28)
    const extraLen = zip.readUInt16LE(offset + 30)
    const commentLen = zip.readUInt16LE(offset + 32)
    const localOffset = zip.readUInt32LE(offset + 42)
    const name = zip.subarray(offset + 46, offset + 46 + nameLen).toString('utf8')
    offset += 46 + nameLen + extraLen + commentLen
    if (!matches(name)) continue
    if (compressed === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new NodeRuntimeError('zip64 no admitido')
    }
    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new NodeRuntimeError('zip corrupto: cabecera local no válida')
    }
    const start =
      localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28)
    if (start + compressed > zip.length) throw new NodeRuntimeError('zip corrupto: datos truncados')
    const raw = zip.subarray(start, start + compressed)
    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw)
    else throw new NodeRuntimeError(`método de compresión ${method} no admitido`)
    if (data.length !== size || crc32(data) !== crc) {
      throw new NodeRuntimeError(`zip corrupto: ${name} no coincide con su CRC`)
    }
    return data
  }
  throw new NodeRuntimeError('el zip no contiene el ejecutable de node')
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => {
      stderr += d
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new NodeRuntimeError(`${cmd} salió con ${code}: ${stderr}`)),
    )
  })
}

async function download(url, fetchImpl) {
  const response = await fetchImpl(url)
  if (!response.ok) throw new NodeRuntimeError(`descarga fallida (${response.status}): ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

/**
 * Descarga (o toma de la caché, siempre re-verificada), valida y deja el ejecutable en `destDir`
 * (`node` o `node.exe`). Devuelve `{ path, version, archive, archiveSha256 }`.
 */
export async function provisionNode({
  platform,
  arch,
  destDir,
  cacheDir,
  pinned,
  fetchImpl = fetch,
  baseUrl = 'https://nodejs.org/dist',
  crossCheck = true,
}) {
  const version = pinned.version
  const name = archiveName(version, platform, arch)
  await mkdir(cacheDir, { recursive: true })
  const cached = join(cacheDir, name)
  let bytes
  try {
    bytes = await readFile(cached)
    verifyArchive(bytes, name, pinned)
  } catch {
    bytes = undefined
  }
  if (bytes === undefined) {
    bytes = await download(`${baseUrl}/v${version}/${name}`, fetchImpl)
    verifyArchive(bytes, name, pinned)
    await writeFile(cached, bytes)
  }
  if (crossCheck) {
    const sums = parseShasums(
      (await download(`${baseUrl}/v${version}/SHASUMS256.txt`, fetchImpl)).toString('utf8'),
    )
    if (sums.get(name) !== sha256Hex(bytes)) {
      throw new NodeRuntimeError(`SHASUMS256.txt de nodejs.org no respalda ${name}`)
    }
  }
  await mkdir(destDir, { recursive: true })
  const exe = platform === 'win32' ? 'node.exe' : 'node'
  const target = join(destDir, exe)
  if (platform === 'win32') {
    const data = extractZipEntry(
      bytes,
      (entry) => entry === `node-v${version}-win-${arch}/node.exe`,
    )
    await writeFile(target, data)
  } else {
    const scratch = await mkdtemp(join(tmpdir(), 'nexo-node-'))
    try {
      const member = `node-v${version}-linux-${arch}/bin/node`
      await run('tar', ['-xJf', cached, '-C', scratch, member])
      await copyFile(join(scratch, member), target)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
    await chmod(target, 0o755)
  }
  return { path: target, version, archive: name, archiveSha256: sha256Hex(bytes) }
}

// Uso: node tools/package/node-runtime.mjs --print-hashes <versión>   (para actualizar node-hashes.json)
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--print-hashes') {
  const version = process.argv[3]
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    console.error('uso: node tools/package/node-runtime.mjs --print-hashes <x.y.z>')
    process.exit(1)
  }
  const sums = parseShasums(
    (await download(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`, fetch)).toString('utf8'),
  )
  const files = {}
  for (const platform of ['linux', 'win32']) {
    for (const arch of ['arm64', 'x64']) {
      const name = archiveName(version, platform, arch)
      const hash = sums.get(name)
      if (hash === undefined) throw new NodeRuntimeError(`falta ${name} en SHASUMS256.txt`)
      files[name] = hash
    }
  }
  console.log(
    JSON.stringify(
      { version, source: `https://nodejs.org/dist/v${version}/SHASUMS256.txt`, files },
      null,
      2,
    ),
  )
}
