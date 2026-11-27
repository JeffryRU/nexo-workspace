// Construye el paquete de ejecución de Nexo (F6.1): daemon, pty host, CLI y MCP como bundles JS (esbuild),
// node-pty aparte con su binario nativo, la web, los lanzadores, la mascota de ejemplo y el Node oficial como sidecar.
//
//   node tools/package/build-bundle.mjs [--out <carpeta>] [--no-web] [--with-claude] [--cache <carpeta>]
//
// Por omisión deja el resultado en apps/desktop/src-tauri/resources/nexo (recurso de Tauri, ver
// tauri.bundle.conf.json). Se construye para la plataforma que ejecuta el script (node-pty es nativo).
import { chmod, cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'
import { loadPinned, provisionNode } from './node-runtime.mjs'
import { writeManifest } from './verify-bundle.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** Entradas: [origen relativo a la raíz del repositorio, destino dentro del paquete]. */
export const ENTRIES = [
  ['apps/daemon/src/main.ts', 'daemon/daemon.mjs'],
  ['packages/adapters/pty-host/src/host.ts', 'daemon/pty-host.mjs'],
  ['apps/cli/src/main.ts', 'cli/nexo.mjs'],
  ['apps/mcp/src/main.ts', 'mcp/nexo-mcp.mjs'],
]

// node-pty: nativo, se copia aparte. ws: addons opcionales que solo se cargan si existen.
export const EXTERNAL = ['node-pty', 'bufferutil', 'utf-8-validate']

const REQUIRE_SHIM =
  "import { createRequire as __nexoCreateRequire } from 'node:module';const require = __nexoCreateRequire(import.meta.url);"

export async function bundleEntries(root, outDir) {
  for (const [source, target] of ENTRIES) {
    await build({
      entryPoints: [join(root, source)],
      outfile: join(outDir, target),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node24',
      external: EXTERNAL,
      banner: { js: REQUIRE_SHIM },
      legalComments: 'none',
      logLevel: 'warning',
      // Los .ts se importan con su extensión (Node 24 ejecuta TS); esbuild los entiende tal cual.
      absWorkingDir: root,
    })
  }
}

const SKIP_IN_LIB = /(\.map|\.test\.js|testUtils.*)$/

/** Copia lo mínimo de node-pty: lib, package.json y el binario nativo de ESTA plataforma. */
export async function copyNodePty(root, outDir, platform, arch) {
  const require = createRequire(join(root, 'packages/adapters/pty-node/package.json'))
  const pkg = dirname(require.resolve('node-pty/package.json'))
  const dest = join(outDir, 'daemon/node_modules/node-pty')
  await mkdir(dest, { recursive: true })
  await cp(join(pkg, 'package.json'), join(dest, 'package.json'))
  await cp(join(pkg, 'lib'), join(dest, 'lib'), {
    recursive: true,
    filter: (src) => !SKIP_IN_LIB.test(src),
  })
  let natives = 0
  const prebuild = join(pkg, 'prebuilds', `${platform}-${arch}`)
  if (await exists(prebuild)) {
    await cp(prebuild, join(dest, 'prebuilds', `${platform}-${arch}`), {
      recursive: true,
      filter: (src) => !src.endsWith('.pdb'),
    })
    natives++
  }
  const release = join(pkg, 'build', 'Release')
  if (await exists(release)) {
    for (const name of await readdir(release)) {
      if (name.endsWith('.node') || name === 'spawn-helper') {
        await mkdir(join(dest, 'build', 'Release'), { recursive: true })
        await cp(join(release, name), join(dest, 'build', 'Release', name))
        natives++
      }
    }
  }
  if (platform === 'win32' && (await exists(join(pkg, 'third_party')))) {
    await cp(join(pkg, 'third_party'), join(dest, 'third_party'), { recursive: true })
  }
  if (natives === 0) {
    throw new Error(
      `node-pty no trae binario nativo para ${platform}-${arch} (¿falta compilarlo en pnpm install?)`,
    )
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const SH_LAUNCHER = (script) => `#!/bin/sh
# Lanzador de Nexo (F6.1): usa el Node empaquetado. Puede enlazarse desde el PATH (ln -s).
self="$0"
while [ -h "$self" ]; do
  link=$(readlink "$self")
  case "$link" in
    /*) self="$link" ;;
    *) self="$(dirname "$self")/$link" ;;
  esac
done
bin=$(cd "$(dirname "$self")" && pwd -P) || exit 1
root=$(dirname "$bin")
exec "$root/node/node" "$root/${script}" "$@"
`

const CMD_LAUNCHER = (script) => `@echo off\r
rem Lanzador de Nexo (F6.1): usa el Node empaquetado. Puede ponerse su carpeta en el PATH.\r
"%~dp0..\\node\\node.exe" "%~dp0..\\${script.replaceAll('/', '\\')}" %*\r
exit /b %ERRORLEVEL%\r
`

export async function writeLaunchers(outDir) {
  const bin = join(outDir, 'bin')
  await mkdir(bin, { recursive: true })
  for (const [name, script] of [
    ['nexo', 'cli/nexo.mjs'],
    ['nexo-mcp', 'mcp/nexo-mcp.mjs'],
  ]) {
    await writeFile(join(bin, name), SH_LAUNCHER(script))
    await chmod(join(bin, name), 0o755)
    await writeFile(join(bin, `${name}.cmd`), CMD_LAUNCHER(script))
  }
}

/** El Claude Code que trae el SDK para esta plataforma (cientos de MB): solo con `--with-claude`. */
export async function copyClaude(root, outDir, platform, arch) {
  const require = createRequire(join(root, 'packages/adapters/provider-claude/package.json'))
  const scope = join(dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), '..')
  const exe = platform === 'win32' ? 'claude.exe' : 'claude'
  const base = `claude-agent-sdk-${platform}-${arch}`
  for (const name of platform === 'linux' ? [base, `${base}-musl`] : [base]) {
    const source = join(scope, name, exe)
    if (await exists(source)) {
      await mkdir(join(outDir, 'vendor'), { recursive: true })
      await cp(source, join(outDir, 'vendor', exe))
      await chmod(join(outDir, 'vendor', exe), 0o755)
      return
    }
  }
  throw new Error(`el SDK no trae el ejecutable de Claude Code para ${platform}-${arch}`)
}

/**
 * Mascotas de ejemplo (F6.2): Robi viaja en `companions/robi` dentro del paquete. NO se instala sola en la carpeta
 * del usuario: «sin mascota» sigue siendo lo predeterminado y copiarla es un paso explícito (docs/instalacion.md).
 */
export async function copyCompanions(root, outDir) {
  const source = join(root, 'examples/companions/robi')
  if (!(await exists(join(source, 'companion.json')))) {
    throw new Error('falta examples/companions/robi/companion.json')
  }
  await cp(source, join(outDir, 'companions/robi'), { recursive: true })
}

export async function buildBundle({
  root = ROOT,
  outDir,
  cacheDir,
  withWeb = true,
  withClaude = false,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const pinned = await loadPinned()
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  await bundleEntries(root, outDir)
  await copyNodePty(root, outDir, platform, arch)
  if (withWeb) {
    const dist = join(root, 'apps/web/dist')
    if (!(await exists(join(dist, 'index.html')))) {
      throw new Error(
        'falta apps/web/dist (ejecuta `pnpm --filter @nexo/web build` o usa --no-web)',
      )
    }
    await cp(dist, join(outDir, 'web'), { recursive: true })
  }
  if (withClaude) await copyClaude(root, outDir, platform, arch)
  await writeLaunchers(outDir)
  await copyCompanions(root, outDir)
  const node = await provisionNode({
    platform,
    arch,
    destDir: join(outDir, 'node'),
    cacheDir: cacheDir ?? join(root, 'dist/package-cache'),
    pinned,
  })
  return writeManifest(outDir, {
    nodeVersion: node.version,
    nodeArchive: node.archive,
    nodeArchiveSha256: node.archiveSha256,
    platform,
    arch,
    withWeb,
    withClaude,
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      cache: { type: 'string' },
      'no-web': { type: 'boolean', default: false },
      'with-claude': { type: 'boolean', default: false },
    },
  })
  const outDir = resolve(values.out ?? join(ROOT, 'apps/desktop/src-tauri/resources/nexo'))
  const manifest = await buildBundle({
    outDir,
    ...(values.cache === undefined ? {} : { cacheDir: resolve(values.cache) }),
    withWeb: !values['no-web'],
    withClaude: values['with-claude'],
  })
  console.log(
    `paquete listo en ${outDir}: ${Object.keys(manifest.files).length} archivos, node ${manifest.nodeVersion} (${manifest.platform}-${manifest.arch})`,
  )
}
