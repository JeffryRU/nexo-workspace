// Estrés de node-pty/ConPTY fuera de Vitest (issue #15).
//
// Cada ronda corre en un proceso hijo desechable: si node-pty provoca una violación de acceso nativa,
// solo cae ese hijo y el script cuenta un crash. Uso:
//   node tools/stress/pty-stress.mjs [--rounds 100] [--terminals 12] [--variants a,b,c] [--json]
//   node tools/stress/pty-stress.mjs --list
// Variantes: ver VARIANTS. `direct-*` y `host-*` usan los adaptadores del repo; con `host-*` los crashes
// quedan contenidos en el pty host y el hijo de la ronda (que hace de daemon) debe terminar bien.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(import.meta.url)
const require = createRequire(
  new URL('../../packages/adapters/pty-node/package.json', import.meta.url),
)

// dll: conpty.dll incluido en node-pty; gap: espaciado entre kill (ms)
const VARIANTS = {
  'sys-nogap-exit': { dll: false, gap: 0, mode: 'exit' },
  'dll-nogap-exit': { dll: true, gap: 0, mode: 'exit' },
  'sys-nogap-kill': { dll: false, gap: 0, mode: 'kill' },
  'dll-nogap-kill': { dll: true, gap: 0, mode: 'kill' },
  'sys-gap25-kill': { dll: false, gap: 25, mode: 'kill' },
  'dll-gap25-kill': { dll: true, gap: 25, mode: 'kill' },
  'dll-nogap-mixed': { dll: true, gap: 0, mode: 'mixed' },
  'dll-gap25-mixed': { dll: true, gap: 25, mode: 'mixed' },
  'dll-nogap-output-exit': { dll: true, gap: 0, mode: 'output-exit' },
  'dll-gap25-output-exit': { dll: true, gap: 25, mode: 'output-exit' },
  'sys-nogap-resize-exit': { dll: false, gap: 0, mode: 'resize-exit' },
  'dll-nogap-resize-exit': { dll: true, gap: 0, mode: 'resize-exit' },
  'dll-gap25-resize-exit': { dll: true, gap: 25, mode: 'resize-exit' },
  'direct-mixed': { adapter: 'direct', mode: 'mixed' },
  'direct-output-exit': { adapter: 'direct', mode: 'output-exit' },
  'direct-resize-exit': { adapter: 'direct', mode: 'resize-exit' },
  'host-mixed': { adapter: 'host', mode: 'mixed' },
  'host-output-exit': { adapter: 'host', mode: 'output-exit' },
  'host-resize-exit': { adapter: 'host', mode: 'resize-exit' },
}
const DEFAULT_VARIANTS = Object.keys(VARIANTS).filter(
  (v) => !v.startsWith('host-') && !v.startsWith('direct-'),
)

