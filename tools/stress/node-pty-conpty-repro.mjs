// Caso mínimo para node-pty (sin código de Nexo): kill simultáneo de varios PTY con el conpty.dll incluido.
//   node tools/stress/node-pty-conpty-repro.mjs [--rounds 100] [--terminals 12] [--dll true|false] [--gap 0]
// Cada ronda corre en un proceso hijo; un crash nativo (0xC0000005 = 3221225477 en Windows) cuenta como fallo.
// Con `--gap N` los kill se espacian N ms (mitigación). Ver docs/upstream/node-pty-conpty-crash.md.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(import.meta.url)
const require = createRequire(
  new URL('../../packages/adapters/pty-node/package.json', import.meta.url),
)

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const terminals = Number(arg('terminals', '12'))
const useConptyDll = arg('dll', 'true') === 'true'
const gap = Number(arg('gap', '0'))

if (process.argv.includes('--round')) {
  const nodePty = require('node-pty')
  const ptys = []
  let exited = 0
  for (let i = 0; i < terminals; i++) {
    const p = nodePty.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cols: 80,
      rows: 24,
      useConptyDll,
    })
    p.onData(() => {})
    p.onExit(() => {
      if (++exited === terminals) {
        console.log('ROUND_OK')
        process.exit(0)
      }
    })
    ptys.push(p)
  }
  await new Promise((r) => setTimeout(r, 500))
  for (const [i, p] of ptys.entries()) {
    if (gap === 0) p.kill()
    else setTimeout(() => p.kill(), i * gap)
  }
  setTimeout(() => {
    console.log('TIMEOUT')
    process.exit(2)
  }, 30000)
} else {
  const rounds = Number(arg('rounds', '100'))
  let crashes = 0
  let hangs = 0
  const codes = {}
  for (let r = 0; r < rounds; r++) {
    const result = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [
          here,
          '--round',
          '--terminals',
          String(terminals),
          '--dll',
          String(useConptyDll),
          '--gap',
          String(gap),
        ],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      )
      let out = ''
      child.stdout.on('data', (d) => {
        out += d
      })
      child.on('exit', (code, signal) => resolve({ code, signal, out }))
    })
    if (result.out.includes('ROUND_OK')) continue
    if (result.out.includes('TIMEOUT')) hangs++
    else {
      crashes++
      const key = `code=${result.code} signal=${result.signal}`
      codes[key] = (codes[key] ?? 0) + 1
    }
  }
  console.log(
    JSON.stringify({
      node: process.version,
      platform: process.platform,
      rounds,
      terminals,
      useConptyDll,
      gap,
      crashes,
      hangs,
      codes,
    }),
  )
}
