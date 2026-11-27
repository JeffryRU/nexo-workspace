// Reúne los instaladores de `tauri build` con nombres estables (sin espacios) y escribe sus sumas SHA-256 (F6.2).
//
//   node tools/package/collect-installers.mjs --bundle <carpeta bundle> --out <carpeta> --platform linux|windows
//   node tools/package/collect-installers.mjs --merge <carpeta con SHA256SUMS-*.txt> --out <SHA256SUMS>
//
// Los nombres de Tauri llevan espacios ("Nexo Workspace_0.0.0_amd64.deb"): GitHub los cambia al subirlos y rompería
// las sumas publicadas. Aquí quedan como `nexo-workspace_<versión>_<sistema>_<arquitectura>.<extensión>`.
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$/

/** Nombre estable de un instalador, o `undefined` si el archivo no es un instalador conocido. */
export function installerName(file, version, platform) {
  if (!VERSION.test(version)) throw new Error(`versión no válida: ${version}`)
  const lower = file.toLowerCase()
  const stem = `nexo-workspace_${version}`
  if (platform === 'linux') {
    if (lower.endsWith('.deb')) return `${stem}_linux_x64.deb`
    if (lower.endsWith('.appimage')) return `${stem}_linux_x64.AppImage`
  }
  if (platform === 'windows') {
    if (lower.endsWith('-setup.exe')) return `${stem}_windows_x64-setup.exe`
    if (lower.endsWith('.msi')) return `${stem}_windows_x64.msi`
  }
  return undefined
}

async function listFiles(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listFiles(full)))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

/** Línea de `sha256sum`: hash, dos espacios (modo texto) y el nombre. */
export function sumsLine(hash, name) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('suma SHA-256 no válida')
  if (/[\s/\\]/.test(name)) throw new Error(`nombre no válido para las sumas: ${name}`)
  return `${hash}  ${name}`
}

/** Une varios archivos de sumas en uno solo, ordenado, sin duplicados ni líneas mal formadas. */
export function mergeSums(texts) {
  const lines = new Map()
  for (const text of texts) {
    for (const raw of text.split(/\r?\n/)) {
      if (raw.trim() === '') continue
      const match = /^([0-9a-f]{64}) {2}([^\s/\\]+)$/.exec(raw)
      if (match === null) throw new Error(`línea de sumas mal formada: ${raw.slice(0, 80)}`)
      const [, hash, name] = match
      if (lines.has(name) && lines.get(name) !== hash) {
        throw new Error(`dos sumas distintas para ${name}`)
      }
      lines.set(name, hash)
    }
  }
  const sorted = [...lines].sort(([a], [b]) => a.localeCompare(b))
  return `${sorted.map(([name, hash]) => sumsLine(hash, name)).join('\n')}\n`
}

export async function collect({ bundleDir, outDir, platform, version }) {
  await mkdir(outDir, { recursive: true })
  const names = []
  for (const file of (await listFiles(bundleDir)).sort()) {
    const name = installerName(basename(file), version, platform)
    if (name === undefined) continue
    if (names.includes(name)) throw new Error(`hay dos instaladores que acaban en ${name}`)
    await copyFile(file, join(outDir, name))
    names.push(name)
  }
  if (names.length === 0) throw new Error(`no hay instaladores en ${bundleDir}`)
  const lines = []
  for (const name of names) {
    const size = (await stat(join(outDir, name))).size
    if (size === 0) throw new Error(`${name} está vacío`)
    lines.push(sumsLine(await sha256(join(outDir, name)), name))
  }
  await writeFile(join(outDir, `SHA256SUMS-${platform}.txt`), `${lines.join('\n')}\n`)
  return names
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      bundle: { type: 'string' },
      out: { type: 'string' },
      platform: { type: 'string' },
      merge: { type: 'string' },
    },
  })
  if (values.out === undefined) throw new Error('falta --out')
  if (values.merge !== undefined) {
    const all = await listFiles(resolve(values.merge))
    const files = all.filter((f) => /SHA256SUMS-[a-z]+\.txt$/.test(f))
    if (files.length === 0) throw new Error('no hay SHA256SUMS-*.txt que unir')
    const merged = mergeSums(await Promise.all(files.map((f) => readFile(f, 'utf8'))))
    await writeFile(resolve(values.out), merged)
    console.log(`SHA256SUMS: ${merged.trim().split('\n').length} entradas`)
  } else {
    if (
      values.bundle === undefined ||
      (values.platform !== 'linux' && values.platform !== 'windows')
    ) {
      throw new Error('uso: --bundle <carpeta> --out <carpeta> --platform linux|windows')
    }
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
    const names = await collect({
      bundleDir: resolve(values.bundle),
      outDir: resolve(values.out),
      platform: values.platform,
      version: pkg.version,
    })
    for (const n of names) console.log(n)
  }
}