const SCRIPTS = {
  exit: "console.log('x'.repeat(200)); process.exit(0)",
  live: "console.log('listo'); setInterval(() => {}, 1000)",
  output:
    "for (let i = 0; i < 300; i++) console.log('linea ' + i + ' ' + 'y'.repeat(80)); process.exit(0)",
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

// ---------- modo ronda (hijo desechable) ----------
async function runRound(variantName, terminals) {
  const v = VARIANTS[variantName]
  const mode = v.mode
  let gate = Promise.resolve()
  const killSpaced = (fn) => {
    if (!v.gap) return fn()
    gate = gate.then(async () => {
      try {
        fn()
      } catch {}
      await sleep(v.gap)
    })
  }

  let closePort = () => {}
  let spawnOne
  if (v.adapter) {
    const mod =
      v.adapter === 'host'
        ? await import('../../packages/adapters/pty-host/src/index.ts')
        : await import('../../packages/adapters/pty-node/src/index.ts')
    const port = v.adapter === 'host' ? new mod.PtyHostPort() : new mod.NodePtyPort()
    closePort = () => port.dispose?.()
    spawnOne = async (script) => {
      const p = await port.spawn({
        cmd: process.execPath,
        args: ['-e', script],
        cols: 80,
        rows: 24,
      })
      return {
        onData: (f) => p.onData(f),
        onExit: (f) => p.onExit(f),
        kill: () => p.kill(),
        resize: (c, r) => p.resize(c, r),
      }
    }
  } else {
    const nodePty = require('node-pty')
    spawnOne = async (script) => {
      const p = nodePty.spawn(process.execPath, ['-e', script], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: process.env,
        useConptyDll: v.dll,
      })
      return {
        onData: (f) => p.onData(f),
        onExit: (f) => p.onExit(f),
        kill: () => killSpaced(() => p.kill()),
        resize: (c, r) => {
          try {
            p.resize(c, r)
          } catch {}
        },
      }
    }
  }

  let hostCrashed = false
  const procs = []
  const done = []
  for (let i = 0; i < terminals; i++) {
    const script =
      mode === 'exit'
        ? SCRIPTS.exit
        : mode === 'kill'
          ? SCRIPTS.live
          : mode === 'mixed'
            ? i % 2 === 0
              ? SCRIPTS.exit
              : SCRIPTS.live
            : SCRIPTS.output
    const p = await spawnOne(script)
    procs.push(p)
    done.push(
      new Promise((resolve) =>
        p.onExit((exit) => {
          if (exit?.signal === 'HOST_CRASH') hostCrashed = true
          resolve()
        }),
      ),
    )
    p.onData(() => {})
  }
  // Todas salen o se matan a la vez
  await sleep(300)
  if (mode === 'kill' || mode === 'mixed') {
    for (let i = 0; i < procs.length; i++) if (mode === 'kill' || i % 2 === 1) procs[i].kill()
  }
  if (mode === 'resize-exit') {
    for (let k = 0; k < 20; k++) for (const p of procs) p.resize(60 + k, 20 + (k % 5))
  }
  await Promise.race([
    Promise.all(done),
    sleep(20000).then(() => {
      throw new Error('timeout esperando exits')
    }),
  ])
  closePort()
  console.log(hostCrashed ? 'ROUND_OK HOST_CRASHED' : 'ROUND_OK')
  process.exit(0)
}

// ---------- modo orquestador ----------
function runChild(variantName, terminals, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [here, '--round', variantName, '--terminals', String(terminals)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      out += d
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0 && out.includes('ROUND_OK'))
        resolve({ kind: 'ok', hostCrashed: out.includes('HOST_CRASHED') })
      else if (timedOut) resolve({ kind: 'hang', code, signal })
      else resolve({ kind: 'crash', code, signal, tail: out.slice(-300) })
    })
  })
}

async function main() {
  if (process.argv.includes('--list')) {
    console.log(Object.keys(VARIANTS).join('\n'))
    return
  }
  const roundVariant = arg('round')
  const terminals = Number(arg('terminals', '12'))
  if (roundVariant) return runRound(roundVariant, terminals)

  const rounds = Number(arg('rounds', '100'))
  const names = arg('variants') ? arg('variants').split(',') : DEFAULT_VARIANTS
  const results = []
  for (const name of names) {
    if (!VARIANTS[name]) throw new Error(`variante desconocida: ${name}`)
    let ok = 0
    let crash = 0
    let hang = 0
    let hostCrashes = 0
    const codes = new Map()
    for (let r = 0; r < rounds; r++) {
      const res = await runChild(name, terminals, 60000)
      if (res.kind === 'ok') {
        ok++
        if (res.hostCrashed) hostCrashes++
      } else if (res.kind === 'hang') hang++
      else {
        crash++
        const k = `code=${res.code} signal=${res.signal}`
        codes.set(k, (codes.get(k) ?? 0) + 1)
      }
    }
    const row = {
      variant: name,
      rounds,
      terminals,
      ok,
      crash,
      hang,
      hostCrashes,
      crashRate: `${((crash / rounds) * 100).toFixed(1)}%`,
      codes: Object.fromEntries(codes),
    }
    results.push(row)
    console.error(
      `${name.padEnd(26)} ok=${ok} crash=${crash} hang=${hang} hostCrashes=${hostCrashes} (${row.crashRate}) ${JSON.stringify(row.codes)}`,
    )
  }
  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify({ node: process.version, platform: process.platform, results }, null, 2),
    )
  }
  const hostFailed = results.some(
    (r) => r.variant.startsWith('host-') && (r.crash > 0 || r.hang > 0),
  )
  process.exit(hostFailed ? 1 : 0)
}

await main()
