// Smoke test de los INSTALADORES (F6.2), el que de verdad instala y arranca la app:
//   node tools/package/installer-smoke.mjs --dir <apps/desktop/src-tauri/target/release/bundle> [--only deb,appimage,nsis,msi]
//
// Linux:   .deb (apt-get install, comprueba bits de ejecución y diseño de recursos, arranca la APP bajo xvfb, espera
//          /health del daemon empaquetado, desinstala) y AppImage extraída (--appimage-extract + AppRun).
// Windows: NSIS silencioso (/S /D=<carpeta temporal>), arranca la app, /health, desinstalación silenciosa con el daemon
//          vivo (el gancho NSIS lo detiene) y MSI (instalación y desinstalación en silencio).
// En todos: el estado del usuario (NEXO_STATE_DIR) NO se borra al desinstalar. Pensado para el CI; instala de verdad.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const WINDOWS = process.platform === 'win32'
const log = (message) => console.log(`[installers] ${message}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, ...options })
  if (result.error) throw new Error(`${command} no se pudo ejecutar: ${result.error.message}`)
  return result
}

function mustRun(command, args, options) {
  const r = run(command, args, options)
  if (r.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} salió con ${r.status}\n${r.stdout ?? ''}\n${r.stderr ?? ''}`,
    )
  }
  return r.stdout ?? ''
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(label, fn, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      last = error
    }
    await sleep(500)
  }
  throw new Error(`tiempo agotado esperando: ${label}${last ? ` (${last.message})` : ''}`)
}

function walk(dir, visit, depth = 0) {
  if (depth > 12) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    visit(full, entry)
    if (entry.isDirectory()) walk(full, visit, depth + 1)
  }
}

/** Carpeta `nexo/` del paquete dentro de una instalación: la que tiene node/, daemon/ y cli/. */
function findPackageDir(root) {
  let found
  walk(root, (path, entry) => {
    if (found !== undefined || !entry.isDirectory() || basename(path) !== 'nexo') return
    if (existsSync(join(path, 'daemon', 'daemon.mjs')) && existsSync(join(path, 'node'))) {
      found = path
    }
  })
  return found
}

const nodeName = WINDOWS ? 'node.exe' : 'node'

/** Comprueba el paquete instalado: archivos, bits de ejecución (Unix) y el manifiesto. */
function checkInstalledPackage(pkg) {
  for (const rel of [
    ['node', nodeName],
    ['daemon', 'daemon.mjs'],
    ['daemon', 'pty-host.mjs'],
    ['cli', 'nexo.mjs'],
    ['web', 'index.html'],
    ['manifest.json'],
    ['companions', 'robi', 'companion.json'],
    ['bin', WINDOWS ? 'nexo.cmd' : 'nexo'],
  ]) {
    if (!existsSync(join(pkg, ...rel))) throw new Error(`falta ${rel.join('/')} en ${pkg}`)
  }
  if (!WINDOWS) {
    for (const rel of [
      ['node', 'node'],
      ['bin', 'nexo'],
      ['bin', 'nexo-mcp'],
    ]) {
      const mode = statSync(join(pkg, ...rel)).mode
      if ((mode & 0o111) === 0) {
        throw new Error(
          `${rel.join('/')} perdió el bit de ejecución (modo ${(mode & 0o777).toString(8)})`,
        )
      }
    }
  }
  log(`paquete instalado en ${pkg} (node, daemon, CLI, web y mascota de ejemplo presentes)`)
}

function killTree(child) {
  if (child.pid === undefined) return
  if (WINDOWS) run('taskkill', ['/PID', String(child.pid), '/T', '/F'])
  else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {}
  }
}

function processPath(pid) {
  if (WINDOWS) {
    const r = run('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).Path`])
    return r.stdout.trim()
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0]
  } catch {
    return ''
  }
}

function exePath(pid) {
  if (WINDOWS) return processPath(pid)
  try {
    return run('readlink', ['-f', `/proc/${pid}/exe`]).stdout.trim()
  } catch {
    return ''
  }
}

