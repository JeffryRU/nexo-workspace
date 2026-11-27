// Smoke test del paquete (F6.1), sin repositorio ni Node del sistema:
//   node tools/package/smoke.mjs --bundle <carpeta> [--pty-mode host|direct]
// Copia el paquete a una ruta con espacios y caracteres no ASCII, lo verifica y, solo con sus lanzadores
// (Node empaquetado), arranca el daemon, consulta /health, abre una terminal real, abre un agente falso
// y detiene el daemon. Si algo falla, muestra daemon.log y no deja procesos vivos.
import { spawn } from 'node:child_process'
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { verifyBundle } from './verify-bundle.mjs'

const WINDOWS = process.platform === 'win32'

function quoteForCmd(arg) {
  if (/^[\w.:=\\/-]+$/.test(arg)) return arg
  if (/["%^&|<>!\r\n]/.test(arg)) throw new Error(`argumento no permitido en el smoke test: ${arg}`)
  return `"${arg}"`
}

/** Ejecuta un lanzador del paquete (`nexo`/`nexo.cmd`) con spawn y sin shell de cadena en Unix. */
export function runLauncher(launcher, args, { env, cwd, timeoutMs = 120_000 }) {
  return new Promise((resolvePromise) => {
    const child = WINDOWS
      ? spawn(
          'cmd.exe',
          ['/d', '/s', '/c', `"${[quoteForCmd(launcher), ...args.map(quoteForCmd)].join(' ')}"`],
          { env, cwd, windowsHide: true, windowsVerbatimArguments: true },
        )
      : spawn(launcher, args, { env, cwd })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d
    })
    child.stderr.on('data', (d) => {
      stderr += d
    })
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr })
    })
  })
}

async function until(label, fn, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (error) {
      last = error
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`tiempo agotado esperando: ${label}${last ? ` (${last.message})` : ''}`)
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function main() {
  const { values } = parseArgs({
    options: { bundle: { type: 'string' }, 'pty-mode': { type: 'string' } },
  })
  if (values.bundle === undefined)
    throw new Error('uso: node tools/package/smoke.mjs --bundle <carpeta>')
  const source = resolve(values.bundle)

  // Ruta con espacios y no ASCII, fuera del repositorio.
  const sandbox = await mkdtemp(join(tmpdir(), 'Nexo smoke ñandú '))
  const bundle = join(sandbox, 'Programa Nexo ñ')
  const stateDir = join(sandbox, 'estado ñ')
  const workDir = join(sandbox, 'trabajo ñ')
  await mkdir(workDir, { recursive: true })
  await cp(source, bundle, { recursive: true })

  const manifest = await verifyBundle(bundle)
  console.log(
    `[smoke] paquete verificado (node ${manifest.nodeVersion}, ${manifest.platform}-${manifest.arch})`,
  )

  const env = {
    ...process.env,
    NEXO_STATE_DIR: stateDir,
    NEXO_PORT: '0',
    NEXO_AGENT_PROVIDERS: 'fake',
    NEXO_START_TIMEOUT_MS: '120000',
  }
  for (const name of ['NEXO_NODE', 'NEXO_DAEMON_ENTRY', 'NEXO_PTY_MODE', 'NEXO_CLAUDE_EXECUTABLE'])
    delete env[name]
  if (values['pty-mode'] !== undefined) env.NEXO_PTY_MODE = values['pty-mode']
  const launcher = join(bundle, 'bin', WINDOWS ? 'nexo.cmd' : 'nexo')
  const nodeExe = join(bundle, 'node', WINDOWS ? 'node.exe' : 'node')
  const nexo = async (args) => {
    const r = await runLauncher(launcher, args, { env, cwd: workDir })
    if (r.code !== 0) {
      throw new Error(`nexo ${args.join(' ')} salió con ${r.code}\n${r.stdout}\n${r.stderr}`)
    }
    return r.stdout
  }

  let pid
  let failed = false
  try {
    const version = (await nexo(['--version'])).trim()
    console.log(`[smoke] nexo --version: ${version}`)

    // Terminal real: el script lo ejecuta el Node empaquetado dentro del PTY (en Windows, vía pty host).
    const hello = join(workDir, 'hola ñ.mjs')
    await writeFile(hello, "console.log('NEXO_SMOKE_OK ' + process.version)\n")
    const created = JSON.parse(
      await nexo(['new', '--json', '--cwd', workDir, '--name', 'smoke', '--', nodeExe, hello]),
    )
    const text = await until('salida de la terminal', async () => {
      const read = JSON.parse(await nexo(['read', created.paneId, '--json']))
      return read.text.includes('NEXO_SMOKE_OK') ? read.text : undefined
    })
    if (!text.includes(`NEXO_SMOKE_OK v${manifest.nodeVersion}`)) {
      throw new Error(`la terminal no ejecutó el Node empaquetado: ${text}`)
    }
    console.log('[smoke] terminal abierta con el Node empaquetado')

    // /health con el puerto y el token que el daemon publicó en su directorio de estado.
    const info = JSON.parse(await readFile(join(stateDir, 'daemon.json'), 'utf8'))
    pid = info.pid
    const response = await fetch(`http://127.0.0.1:${info.port}/health`, {
      headers: { 'X-Nexo-Daemon': '1' },
    })
    if (!response.ok || response.headers.get('x-nexo-daemon') !== '1') {
      throw new Error(`/health respondió ${response.status}`)
    }
    console.log(`[smoke] /health ok (pid ${pid}, puerto ${info.port})`)

    // Agente falso (proveedor `fake`).
    const agent = JSON.parse(
      await nexo([
        'agent',
        'new',
        '--provider',
        'fake',
        '--cwd',
        workDir,
        '--name',
        'agente',
        '--json',
      ]),
    )
    await nexo(['agent', 'send', agent.sessionId, 'hola', 'smoke'])
    await until('respuesta del agente falso', async () =>
      (await nexo(['agent', 'attach', agent.sessionId, '--no-follow'])).includes('Eco: hola smoke'),
    )
    console.log('[smoke] agente falso responde')

    await nexo(['daemon', 'stop'])
    await until('parada del daemon', () => !alive(pid), 30_000)
    console.log('[smoke] daemon detenido')

    // Adversarial: un byte de más en el daemon y el paquete deja de verificar.
    await appendFile(join(bundle, 'daemon', 'daemon.mjs'), '\n')
    let detected = false
    try {
      await verifyBundle(bundle)
    } catch {
      detected = true
    }
    if (!detected) throw new Error('un daemon.mjs modificado no se detectó')
    console.log('[smoke] un paquete corrupto se detecta')
  } catch (error) {
    failed = true
    console.error(`[smoke] FALLO: ${error.message}`)
    try {
      console.error(`[smoke] daemon.log:\n${await readFile(join(stateDir, 'daemon.log'), 'utf8')}`)
    } catch {
      console.error('[smoke] (sin daemon.log)')
    }
  } finally {
    if (pid !== undefined && alive(pid)) {
      try {
        process.kill(pid)
      } catch {}
    }
    await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(
      () => {},
    )
  }
  if (failed) process.exit(1)
  console.log('[smoke] todo correcto')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
