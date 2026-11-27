// Versión única de Nexo Workspace (F6.2). La fuente es "version" del package.json de la raíz y este script la copia a
// todo lo demás: los package.json del espacio de trabajo, Cargo.toml y Cargo.lock del escritorio, tauri.conf.json y las
// constantes de versión del daemon y la CLI.
//
//   node tools/version/sync-version.mjs            # comprueba (sale con 1 si algo no coincide)
//   node tools/version/sync-version.mjs --write    # copia la versión de la raíz a todo
//   node tools/version/sync-version.mjs --set 0.2.0  # cambia la raíz y lo copia a todo
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z][0-9A-Za-z.-]{0,50})?$/
const WORKSPACE_PARENTS = ['apps', 'packages', 'packages/adapters']

export function isValidVersion(version) {
  return typeof version === 'string' && version.length <= 64 && SEMVER.test(version)
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Reemplaza la primera coincidencia de `pattern` (con un grupo 1 de prefijo y 3 de sufijo) por la versión. */
const replaceIn = (pattern) => ({
  read(text) {
    const match = pattern.exec(text)
    return match === null ? undefined : match[2]
  },
  write(text, version) {
    return text.replace(pattern, (_all, before, _old, after) => `${before}${version}${after}`)
  },
})

const JSON_VERSION = replaceIn(/^(\{[\s\S]*?"version"\s*:\s*")([^"]*)(")/)
const CARGO_TOML = replaceIn(/(\[package\][\s\S]*?\nversion\s*=\s*")([^"]*)(")/)
const CARGO_LOCK = replaceIn(/(\[\[package\]\]\nname = "nexo-desktop"\nversion = ")([^"]*)(")/)
const TS_CONST = (name) => replaceIn(new RegExp(`(export const ${name} = ')([^']*)(')`))

/** Archivos que llevan la versión: [ruta relativa, lector/escritor]. La raíz no está: es la fuente. */
export async function listTargets(root = ROOT) {
  const targets = []
  const dirs = [...WORKSPACE_PARENTS.flatMap((p) => ({ parent: p })), { single: 'e2e' }]
  for (const entry of dirs) {
    if (entry.single !== undefined) {
      if (await exists(join(root, entry.single, 'package.json'))) {
        targets.push([`${entry.single}/package.json`, JSON_VERSION])
      }
      continue
    }
    let names = []
    try {
      names = await readdir(join(root, entry.parent))
    } catch {
      continue
    }
    for (const name of names.sort()) {
      const rel = `${entry.parent}/${name}/package.json`
      if (await exists(join(root, rel))) targets.push([rel, JSON_VERSION])
    }
  }
  targets.push(
    ['apps/desktop/src-tauri/Cargo.toml', CARGO_TOML],
    ['apps/desktop/src-tauri/Cargo.lock', CARGO_LOCK],
    ['apps/desktop/src-tauri/tauri.conf.json', JSON_VERSION],
    ['apps/daemon/src/version.ts', TS_CONST('DAEMON_VERSION')],
    ['apps/cli/src/version.ts', TS_CONST('CLI_VERSION')],
  )
  return targets
}

export async function readRootVersion(root = ROOT) {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (!isValidVersion(pkg.version)) {
    throw new Error(
      `la versión de package.json no es semver válida: ${JSON.stringify(pkg.version)}`,
    )
  }
  return pkg.version
}

/** Devuelve la lista de desajustes (vacía si todo coincide). Con `write`, los corrige. */
export async function syncVersions({ root = ROOT, write = false, version } = {}) {
  const wanted = version ?? (await readRootVersion(root))
  if (!isValidVersion(wanted)) throw new Error(`versión no válida: ${JSON.stringify(wanted)}`)
  const problems = []
  const files = [['package.json', JSON_VERSION], ...(await listTargets(root))]
  for (const [rel, handler] of files) {
    const path = join(root, rel)
    const text = await readFile(path, 'utf8')
    const current = handler.read(text)
    if (current === wanted) continue
    problems.push({ file: rel, found: current, wanted })
    if (write) {
      const next = handler.write(text, wanted)
      if (handler.read(next) !== wanted) throw new Error(`no se pudo escribir la versión en ${rel}`)
      await writeFile(path, next)
    }
  }
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { write: { type: 'boolean', default: false }, set: { type: 'string' } },
  })
  const write = values.write || values.set !== undefined
  const problems = await syncVersions({
    write,
    ...(values.set === undefined ? {} : { version: values.set }),
  })
  for (const p of problems) {
    console.log(
      `${write ? 'actualizado' : 'desajuste'}: ${p.file} (${p.found ?? 'sin versión'} -> ${p.wanted})`,
    )
  }
  if (problems.length > 0 && !write) {
    console.error(
      'las versiones no coinciden: ejecuta `node tools/version/sync-version.mjs --write`',
    )
    process.exit(1)
  }
  console.log(`versión única: ${values.set ?? (await readRootVersion())}`)
}