async function daemonInfo(stateDir) {
  try {
    return JSON.parse(await readFile(join(stateDir, 'daemon.json'), 'utf8'))
  } catch {
    return undefined
  }
}

async function health(info) {
  const response = await fetch(`http://127.0.0.1:${info.port}/health`, {
    headers: { 'X-Nexo-Daemon': '1' },
  })
  return response.ok && response.headers.get('x-nexo-daemon') === '1'
}

function sameFile(a, b) {
  const norm = (p) => resolve(p).replaceAll('\\', '/').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * Arranca la APP instalada (no el daemon a mano) y espera a que lance el daemon empaquetado y responda /health.
 * `command`/`args`: cómo lanzar la app. Devuelve `{ app, info }`.
 */
async function startApp({ command, args, env, stateDir, expectedNode }) {
  let output = ''
  const app = spawn(command, args, {
    env,
    detached: !WINDOWS,
    windowsHide: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  app.stdout.on('data', (d) => {
    output += d
  })
  app.stderr.on('data', (d) => {
    output += d
  })
  let exited
  app.on('exit', (code, signal) => {
    exited = `${code ?? signal}`
  })
  try {
    const info = await until('el daemon que lanza la app', async () => {
      if (exited !== undefined)
        throw new Error(`la app terminó antes de lanzar el daemon (${exited})`)
      const found = await daemonInfo(stateDir)
      return found !== undefined && (await health(found)) ? found : undefined
    })
    log(`la app lanzó el daemon: /health ok (pid ${info.pid}, puerto ${info.port})`)
    const real = exePath(info.pid)
    if (real === '' || !sameFile(real, expectedNode)) {
      throw new Error(
        `el daemon no usa el Node empaquetado: ${real || '(desconocido)'} != ${expectedNode}`,
      )
    }
    log(`el daemon corre con el Node empaquetado (${real})`)
    return { app, info, output: () => output }
  } catch (error) {
    killTree(app)
    throw new Error(`${error.message}\n--- salida de la app ---\n${output.slice(-4000)}`)
  }
}

async function stopDaemonWithCli(pkg, env) {
  const launcher = join(pkg, 'bin', WINDOWS ? 'nexo.cmd' : 'nexo')
  const r = WINDOWS
    ? run('cmd.exe', ['/d', '/c', `"${launcher}" daemon stop`], {
        env,
        windowsVerbatimArguments: true,
      })
    : run(launcher, ['daemon', 'stop'], { env })
  if (r.status !== 0) throw new Error(`nexo daemon stop falló: ${r.stdout}${r.stderr}`)
}

async function readDaemonLog(stateDir) {
  try {
    return await readFile(join(stateDir, 'daemon.log'), 'utf8')
  } catch {
    return '(sin daemon.log)'
  }
}

/** Limpieza a prueba de fallos: mata el daemon que quede registrado en el estado. */
async function killLeftoverDaemon(stateDir) {
  const info = await daemonInfo(stateDir)
  if (info !== undefined && alive(info.pid)) {
    if (WINDOWS) run('taskkill', ['/PID', String(info.pid), '/T', '/F'])
    else {
      try {
        process.kill(info.pid, 'SIGKILL')
      } catch {}
    }
  }
}

function testEnv(stateDir) {
  const env = {
    ...process.env,
    NEXO_STATE_DIR: stateDir,
    NEXO_PORT: '0',
    NEXO_AGENT_PROVIDERS: 'fake',
    NEXO_START_TIMEOUT_MS: '120000',
    // La app debe usar lo instalado: nada de overrides ni del Node del sistema.
    WEBKIT_DISABLE_COMPOSITING_MODE: '1',
    LIBGL_ALWAYS_SOFTWARE: '1',
  }
  for (const name of [
    'NEXO_NODE',
    'NEXO_DAEMON_ENTRY',
    'NEXO_PTY_MODE',
    'NEXO_CLAUDE_EXECUTABLE',
  ]) {
    delete env[name]
  }
  return env
}

async function assertStatePreserved(stateDir, what) {
  const names = await readdir(stateDir).catch(() => [])
  if (!names.includes('daemon.log')) {
    throw new Error(
      `${what} borró los datos del usuario: ${stateDir} no conserva daemon.log (${names.join(', ')})`,
    )
  }
  log(`${what}: el estado del usuario sigue en ${stateDir} (${names.join(', ')})`)
}

// ---------------------------------------------------------------------------------------------------------- Linux

function linuxLaunch(binary) {
  // dbus-run-session: la instancia única de Tauri y el WebView necesitan un bus de sesión.
  return {
    command: 'xvfb-run',
    args: ['-a', '-s', '-screen 0 1280x800x24', 'dbus-run-session', '--', binary],
  }
}

async function smokeDeb(file, sandbox) {
  const name = mustRun('dpkg-deb', ['-f', file, 'Package']).trim()
  log(`deb: ${basename(file)} (paquete ${name})`)
  mustRun('sudo', ['apt-get', 'install', '-y', file])
  const stateDir = join(sandbox, 'estado deb ñ')
  let installedDir
  try {
    const files = mustRun('dpkg', ['-L', name]).split('\n').filter(Boolean)
    installedDir = files.find((f) => f.endsWith('/nexo/daemon/daemon.mjs'))
    if (installedDir === undefined)
      throw new Error(`el .deb no instala nexo/daemon/daemon.mjs:\n${files.join('\n')}`)
    const pkg = join(installedDir, '..', '..')
    log(
      `deb: recursos instalados en ${resolve(pkg)} (resource_dir esperado: ${resolve(pkg, '..')})`,
    )
    checkInstalledPackage(resolve(pkg))
    const binary = files.find((f) => f.startsWith('/usr/bin/') && statSync(f).isFile())
    if (binary === undefined) throw new Error('el .deb no instala ningún ejecutable en /usr/bin')
    const env = testEnv(stateDir)
    const { command, args } = linuxLaunch(binary)
    const { app, info } = await startApp({
      command,
      args,
      env,
      stateDir,
      expectedNode: join(resolve(pkg), 'node', 'node'),
    })
    try {
      await stopDaemonWithCli(resolve(pkg), env)
      await until('parada del daemon', () => !alive(info.pid), 30_000)
      log('deb: el daemon se detiene con la CLI instalada')
    } finally {
      killTree(app)
    }
  } catch (error) {
    console.error(`[installers] daemon.log:\n${await readDaemonLog(stateDir)}`)
    throw error
  } finally {
    await killLeftoverDaemon(stateDir)
  }
  mustRun('sudo', ['apt-get', 'remove', '-y', name])
  if (existsSync(installedDir)) throw new Error(`desinstalar el .deb dejó ${installedDir}`)
  log('deb: desinstalado sin restos')
  await assertStatePreserved(stateDir, 'desinstalar el .deb')
}

async function smokeAppImage(file, sandbox) {
  log(`appimage: ${basename(file)}`)
  const work = join(sandbox, 'appimage ñ')
  await mkdir(work, { recursive: true })
  mustRun('chmod', ['+x', file])
  mustRun(file, ['--appimage-extract'], {
    cwd: work,
    env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' },
  })
  const root = join(work, 'squashfs-root')
  const pkg = findPackageDir(root)
  if (pkg === undefined)
    throw new Error(`la AppImage no contiene nexo/daemon/daemon.mjs bajo ${root}`)
  log(`appimage: recursos en ${pkg} (resource_dir esperado: ${resolve(pkg, '..')})`)
  checkInstalledPackage(pkg)
  const stateDir = join(sandbox, 'estado appimage ñ')
  const env = testEnv(stateDir)
  const { command, args } = linuxLaunch(join(root, 'AppRun'))
  try {
    const { app, info } = await startApp({
      command,
      args,
      env,
      stateDir,
      expectedNode: join(pkg, 'node', 'node'),
    })
    try {
      await stopDaemonWithCli(pkg, env)
      await until('parada del daemon', () => !alive(info.pid), 30_000)
      log('appimage: el daemon se detiene con la CLI del paquete')
    } finally {
      killTree(app)
    }
  } catch (error) {
    console.error(`[installers] daemon.log:\n${await readDaemonLog(stateDir)}`)
    throw error
  } finally {
    await killLeftoverDaemon(stateDir)
  }
}

// -------------------------------------------------------------------------------------------------------- Windows

function mainExe(installDir) {
  const exes = readdirSync(installDir).filter(
    (n) => n.toLowerCase().endsWith('.exe') && !/^uninstall/i.test(n),
  )
  if (exes.length !== 1)
    throw new Error(`se esperaba un único ejecutable en ${installDir}: ${exes.join(', ')}`)
  return join(installDir, exes[0])
}

async function exerciseWindowsInstall(installDir, stateDir, { keepDaemonAlive }) {
  const pkg = findPackageDir(installDir)
  if (pkg === undefined)
    throw new Error(`la instalación no contiene nexo/daemon/daemon.mjs bajo ${installDir}`)
  log(`recursos instalados en ${pkg} (resource_dir esperado: ${resolve(pkg, '..')})`)
  checkInstalledPackage(pkg)
  const env = testEnv(stateDir)
  const { app, info } = await startApp({
    command: mainExe(installDir),
    args: [],
    env,
    stateDir,
    expectedNode: join(pkg, 'node', 'node.exe'),
  })
  killTree(app)
  if (keepDaemonAlive) {
    // La app se cerró y el daemon sigue (por diseño): el desinstalador debe poder detenerlo y borrar node.exe.
    if (!alive(info.pid)) throw new Error('el daemon murió con la app (debía seguir vivo)')
    log('la app se cerró y el daemon sigue vivo (por diseño)')
    return info
  }
  await stopDaemonWithCli(pkg, env)
  await until('parada del daemon', () => !alive(info.pid), 30_000)
  return info
}

async function smokeNsis(file, sandbox) {
  log(`nsis: ${basename(file)}`)
  const installDir = join(sandbox, 'Nexo instalado ñ')
  const stateDir = join(sandbox, 'estado nsis ñ')
  // /D debe ser el último argumento y sin comillas, aunque la ruta tenga espacios.
  const installer = run(file, ['/S', `/D=${installDir}`], {
    windowsVerbatimArguments: true,
    env: testEnv(stateDir),
  })
  if (installer.status !== 0)
    throw new Error(`el instalador NSIS salió con ${installer.status}: ${installer.stderr}`)
  if (!existsSync(join(installDir, 'uninstall.exe'))) {
    throw new Error(
      `el instalador NSIS no dejó uninstall.exe en ${installDir}: ${readdirSync(sandbox).join(', ')}`,
    )
  }
  let info
  try {
    info = await exerciseWindowsInstall(installDir, stateDir, { keepDaemonAlive: true })
  } catch (error) {
    console.error(`[installers] daemon.log:\n${await readDaemonLog(stateDir)}`)
    await killLeftoverDaemon(stateDir)
    throw error
  }
  // `_?=` hace que el desinstalador espere en vez de copiarse a %TEMP% y volver al instante.
  const un = run(join(installDir, 'uninstall.exe'), ['/S', `_?=${installDir}`], {
    windowsVerbatimArguments: true,
    env: testEnv(stateDir),
  })
  if (un.status !== 0) {
    await killLeftoverDaemon(stateDir)
    throw new Error(`el desinstalador NSIS salió con ${un.status}: ${un.stdout}${un.stderr}`)
  }
  await until('que el desinstalador detenga el daemon', () => !alive(info.pid), 30_000).catch(
    async (error) => {
      await killLeftoverDaemon(stateDir)
      throw new Error(`desinstalar con el daemon vivo no lo detuvo: ${error.message}`)
    },
  )
  if (existsSync(join(installDir, 'nexo', 'node', 'node.exe'))) {
    throw new Error(
      'el desinstalador NSIS dejó nexo\\node\\node.exe (¿el daemon lo mantenía bloqueado?)',
    )
  }
  log('nsis: desinstalado (con el daemon vivo, lo detuvo el gancho y se borró node.exe)')
  await assertStatePreserved(stateDir, 'desinstalar con NSIS')
}

async function smokeMsi(file, sandbox) {
  log(`msi: ${basename(file)}`)
  const stateDir = join(sandbox, 'estado msi ñ')
  const logFile = join(sandbox, 'msi.log')
  const install = run('msiexec.exe', ['/i', file, '/qn', '/norestart', '/l*v', logFile])
  if (install.status !== 0) {
    throw new Error(
      `msiexec /i salió con ${install.status}\n${await readFile(logFile, 'utf8').then(
        (t) => t.slice(-3000),
        () => '',
      )}`,
    )
  }
  let installDir
  for (const base of [
    process.env.ProgramFiles,
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
  ]) {
    if (base === undefined) continue
    for (const name of existsSync(base) ? readdirSync(base) : []) {
      if (/nexo/i.test(name) && existsSync(join(base, name, 'nexo', 'daemon', 'daemon.mjs'))) {
        installDir = join(base, name)
      }
    }
  }
  try {
    if (installDir === undefined)
      throw new Error('el MSI no instaló nexo/daemon/daemon.mjs en Program Files')
    log(`msi: instalado en ${installDir}`)
    await exerciseWindowsInstall(installDir, stateDir, { keepDaemonAlive: false })
  } catch (error) {
    console.error(`[installers] daemon.log:\n${await readDaemonLog(stateDir)}`)
    await killLeftoverDaemon(stateDir)
    throw error
  } finally {
    const un = run('msiexec.exe', ['/x', file, '/qn', '/norestart'])
    if (un.status !== 0) console.error(`[installers] msiexec /x salió con ${un.status}`)
  }
  if (existsSync(join(installDir, 'nexo', 'node', 'node.exe')))
    throw new Error('desinstalar el MSI dejó node.exe')
  log('msi: desinstalado sin restos')
  await assertStatePreserved(stateDir, 'desinstalar el MSI')
}

// ------------------------------------------------------------------------------------------------------------ main

function find(dir, predicate) {
  const out = []
  walk(dir, (path, entry) => {
    if (entry.isFile() && predicate(path)) out.push(path)
  })
  return out
}

async function main() {
  const { values } = parseArgs({ options: { dir: { type: 'string' }, only: { type: 'string' } } })
  if (values.dir === undefined)
    throw new Error('uso: node tools/package/installer-smoke.mjs --dir <carpeta bundle>')
  const dir = resolve(values.dir)
  const wanted = new Set((values.only ?? (WINDOWS ? 'nsis,msi' : 'deb,appimage')).split(','))
  const sandbox = await mkdtemp(join(tmpdir(), 'Nexo instaladores ñandú '))
  const one = (suffix) => {
    const files = find(dir, (p) => p.toLowerCase().endsWith(suffix))
    if (files.length !== 1)
      throw new Error(`se esperaba un único *${suffix} en ${dir}: ${files.join(', ') || 'ninguno'}`)
    return files[0]
  }
  let failed = false
  try {
    if (WINDOWS) {
      if (wanted.has('nsis')) await smokeNsis(one('-setup.exe'), sandbox)
      if (wanted.has('msi')) await smokeMsi(one('.msi'), sandbox)
    } else {
      if (wanted.has('deb')) await smokeDeb(one('.deb'), sandbox)
      if (wanted.has('appimage')) await smokeAppImage(one('.appimage'), sandbox)
    }
    log('todos los instaladores pasan el smoke')
  } catch (error) {
    failed = true
    console.error(`[installers] FALLO: ${error.message}`)
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => {})
  }
  process.exit(failed ? 1 : 0)
}

await main()
