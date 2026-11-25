// Arranca el daemon (NEXO_DEV=1, puerto efímero, directorio de estado temporal) y Vite, e imprime la URL con
// el token para abrir la interfaz en el navegador. Ctrl+C detiene ambos. Sin shell: solo spawn(cmd, args[]).
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stateDir = mkdtempSync(join(tmpdir(), 'nexo-dev-'))
const vitePort = process.env.NEXO_WEB_PORT ?? '5173'
const children = []

function stop(code = 0) {
  for (const child of children) child.kill()
  setTimeout(() => {
    try {
      rmSync(stateDir, { recursive: true, force: true })
    } catch {
      // el daemon puede seguir cerrando archivos
    }
    process.exit(code)
  }, 500).unref()
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(signal, () => stop(0))

const daemon = spawn(process.execPath, [join(root, 'apps/daemon/src/main.ts')], {
  cwd: root,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...process.env,
    NEXO_DEV: '1',
    NEXO_PORT: process.env.NEXO_PORT ?? '0',
    NEXO_STATE_DIR: stateDir,
  },
})
children.push(daemon)
daemon.on('exit', (code) => {
  console.error(`dev:web: el daemon terminó (${code ?? 'señal'})`)
  stop(code ?? 1)
})

async function waitForInfo() {
  for (let i = 0; i < 100; i++) {
    try {
      const info = JSON.parse(readFileSync(join(stateDir, 'daemon.json'), 'utf8'))
      const token = readFileSync(join(stateDir, 'token'), 'utf8').trim()
      if (info.port > 0 && token !== '') return { port: info.port, token }
    } catch {
      // aún no está escrito
    }
    await sleep(100)
  }
  throw new Error('el daemon no escribió daemon.json a tiempo')
}

const { port, token } = await waitForInfo()
const viteBin = join(root, 'node_modules/vite/bin/vite.js')
const vite = spawn(
  process.execPath,
  [viteBin, '--port', vitePort, '--strictPort', '--host', 'localhost'],
  {
    cwd: join(root, 'apps/web'),
    stdio: ['ignore', 'inherit', 'inherit'],
  },
)
children.push(vite)
vite.on('exit', (code) => stop(code ?? 1))

console.log('')
console.log('Nexo (modo desarrollo) listo. Abre esta dirección en el navegador:')
console.log(`  http://localhost:${vitePort}/?port=${port}&t=${token}`)
console.log('(el token se borra de la barra de direcciones al cargar). Ctrl+C para detener.')
